import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export interface Contract {
    name: string;
    contractName: string;
    address: string;
    mustSwitchToProduction?: boolean;
}

export interface ContractHistory {
    name: string;
    contractName: string;
    addresses: string[];
}

export interface FAssetContracts {
    // flare smart contract
    GovernanceSettings: Contract;
    AddressUpdater: Contract;
    WNat: Contract;
    Relay: Contract;
    FdcHub: Contract;
    FdcVerification?: Contract;
    // fasset
    FtsoV2PriceStore?: Contract;
    AgentVaultFactory?: Contract;
    CollateralPoolFactory?: Contract;
    CollateralPoolTokenFactory?: Contract;
    AssetManagerController?: Contract;
    PriceReader?: Contract;
    AgentOwnerRegistry?: Contract;
}

export type NewContractOptions = Omit<Contract, 'name' | 'contractName' | 'address'>;

export class ContractStore {
    protected readonly map: Map<string, Contract>;
    protected readonly history: Map<string, ContractHistory>;

    constructor(
        public readonly filename: string,
        public autosave: boolean,
        public readonly historyFilename: string = ContractStore.historyDefaultFilename(filename),
    ) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const list: Contract[] = existsSync(filename) ? JSON.parse(readFileSync(filename).toString()) : [];
        this.map = ContractStore.listToMap(list, filename);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const historyList: ContractHistory[] = existsSync(historyFilename) ? JSON.parse(readFileSync(historyFilename).toString()) : [];
        this.history = ContractStore.listToMap(historyList, historyFilename);
    }

    public static historyDefaultFilename(filename: string) {
        return join(dirname(filename), "history", basename(filename));
    }

    public static listToMap<T extends { name: string }>(list: T[], filename: string) {
        const map: Map<string, T> = new Map();
        for (const item of list) {
            if (map.has(item.name)) {
                throw new Error(`Duplicate constract "${item.name}" in ${filename}`);
            }
            map.set(item.name, item);
        }
        return map;
    }

    public get(name: string) {
        return this.map.get(name);
    }

    public getRequired(name: string) {
        const value = this.map.get(name);
        if (!value) throw new Error(`Missing contract ${name}`);
        return value;
    }

    public getAddress(addressOrName: string) {
        if (addressOrName.startsWith('0x')) return addressOrName;
        return this.getRequired(addressOrName).address;
    }

    public add(name: string, contractName: string, address: string, options?: NewContractOptions) {
        this.addContract({ name, contractName, address, ...(options ?? {}) });
    }

    public addContract(contract: Contract) {
        this.map.set(contract.name, contract);
        this.addHistoryItem(contract);
        if (this.autosave) {
            this.save();
        }
    }

    public findByAddress(address: string) {
        for (const contract of this.map.values()) {
            if (contract.address.toLowerCase() === address.toLowerCase()) {
                return contract;
            }
        }
    }

    public addHistoryItem({ name, contractName, address }: Contract) {
        let contractHistory = this.history.get(name);
        if (contractHistory == null) {
            contractHistory = { name, contractName, addresses: [] };
            this.history.set(name, contractHistory);
        }
        if (!contractHistory.addresses.includes(address)) {
            contractHistory.addresses.push(address);
        }
    }

    public list() {
        return Array.from(this.map.values());
    }

    public historyList() {
        return Array.from(this.history.values());
    }

    public save() {
        writeFileSync(this.filename, JSON.stringify(this.list(), null, 2));
        writeFileSync(this.historyFilename, JSON.stringify(this.historyList(), null, 2));
    }
}

export class FAssetContractStore extends ContractStore implements FAssetContracts {
    // flare smart contract
    get GovernanceSettings() { return this.getRequired('GovernanceSettings'); }
    get AddressUpdater() { return this.getRequired('AddressUpdater'); }
    get WNat() { return this.getRequired('WNat'); }
    get Relay() { return this.getRequired('Relay'); }
    get FdcHub() { return this.getRequired('FdcHub'); }
    get FdcVerification() { return this.get('FdcVerification'); }
    // fasset
    get FtsoV2PriceStore() { return this.get('FtsoV2PriceStore'); }
    get AgentVaultFactory() { return this.get('AgentVaultFactory'); }
    get CollateralPoolFactory() { return this.get('CollateralPoolFactory'); }
    get CollateralPoolTokenFactory() { return this.get('CollateralPoolTokenFactory'); }
    get AssetManagerController() { return this.get('AssetManagerController'); }
    get PriceReader() { return this.get('PriceReader'); }
    get AgentOwnerRegistry() { return this.get('AgentOwnerRegistry'); }
}

export function loadContractsList(filename: string): Contract[] {
    return JSON.parse(readFileSync(filename).toString()) as Contract[];
}

export function saveContractsList(filename: string, contractList: Contract[]) {
    writeFileSync(filename, JSON.stringify(contractList, null, 2));
}
