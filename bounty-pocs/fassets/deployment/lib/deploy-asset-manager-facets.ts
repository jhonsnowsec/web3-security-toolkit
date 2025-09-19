import { Artifact, HardhatRuntimeEnvironment } from 'hardhat/types';
import { DiamondCut, FacetCutAction } from '../../lib/utils/diamond';
import { ContractStore } from "./contracts";
import { deployedCodeMatches, waitFinalize } from './deploy-utils';

const assetManagerInterfaces: string[] = [
    'IIAssetManager'
];

export const assetManagerFacets = [
    'AssetManagerDiamondCutFacet',
    'DiamondLoupeFacet',
    'AgentInfoFacet',
    'AvailableAgentsFacet',
    'CollateralReservationsFacet',
    'MintingFacet',
    'MintingDefaultsFacet',
    'RedemptionRequestsFacet',
    'RedemptionConfirmationsFacet',
    'RedemptionDefaultsFacet',
    'LiquidationFacet',
    'ChallengesFacet',
    'UnderlyingBalanceFacet',
    'UnderlyingTimekeepingFacet',
    'AgentVaultManagementFacet',
    'AgentSettingsFacet',
    'CollateralTypesFacet',
    'AgentCollateralFacet',
    'SettingsReaderFacet',
    'SettingsManagementFacet',
    'AgentVaultAndPoolSupportFacet',
    'SystemStateManagementFacet',
    'SystemInfoFacet',
    'EmergencyPauseFacet',
    'EmergencyPauseTransfersFacet',
    'AgentPingFacet',
    'AgentAlwaysAllowedMintersFacet',
];

export const assetManagerFacetsDeployedByDiamondCut = [
    'RedemptionTimeExtensionFacet',
    'CoreVaultClientFacet',
    'CoreVaultClientSettingsFacet',
]

export async function deployAllAssetManagerFacets(hre: HardhatRuntimeEnvironment, contracts: ContractStore, deployer: string) {
    for (const facetName of assetManagerFacets) {
        await deployFacet(hre, facetName, contracts, deployer);
    }
}

// deploy facet unless it is already dpeloyed with identical code (facets must be stateless and have zero-arg constructor)
export async function deployFacet(hre: HardhatRuntimeEnvironment, facetName: string, contracts: ContractStore, deployer: string, facetArtifactName = facetName) {
    const artifact = hre.artifacts.readArtifactSync(facetArtifactName);
    const alreadyDeployed = await deployedCodeMatches(hre, artifact, contracts.get(facetName)?.address);
    if (!alreadyDeployed) {
        const contractFactory = hre.artifacts.require(facetArtifactName) as Truffle.Contract<Truffle.ContractInstance>;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        const instance: Truffle.ContractInstance = await waitFinalize(hre, deployer, () => contractFactory.new({ from: deployer }));
        contracts.add(facetName, `${facetArtifactName}.sol`, instance.address);
        console.log(facetArtifactName === facetName ? `Deployed facet ${facetName}` : `Deployed facet ${facetName} from ${facetArtifactName}.sol`);
        return instance.address;
    } else {
        return contracts.getRequired(facetName).address;
    }
}

export async function createDiamondCutsForAllAssetManagerFacets(hre: HardhatRuntimeEnvironment, contracts: ContractStore) {
    const interfaceSelectorMap = createInterfaceSelectorMap(hre, assetManagerInterfaces);
    const interfaceSelectors = new Set(interfaceSelectorMap.keys());
    const diamondCuts: DiamondCut[] = [];
    for (const facetName of assetManagerFacets) {
        const facetAddress = contracts.getRequired(facetName).address;
        const artifact = hre.artifacts.readArtifactSync(facetName);
        diamondCuts.push(await createDiamondCut(artifact, facetAddress, interfaceSelectors));
    }
    return diamondCuts;
}

export async function checkAllAssetManagerMethodsImplemented(hre: HardhatRuntimeEnvironment, contractAddress: string) {
    const artifacts = hre.artifacts as Truffle.Artifacts;
    const interfaceSelectors = createInterfaceSelectorMap(hre, assetManagerInterfaces);
    const interfaceSelectorSet = new Set(interfaceSelectors.keys());
    const loupe = await artifacts.require("IDiamondLoupe").at(contractAddress);
    const facets = await loupe.facets();
    for (const facet of facets) {
        for (const selector of facet.functionSelectors) {
            interfaceSelectorSet.delete(selector);
        }
    }
    if (interfaceSelectorSet.size > 0) {
        const missing = Array.from(interfaceSelectorSet).map(sel => interfaceSelectors.get(sel)?.name);
        throw new Error(`Deployed facets are missing methods ${missing.join(", ")}`);
    }
}

export async function createDiamondCut(artifact: Artifact, address: string, selectorFilter: Set<string>): Promise<DiamondCut> {
    const artifactAbi = artifact.abi as AbiItem[];
    const instanceSelectors = artifactAbi.map(it => web3.eth.abi.encodeFunctionSignature(it));
    const exposedSelectors = instanceSelectors.filter(sel => selectorFilter.has(sel));
    if (exposedSelectors.length === 0) {
        throw new Error(`No exposed methods in ${artifact.contractName}`);
    }
    return {
        action: FacetCutAction.Add,
        facetAddress: address,
        functionSelectors: [...exposedSelectors]
    };
}

export function createInterfaceSelectorMap(hre: HardhatRuntimeEnvironment, interfaces: string[]) {
    const interfaceAbis = interfaces.map(name => hre.artifacts.readArtifactSync(name).abi as AbiItem[]);
    return methodSelectorMap(...interfaceAbis);
}

export function methodSelectorMap(...abis: AbiItem[][]) {
    return new Map(abis.flat(1)
        .filter(it => it.type === 'function')
        .map(it => [web3.eth.abi.encodeFunctionSignature(it), it]));
}
