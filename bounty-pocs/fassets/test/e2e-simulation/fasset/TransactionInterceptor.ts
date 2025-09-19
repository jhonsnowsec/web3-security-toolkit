import { network } from "hardhat";
import { TransactionReceipt } from "web3-core";
import { Web3EventDecoder } from "../../../lib/test-utils/Web3EventDecoder";
import { EvmEvent } from "../../../lib/utils/events/common";
import { currentRealTime, Statistics, truffleResultAsJson } from "../../../lib/test-utils/simulation-utils";
import { AnyFunction, filterStackTrace, getOrCreate, reportError, sorted, sum, tryCatch } from "../../../lib/utils/helpers";
import { ILogger } from "../../../lib/utils/logging";
import { MultiStateLock } from "./MultiStateLock";

export type EventHandler = (event: EvmEvent) => void;

export class TransactionInterceptor {
    logger?: ILogger;
    eventHandlers: Map<string, EventHandler> = new Map();
    gasUsage: Map<string, Statistics> = new Map();
    errorCounts: Map<string, number> = new Map();
    eventCounts: Map<string, number> = new Map();
    unexpectedErrorCount: number = 0;

    log(text: string) {
        if (this.logger) {
            this.logger.log(text);
        }
    }

    logUnexpectedError(e: unknown, prefix = '    !!! UNEXPECTED') {
        reportError(e);
        const indent = prefix.match(/^\s*/)?.[0] ?? '';
        this.log(`${prefix} ${filterStackTrace(e).replace(/\n/g, '\n' + indent)}`);
        this.unexpectedErrorCount += 1;
    }

    comment(comment: string) {
        console.log(comment);
        this.log('****** ' + comment);
    }

    logGasUsage() {
        if (!this.logger) return;
        this.log('');
        this.log(`ERRORS: ${sum(this.errorCounts.values())}`);
        for (const [key, count] of this.errorCounts.entries()) {
            this.log(`${key}: ${count}`);
        }
        this.log('');
        this.log(`EVENTS: ${sum(this.eventCounts.values())}`);
        for (const [key, count] of sorted(this.eventCounts.entries(), e => e[0])) {
            this.log(`${key}: ${count}`);
        }
        this.log('');
        this.log('GAS USAGE');
        for (const [method, stats] of sorted(this.gasUsage.entries(), e => e[0])) {
            this.log(`${method}:   ${stats.toString(0)}`);
        }
    }

    increaseErrorCount(error: unknown) {
        let errorKey = String(error);
        const match = errorKey.match(/^.*:\s*reverted with reason string\s*'(.*)'\s*$/)
            || errorKey.match(/^.*:\s*revert\s*(.*)$/);
        if (match) errorKey = match[1].trim();
        this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) ?? 0) + 1);
    }

    increaseEventCount(event: EvmEvent) {
        this.eventCounts.set(event.event, (this.eventCounts.get(event.event) ?? 0) + 1);
    }

    collectEvents(handlerName: string = 'EventCollector') {
        return new EventCollector(this, handlerName);
    }
}

export class EventCollector {
    public events: EvmEvent[] = [];

    constructor(
        interceptor: TransactionInterceptor,
        handlerName: string = 'EventCollector',
    ) {
        interceptor.eventHandlers.set(handlerName, (event) => {
            this.events.push(event);
        });
    }

    popCollectedEvents() {
        const events = this.events;
        this.events = [];
        return events;
    }
}

export type MiningMode = 'auto' | 'manual';

export class TruffleTransactionInterceptor extends TransactionInterceptor {
    private handledPromises: Promise<void>[] = [];
    private startRealTime = currentRealTime();
    private contractTypeName: Map<string, string> = new Map();  // address => type name
    private addressToContract: Map<string, Truffle.ContractInstance> = new Map();

    private miningMode: MiningMode = 'auto';
    private usedNonces: Map<string, number> = new Map();

    // settings
    interceptViewMethods: boolean = false;
    lock?: MultiStateLock;

    constructor(
        private eventDecoder: Web3EventDecoder,
        private defaultAccount: string,
    ) {
        super();
    }

    getContract<T extends Truffle.ContractInstance>(address: string) {
        const contract = this.addressToContract.get(address);
        if (contract == null) throw new Error("Unknown contract address");
        return contract as T;
    }

    captureEvents(contracts: { [name: string]: Truffle.ContractInstance; }, filter?: string[]) {
        this.eventDecoder.addContracts(contracts, filter);
        for (const [name, contract] of Object.entries(contracts)) {
            this.instrumentContractForEventCapture(contract);
            this.contractTypeName.set(contract.address, name);
            this.addressToContract.set(contract.address, contract);
        }
    }

    captureEventsFrom(contractName: string, contract: Truffle.ContractInstance, typeName?: string | null, filter?: string[]) {
        this.captureEvents({ [contractName]: contract }, filter);
        if (typeName) {
            this.contractTypeName.set(contract.address, typeName);
        }
    }

    async setMiningMode(miningMode: MiningMode, interval: number = 0) {
        this.miningMode = miningMode;
        if (miningMode === 'manual') {
            await network.provider.send('evm_setAutomine', [false]);
            await network.provider.send("evm_setIntervalMining", [interval]);
        } else {
            await network.provider.send("evm_setIntervalMining", [0]);
            await network.provider.send('evm_setAutomine', [true]);
        }
    }

    async mine() {
        if (this.miningMode !== 'auto') {
            await network.provider.send('evm_mine');
        }
    }

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
    private instrumentContractForEventCapture(contract: Truffle.ContractInstance) {
        //const abiDict = this.buildAbiDict(contract);
        const sendTransactionAbi: AbiItem = { type: 'function', name: 'sendTransaction', stateMutability: 'payable', inputs: [], outputs: [] };
        const abiItems: AbiItem[] = [sendTransactionAbi, ...contract.abi];
        const contractObject = contract as any;
        for (const item of abiItems) {
            const name = item.name;
            if (!name) continue;   // constructor or fallback/receive function
            // view/pure function?
            if (!this.interceptViewMethods && item.constant) continue;
            if (item.type === 'event') continue;
            // check method
            const method = contractObject[name];
            if (method == null) {
                this.log(`INTERCEPT: missing method ${name} in contract ${this.eventDecoder.formatAddress(contract.address)}`);
                continue;
            }
            if (typeof method !== 'function') {
                this.log(`INTERCEPT: item ${name} in contract ${this.eventDecoder.formatAddress(contract.address)} is not a method`);
                continue;
            }
            const subkeys = tryCatch(() => Object.keys(method)) ?? [];
            const validMethod = (subkeys.includes('call') && subkeys.includes('sendTransaction') && subkeys.includes('estimateGas')) || (item.name === 'sendTransaction');
            if (!validMethod) {
                this.log(`INTERCEPT: invalid method ${name} in contract ${this.eventDecoder.formatAddress(contract.address)}`);
                continue;
            }
            // instrument call
            // const boundMethod = method.bind(contractObject);
            contractObject[name] = (...args: unknown[]) => this.callMethod(contract, name, method, args, item);
            // copy subkeys from method (call, sendTransaction, estimateGas)
            for (const key of subkeys) {
                contractObject[name][key] = (method)[key];
            }
        }
    }
    /* eslint-enable */

    private callMethod(contract: Truffle.ContractInstance, name: string, originalMethod: AnyFunction, args: unknown[], methodAbi: AbiItem) {
        const txLog: string[] = [];
        const callStartTime = currentRealTime();
        // log method call
        const fmtArgs = args.map(arg => this.eventDecoder.formatArg(arg)).join(', ');
        txLog.push(`${this.eventDecoder.formatAddress(contract.address)}.${name}(${fmtArgs})   [AT(rt)=${(callStartTime - this.startRealTime).toFixed(3)}]`);
        // call method, fixing it for manual mining mode
        const promise = this.miningMode === 'auto' || methodAbi.constant
            ? this.directCall(originalMethod, args, methodAbi, txLog)
            : this.instrumentedCall(originalMethod, args, methodAbi);
        // handle success/failure
        const decodePromise = promise
            .then((result: Truffle.TransactionResponse<Truffle.AnyEvent> | TransactionReceipt | null) => {
                const receipt = this.getTransactionReceipt(result);
                if (receipt != null) {
                    this.handleMethodSuccess(contract, name, txLog, callStartTime, receipt);
                } else {
                    this.handleViewMethodSuccess(contract, name, txLog, callStartTime, result);
                }
            })
            .catch((e: unknown) => {
                txLog.push(`    !!! ${e}`);
                this.increaseErrorCount(e);
            })
            .finally(() => {
                if (this.logger != null) {
                    this.log(txLog.join('\n'));
                }
            });
        this.handledPromises.push(decodePromise);
        // and return the same promise, to be used as without interceptor
        return promise;
    }

    private async directCall(originalMethod: AnyFunction, args: unknown[], methodAbi: AbiItem, txLog: string[]) {
        if (this.lock && !methodAbi.constant) {
            await this.lock.acquire("execute");
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return await originalMethod(...args);
        } finally {
            if (this.lock && !methodAbi.constant) {
                this.lock?.release("execute");
            }
        }
    }

    private async instrumentedCall(originalMethod: AnyFunction<unknown>, args: unknown[], methodAbi: AbiItem) {
        const inputLen = methodAbi.inputs?.length ?? 0;
        const options = (args[inputLen] ?? {}) as Truffle.TransactionDetails;
        const from = options.from ?? this.defaultAccount;
        const fixedOptions: Truffle.TransactionDetails = { ...options, gas: 5000000 }; // gas estimation doesn't work reliably with parallel requests
        const fixedArgs = [...args.slice(0, inputLen), fixedOptions];
        await this.lock?.acquire("execute");
        try {
            await this.waitNewNonce(from);
            return await originalMethod(...fixedArgs);
        } catch (e) {
            if ((e as Error).constructor?.name === 'StatusError') {
                // using static call should throw correct exception
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                await (originalMethod as any).call(...fixedArgs);
            }
            throw e; // rethrow e if it was acceptable error or if method.call didn't throw
        } finally {
            this.lock?.release("execute");
        }
    }

    private async waitNewNonce(address: string) {
        const startTm = currentRealTime();
        while (true) {
            const nonce = await web3.eth.getTransactionCount(address, 'pending');
            if ((this.usedNonces.get(address) ?? -1) < nonce) {
                this.usedNonces.set(address, nonce)
                return [nonce, currentRealTime() - startTm];
            }
        }
    }

    private getTransactionReceipt(result: Truffle.TransactionResponse<Truffle.AnyEvent> | TransactionReceipt | null): TransactionReceipt | null {
        // (approximately) detect if the returned result is either TransactionResponse or TransactionReceipt and in this case extract receipt
        if (result == null) {
            return null;
        } else if ('tx' in result && typeof result.tx === 'string' && result.receipt != null && Array.isArray(result.logs)) {
            return result.receipt as TransactionReceipt; // result is TransactionResponse
        } else if ('status' in result && typeof result.status === 'boolean' && typeof result.transactionHash === 'string' && Array.isArray(result.logs)) {
            return result; // result is TransactionReceipt
        }
        return null;
    }

    private handleMethodSuccess(contract: Truffle.ContractInstance, method: string, txLog: string[], callStartTime: number, receipt: TransactionReceipt) {
        try {
            const callEndTime = currentRealTime();
            // gas info
            const qualifiedMethod = `${this.contractTypeName.get(contract.address) ?? contract.address}.${method}`;
            getOrCreate(this.gasUsage, qualifiedMethod, () => new Statistics()).add(receipt.gasUsed);
            // read events
            const events = this.eventDecoder.decodeEvents(receipt);
            // print events
            if (this.logger != null) {
                txLog.push(`    GAS: ${receipt.gasUsed},  BLOCK: ${receipt.blockNumber},  DURATION(rt): ${(callEndTime - callStartTime).toFixed(3)}`);
                for (const event of events) {
                    txLog.push(`    ${this.eventDecoder.format(event)}`);
                    this.increaseEventCount(event);
                }
            }
            // call handlers
            for (const event of events) {
                for (const handler of this.eventHandlers.values()) {
                    try {
                        handler(event);
                    } catch (error) {
                        txLog.push(`???? ERROR handling event ${event.event} in ${method}: ${error}`);
                    }
                }
            }
        } catch (e) {
            txLog.push(`???? ERROR decoding/handling method call ${method}: ${e}`);
        }
    }

    private handleViewMethodSuccess(contract: Truffle.ContractInstance, method: string, txLog: string[], callStartTime: number, result: unknown) {
        try {
            const callEndTime = currentRealTime();
            if (this.logger != null) {
                txLog.push(`    DURATION(rt): ${(callEndTime - callStartTime).toFixed(3)}`);
                txLog.push(`    RESULT: ${truffleResultAsJson(result)}`);
            }
        } catch (e) {
            txLog.push(`???? ERROR decoding/handling view method call ${method}: ${e}`);
        }
    }

    async allHandled() {
        await Promise.all(this.handledPromises);
        this.handledPromises = [];
    }
}
