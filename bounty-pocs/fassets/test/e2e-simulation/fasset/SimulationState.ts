import { IAssetContext } from "../../../lib/fasset/IAssetContext";
import { InitialAgentData } from "../../../lib/state/TrackedAgentState";
import { TrackedState } from "../../../lib/state/TrackedState";
import { UnderlyingChainEvents } from "../../../lib/underlying-chain/UnderlyingChainEvents";
import { EventFormatter } from "../../../lib/utils/events/EventFormatter";
import { IEvmEvents } from "../../../lib/utils/events/IEvmEvents";
import { EventExecutionQueue } from "../../../lib/utils/events/ScopedEvents";
import { EvmEvent } from "../../../lib/utils/events/common";
import { sumBN, toBN, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { LogFile } from "../../../lib/utils/logging";
import { SparseArray } from "../../../lib/test-utils/SparseMatrix";
import { SimulationAgentState } from "./SimulationAgentState";
import { SimulationStateComparator } from "./SimulationStateComparator";

export type SimulationStateLogRecord = {
    text: string;
    event: EvmEvent | string;
};

export class SimulationState extends TrackedState {
    constructor(
        context: IAssetContext,
        truffleEvents: IEvmEvents,
        chainEvents: UnderlyingChainEvents,
        eventFormatter: EventFormatter,
        eventQueue: EventExecutionQueue,
    ) {
        super(context, truffleEvents, chainEvents, eventFormatter, eventQueue);
    }

    // state
    fAssetBalance = new SparseArray();

    // override agent state type (initialized in AssetState)
    override agents!: Map<string, SimulationAgentState>;
    override agentsByUnderlying!: Map<string, SimulationAgentState>;
    override agentsByPool!: Map<string, SimulationAgentState>;

    // logs
    failedExpectations: SimulationStateLogRecord[] = [];

    override registerHandlers() {
        super.registerHandlers();
        // track fAsset balances (Transfer for mint/burn is seen as transfer from/to address(0))
        this.truffleEvents.event(this.context.fAsset, 'Transfer').immediate().subscribe(args => {
            if (args.from !== ZERO_ADDRESS) {
                this.fAssetBalance.addTo(args.from, args.value.neg());
                this.agentsByPool.get(args.from)?.handlePoolFeeWithdrawal(args.to, toBN(args.value));
            }
            if (args.to !== ZERO_ADDRESS) {
                this.fAssetBalance.addTo(args.to, args.value);
                this.agentsByPool.get(args.to)?.handlePoolFeeDeposit(args.from, toBN(args.value));
            }
        });
        // track underlying transactions
        this.chainEvents.transactionEvent().immediate().subscribe(transaction => {
            for (const [address, amount] of transaction.inputs) {
                this.agentsByUnderlying.get(address)?.handleTransactionFromUnderlying(transaction);
            }
            for (const [address, amount] of transaction.outputs) {
                this.agentsByUnderlying.get(address)?.handleTransactionToUnderlying(transaction);
            }
        });
    }

    // override with correct state
    override getAgent(address: string): SimulationAgentState | undefined {
        return this.agents.get(address);
    }

    protected override newAgent(data: InitialAgentData) {
        return new SimulationAgentState(this, data);
    }

    totalChecks = 0;
    problemChecks = 0;
    totalProblems = 0;

    async checkInvariants(failOnProblems: boolean) {
        const checker = new SimulationStateComparator();
        // total supply
        const fAssetSupply = await this.context.fAsset.totalSupply();
        checker.checkEquality('fAsset supply', fAssetSupply, this.totalFAssetSupply(), { logOn: 'always' });
        // total balances
        const totalBalances = this.fAssetBalance.total();
        checker.checkEquality('fAsset supply / total balances', fAssetSupply, totalBalances);
        // total minted value by all agents
        const totalMintedUBA = sumBN(this.agents.values(), agent => agent.calculateMintedUBA());
        const totalMintedPlusCV = totalMintedUBA.add(this.coreVault.backedFAssetSupply());
        checker.checkEquality('fAsset supply / total minted by agents plus core vault', fAssetSupply, totalMintedPlusCV, { logOn: 'always' });
        // settings
        const actualSettings = await this.context.assetManager.getSettings();
        for (const [key, value] of Object.entries(actualSettings)) {
            if (/^\d+$/.test(key)) continue;   // all properties are both named and with index
            if (['assetManagerController'].includes(key)) continue;   // special properties, not changed in normal way
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
            checker.checkEquality(`settings.${key}`, value, (this.settings as any)[key]);
        }
        // check agents' state
        for (const agent of this.agents.values()) {
            await agent.checkInvariants(checker);
        }
        // write logs (after all async calls, to keep them in one piece)
        checker.writeLog(this.logger);
        // optionally fail on differences
        if (failOnProblems && checker.problems > 0) {
            assert.fail("Tracked and actual state different");
        }
        // update counts
        this.totalChecks += 1;
        this.problemChecks += checker.problems > 0 ? 1 : 0;
        this.totalProblems += checker.problems;
    }

    // logs

    override expect(condition: boolean, message: string, event: EvmEvent) {
        if (!condition) {
            const text = `expectation failed: ${message}`;
            this.failedExpectations.push({ text, event });
        }
    }

    logExpectationFailures() {
        if (!this.logger) return;
        this.logger.log(`\nEXPECTATION FAILURES: ${this.failedExpectations.length}`);
        for (const log of this.failedExpectations) {
            this.logger.log(`        ${log.text}  ${typeof log.event === 'string' ? log.event : this.eventInfo(log.event)}`);
        }
    }

    logAllAgentActions() {
        if (!this.logger) return;
        this.logger.log("\nAGENT ACTIONS");
        for (const agent of this.agents.values()) {
            agent.writeActionLog(this.logger);
        }
    }

    logAllPoolSummaries() {
        if (!this.logger) return;
        this.logger.log("\nCollateral Pool SUMMARIES");
        for (const agent of this.agents.values()) {
            agent.writePoolSummary(this.logger);
        }
    }

    logProblemTotals() {
        this.logger?.log(`\nTOTAL CHECKS: ${this.totalChecks}  PROBLEM CHECKS: ${this.problemChecks}  TOTAL PROBLEMS: ${this.totalProblems}`);
        console.log(`\nTOTAL CHECKS: ${this.totalChecks}  PROBLEM CHECKS: ${this.problemChecks}  TOTAL PROBLEMS: ${this.totalProblems}`);
    }

    writeBalanceTrackingList(dir: string) {
        for (const agent of this.agents.values()) {
            try {
                agent.writeBalanceTrackingList(dir);
            } catch (e) {
                console.error(e);
            }
        }
    }

    withLogFile(path: string, action: () => void) {
        const curLogger = this.logger;
        this.logger = new LogFile(path);
        try {
            action();
        } finally {
            (this.logger as LogFile).close();
            this.logger = curLogger;
        }
    }
}
