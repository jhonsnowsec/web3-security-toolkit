import hre from "hardhat";
import { requiredEventArgs } from "../../lib/utils/events/truffle";
import { getTestFile, itSkipIf } from "../../lib/test-utils/test-suite-helpers";
import { createTestAgent } from "../../lib/test-utils/test-settings";
import { AgentOwnerRegistryInstance, IAssetManagerControllerInstance } from "../../typechain-truffle";
import { FAssetContractStore } from "../lib/contracts";
import { loadDeployAccounts, networkConfigName, requiredEnvironmentVariable } from "../lib/deploy-utils";
import { SourceId } from "../../lib/underlying-chain/SourceId";
import { AttestationHelper } from "../../lib/underlying-chain/AttestationHelper";
import { MockFlareDataConnectorClient } from "../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { MockChain } from "../../lib/test-utils/fasset/MockChain";
import { latestBlockTimestamp, toBN, toBNExp } from "../../lib/utils/helpers";

const IAssetManagerController = artifacts.require('IAssetManagerController');
const IIAssetManager = artifacts.require('IIAssetManager');
const AgentOwnerRegistry = artifacts.require('AgentOwnerRegistry');

contract(`test-deployed-contracts; ${getTestFile(__filename)}; Deploy tests`, accounts => {
    const networkConfig = networkConfigName(hre);

    let contracts: FAssetContractStore;

    let assetManagerController: IAssetManagerControllerInstance;
    let agentOwnerRegistry: AgentOwnerRegistryInstance;

    before(async () => {
        contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, false);
        assetManagerController = await IAssetManagerController.at(contracts.AssetManagerController!.address);
        agentOwnerRegistry = await AgentOwnerRegistry.at(contracts.AgentOwnerRegistry!.address);
    });

    // it("Controller must be in production mode", async () => {
    //     const production = await assetManagerController.productionMode();
    //     assert.isTrue(production, "not in production mode");
    // });

    it("Controller has at least one manager", async () => {
        const managers = await assetManagerController.getAssetManagers();
        assert.isAbove(managers.length, 0);
    });

    it("All managers must be attached to this controller", async () => {
        const managers = await assetManagerController.getAssetManagers();
        for (const mgrAddress of managers) {
            const assetManager = await IIAssetManager.at(mgrAddress);
            // must be attached...
            const attached = await assetManager.controllerAttached();
            assert.isTrue(attached, "not attached");
            // ...to this controller
            const mgrController = await assetManager.assetManagerController();
            assert.equal(mgrController, assetManagerController.address);
        }
    });

    it("Additional settings are set", async () => {
        const managers = await assetManagerController.getAssetManagers();
        for (const mgrAddress of managers) {
            const assetManager = await IIAssetManager.at(mgrAddress);
            // check redemptionPaymentExtensionSeconds
            const redemptionPaymentExtensionSeconds = await assetManager.redemptionPaymentExtensionSeconds();
            assert.equal(Number(redemptionPaymentExtensionSeconds), 30);
        }
    });

    const testUnderlyingAddresses = {
        [SourceId.XRP]: 'r9N9XrsUKFJgaAwoL3qtefdjXVxjgxUqWi',
        [SourceId.testXRP]: 'r9N9XrsUKFJgaAwoL3qtefdjXVxjgxUqWi',
        [SourceId.BTC]: 'mhvLner76vL99PfYFmdzDFqGGqwQyE61xQ',
        [SourceId.testBTC]: 'mhvLner76vL99PfYFmdzDFqGGqwQyE61xQ',
        [SourceId.DOGE]: 'mr8zwdWkSrxQRrhq7D2i4f4CLZoZgF3nja',
        [SourceId.testDOGE]: 'mr8zwdWkSrxQRrhq7D2i4f4CLZoZgF3nja',
        [SourceId.LTC]: 'mjGn3j6vrHwgRzRWsXFT6dP1K5atca7yPx',
    };

    const testPrices: Record<string, [string, number, number]> = {
        'CFLR': ['FtsoNat', 5, 0.20],
        'testUSDC': ['FtsoUSDC', 5, 1.01],
        'testUSDT': ['FtsoUSDT', 5, 0.99],
        'testETH': ['FtsoETH', 3, 3000],
        'testBTC': ['FtsoBtc', 2, 20_000],
        'testDOGE': ['FtsoDoge', 5, 0.05],
        'testXRP': ['FtsoXrp', 5, 0.50],
        'SGB': ['FtsoNat', 5, 0.20],
        'USDX': ['FtsoUSDT', 5, 0.99],
        'XRP': ['FtsoXrp', 5, 0.50],
        'BTC': ['FtsoBtc', 2, 20_000],
        'DOGE': ['FtsoDoge', 5, 0.05],
    };

    itSkipIf(networkConfig !== 'hardhat')("Can create an agent on all managers", async () => {
        const { deployer } = loadDeployAccounts(hre);
        const managers = await assetManagerController.getAssetManagers();
        const owner = requiredEnvironmentVariable('TEST_AGENT_OWNER');
        await agentOwnerRegistry.whitelistAndDescribeAgent(owner, "TestAgent", "Agent in deploy test", "", "", { from: deployer });
        // create Flare data connector client (only really needed for address validation)
        const relay = await artifacts.require('RelayMock').at(contracts.Relay.address);
        const fdcHub = await artifacts.require('FdcHubMock').at(contracts.FdcHub.address);
        const priceStore = await artifacts.require('FtsoV2PriceStoreMock').at(contracts.FtsoV2PriceStore!.address);
        for (const symbol of await priceStore.getSymbols()) {
            const [_, decimals, price] = testPrices[symbol];
            await priceStore.setCurrentPrice(symbol, toBNExp(price, decimals), 0);
            await priceStore.setCurrentPriceFromTrustedProviders(symbol, toBNExp(price, decimals), 0);
        }
        const chainIds = Object.keys(testUnderlyingAddresses);
        const currentTime = toBN(await latestBlockTimestamp());
        const chains = Object.fromEntries(chainIds.map(id => [id, new MockChain(currentTime)]));
        const flareDataConnectorClient = new MockFlareDataConnectorClient(fdcHub, relay, chains, 'auto');
        for (const mgrAddress of managers) {
            console.log("Testing manager at", mgrAddress);
            const assetManager = await IIAssetManager.at(mgrAddress);
            const settings = await assetManager.getSettings();
            const collaterals = await assetManager.getCollateralTypes();
            // create fake attestation provider
            const attestationProvider = new AttestationHelper(flareDataConnectorClient, chains[settings.chainId], settings.chainId);
            // create agent
            const underlyingAddress = testUnderlyingAddresses[settings.chainId];    // address doesn't matter - won't do anything on underlying chain
            const agentVault = await createTestAgent({ assetManager, settings, attestationProvider }, owner, underlyingAddress, collaterals[1].token, { poolTokenSuffix: `SUFF${currentTime}` });
            // announce destroy (can really destroy later)
            const destroyRes = await assetManager.announceDestroyAgent(agentVault.address, { from: owner });
            const destroyArgs = requiredEventArgs(destroyRes, "AgentDestroyAnnounced");
            console.log(`    you can destroy agent ${agentVault.address} on asset manager ${mgrAddress} after timestamp ${destroyArgs.destroyAllowedAt}`);
        }
        await agentOwnerRegistry.revokeAddress(owner, { from: deployer });
    });

});
