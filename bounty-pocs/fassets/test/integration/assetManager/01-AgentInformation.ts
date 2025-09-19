import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { expectRevert } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { toBNExp, toWei } from "../../../lib/utils/helpers";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const minterAddress1 = accounts[30];
    const minterAddress2 = accounts[31];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";

    let commonContext: CommonContext;
    let context: AssetContext;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.btc);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
    });

    describe("simple scenarios - get information about agent(s)", () => {
        it("create agent", async () => {
            await Agent.createTest(context, agentOwner1, underlyingAgent1);
        });

        it("get agent info", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1, { feeBIPS: 0, mintingVaultCollateralRatioBIPS: 1_7500 });
            // before making agent public available
            await agent.checkAgentInfo({
                totalVaultCollateralWei: 0,
                totalPoolCollateralNATWei: 0,
                totalAgentPoolTokensWei: 0,
                publiclyAvailable: false,
                dustUBA: 0,
                liquidationStartTimestamp: 0,
                feeBIPS: 0,
                announcedUnderlyingWithdrawalId: 0,
                mintingVaultCollateralRatioBIPS: 1_7500,
            });
            // make agent available
            await agent.changeSettings({ feeBIPS: 500, mintingVaultCollateralRatioBIPS: 1_8000, mintingPoolCollateralRatioBIPS: 2_8000 });
            const fullVaultCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullVaultCollateral,
                totalPoolCollateralNATWei: fullPoolCollateral,
                totalAgentPoolTokensWei: fullPoolCollateral,
                publiclyAvailable: true,
                dustUBA: 0,
                liquidationStartTimestamp: 0,
                feeBIPS: 500,
                announcedUnderlyingWithdrawalId: 0,
                mintingVaultCollateralRatioBIPS: 1_8000,
                mintingPoolCollateralRatioBIPS: 2_8000,
            });
            // make agent unavailable
            await agent.exitAvailable();
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullVaultCollateral,
                totalPoolCollateralNATWei: fullPoolCollateral,
                totalAgentPoolTokensWei: fullPoolCollateral,
                publiclyAvailable: false,
                dustUBA: 0,
                liquidationStartTimestamp: 0,
                feeBIPS: 500,
                announcedUnderlyingWithdrawalId: 0,
                mintingVaultCollateralRatioBIPS: 1_8000,
                mintingPoolCollateralRatioBIPS: 2_8000,
            });
        });

        it("get available agents", async () => {
            const agent1 = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const availableAgents1 = await context.assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgents1[0].length, 0);
            assertWeb3Equal(availableAgents1[1], 0);
            const fullVaultCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent1.changeSettings({ feeBIPS: 500, mintingVaultCollateralRatioBIPS: 1_8000, mintingPoolCollateralRatioBIPS: 2_8000 });
            await agent1.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            const availableAgents2 = await context.assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgents2[0].length, 1);
            assert.equal(availableAgents2[0][0], agent1.agentVault.address);
            assertWeb3Equal(availableAgents2[1], 1);
            await agent2.changeSettings({ feeBIPS: 600, mintingVaultCollateralRatioBIPS: 1_9000, mintingPoolCollateralRatioBIPS: 2_9000 });
            await agent2.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            const availableAgents3 = await context.assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgents3[0].length, 2);
            assert.equal(availableAgents3[0][0], agent1.agentVault.address);
            assert.equal(availableAgents3[0][1], agent2.agentVault.address);
            assertWeb3Equal(availableAgents3[1], 2);
            const availableAgents4 = await context.assetManager.getAvailableAgentsList(0, 1);
            assert.equal(availableAgents4[0].length, 1);
            assert.equal(availableAgents4[0][0], agent1.agentVault.address);
            assertWeb3Equal(availableAgents4[1], 2);
            await agent1.exitAvailable();
            const availableAgents5 = await context.assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgents5[0].length, 1);
            assert.equal(availableAgents5[0][0], agent2.agentVault.address);
            assertWeb3Equal(availableAgents5[1], 1);
            await agent1.changeSettings({ feeBIPS: 800, mintingVaultCollateralRatioBIPS: 1_5000, mintingPoolCollateralRatioBIPS: 2_5000 });
            await agent1.makeAvailable();
            const availableAgents6 = await context.assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgents6[0].length, 2);
            assert.equal(availableAgents6[0][0], agent2.agentVault.address);
            assert.equal(availableAgents6[0][1], agent1.agentVault.address);
            assertWeb3Equal(availableAgents6[1], 2);
        });

        it("get available agents details", async () => {
            const agent1 = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const availableAgents1 = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgents1[0].length, 0);
            assertWeb3Equal(availableAgents1[1], 0);
            const fullVaultCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent1.changeSettings({ feeBIPS: 500, mintingVaultCollateralRatioBIPS: 1_8000, mintingPoolCollateralRatioBIPS: 2_8000 });
            await agent1.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            const availableAgents2 = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgents2[0].length, 1);
            assert.equal(availableAgents2[0][0].agentVault, agent1.agentVault.address);
            assert.equal(availableAgents2[0][0].ownerManagementAddress, agent1.ownerManagementAddress);
            assertWeb3Equal(availableAgents2[0][0].feeBIPS, 500);
            assertWeb3Equal(availableAgents2[0][0].mintingVaultCollateralRatioBIPS, 1_8000);
            assertWeb3Equal(availableAgents2[0][0].mintingPoolCollateralRatioBIPS, 2_8000);
            assertWeb3Equal(availableAgents2[0][0].freeCollateralLots, (await agent1.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents2[0][0].status, AgentStatus.NORMAL);
            assertWeb3Equal(availableAgents2[1], 1);
            await agent2.changeSettings({ feeBIPS: 600, mintingVaultCollateralRatioBIPS: 1_9000, mintingPoolCollateralRatioBIPS: 2_9000 });
            await agent2.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            const availableAgents3 = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgents3[0].length, 2);
            assert.equal(availableAgents3[0][0].agentVault, agent1.agentVault.address);
            assert.equal(availableAgents3[0][0].ownerManagementAddress, agent1.ownerManagementAddress);
            assertWeb3Equal(availableAgents3[0][0].feeBIPS, 500);
            assertWeb3Equal(availableAgents3[0][0].mintingVaultCollateralRatioBIPS, 1_8000);
            assertWeb3Equal(availableAgents3[0][0].mintingPoolCollateralRatioBIPS, 2_8000);
            assertWeb3Equal(availableAgents3[0][0].freeCollateralLots, (await agent1.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents3[0][0].status, AgentStatus.NORMAL);
            assert.equal(availableAgents3[0][1].agentVault, agent2.agentVault.address);
            assert.equal(availableAgents3[0][1].ownerManagementAddress, agent2.ownerManagementAddress);
            assertWeb3Equal(availableAgents3[0][1].feeBIPS, 600);
            assertWeb3Equal(availableAgents3[0][1].mintingVaultCollateralRatioBIPS, 1_9000);
            assertWeb3Equal(availableAgents3[0][1].mintingPoolCollateralRatioBIPS, 2_9000);
            assertWeb3Equal(availableAgents3[0][1].freeCollateralLots, (await agent2.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents3[0][1].status, AgentStatus.NORMAL);
            assertWeb3Equal(availableAgents3[1], 2);
            const availableAgents4 = await context.assetManager.getAvailableAgentsDetailedList(0, 1);
            assert.equal(availableAgents4[0].length, 1);
            assert.equal(availableAgents4[0][0].agentVault, agent1.agentVault.address);
            assertWeb3Equal(availableAgents4[0][0].feeBIPS, 500);
            assertWeb3Equal(availableAgents4[0][0].mintingVaultCollateralRatioBIPS, 1_8000);
            assertWeb3Equal(availableAgents4[0][0].mintingPoolCollateralRatioBIPS, 2_8000);
            assertWeb3Equal(availableAgents4[0][0].freeCollateralLots, (await agent1.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents4[0][0].status, AgentStatus.NORMAL);
            assertWeb3Equal(availableAgents4[1], 2);
            await agent1.exitAvailable();
            const availableAgents5 = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgents5[0].length, 1);
            assert.equal(availableAgents5[0][0].agentVault, agent2.agentVault.address);
            assertWeb3Equal(availableAgents5[0][0].feeBIPS, 600);
            assertWeb3Equal(availableAgents5[0][0].mintingVaultCollateralRatioBIPS, 1_9000);
            assertWeb3Equal(availableAgents5[0][0].mintingPoolCollateralRatioBIPS, 2_9000);
            assertWeb3Equal(availableAgents5[0][0].freeCollateralLots, (await agent2.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents5[0][0].status, AgentStatus.NORMAL);
            assertWeb3Equal(availableAgents5[1], 1);
            await agent1.changeSettings({ feeBIPS: 800, mintingVaultCollateralRatioBIPS: 1_5000, mintingPoolCollateralRatioBIPS: 2_5000 });
            await agent1.makeAvailable();
            const availableAgents6 = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgents6[0].length, 2);
            assert.equal(availableAgents6[0][0].agentVault, agent2.agentVault.address);
            assertWeb3Equal(availableAgents6[0][0].feeBIPS, 600);
            assertWeb3Equal(availableAgents6[0][0].mintingVaultCollateralRatioBIPS, 1_9000);
            assertWeb3Equal(availableAgents6[0][0].mintingPoolCollateralRatioBIPS, 2_9000);
            assertWeb3Equal(availableAgents6[0][0].freeCollateralLots, (await agent2.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents6[0][0].status, AgentStatus.NORMAL);
            assert.equal(availableAgents6[0][1].agentVault, agent1.agentVault.address);
            assertWeb3Equal(availableAgents6[0][1].feeBIPS, 800);
            assertWeb3Equal(availableAgents6[0][1].mintingVaultCollateralRatioBIPS, 1_5000);
            assertWeb3Equal(availableAgents6[0][1].mintingPoolCollateralRatioBIPS, 2_5000);
            assertWeb3Equal(availableAgents6[0][1].freeCollateralLots, (await agent1.getAgentCollateral()).freeCollateralLots());
            assertWeb3Equal(availableAgents6[0][1].status, AgentStatus.NORMAL);
            assertWeb3Equal(availableAgents6[1], 2);
        });

        it("should survive ftsov2 decimal number changes", async () => {
            const fullVaultCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralsAndMakeAvailable(fullVaultCollateral, fullPoolCollateral);
            // mint
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, toBNExp(5000, 8));
            await minter.performMinting(agent.vaultAddress, 1600);
            // console.log(deepFormat(await agent.getAgentInfo()));
            const { vaultCollateralRatioBIPS, poolCollateralRatioBIPS } = await agent.checkAgentInfo({ status: 0 }, "reset");
            //
            // switch btc decimals
            const { 0: btcprice, 2: btcdecimals } = await context.priceStore.getPrice(context.chainInfo.symbol);
            // console.log(`price=${price} decimals=${decimals}`);
            const newBTCdecimals = 2;
            const newBTCprice = btcprice.divn(10 ** (Number(btcdecimals) - newBTCdecimals));
            await context.priceStore.setDecimals(context.chainInfo.symbol, newBTCdecimals);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, newBTCprice, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, newBTCprice, 0);
            // const { 0: price1, 2: decimals1 } = await context.priceStore.getPrice(context.chainInfo.symbol);
            // console.log(`price1=${price1} decimals1=${decimals1}`);
            // collateral ratios should stay the same
            await agent.checkAgentInfo({ status: 0, vaultCollateralRatioBIPS, poolCollateralRatioBIPS }, "reset");
            // agent should not go to liquidation
            await expectRevert.custom(context.assetManager.startLiquidation(agent.vaultAddress), "LiquidationNotStarted", []);
            await agent.checkAgentInfo({ status: 0 }, "reset");
            //
            // same if we change NAT decimals
            const { 0: natprice, 2: natdecimals } = await context.priceStore.getPrice("NAT");
            const newNATdecimals = 7;
            const newNATprice = natprice.muln(10 ** (newNATdecimals - Number(natdecimals)));
            await context.priceStore.setDecimals("NAT", newNATdecimals);
            await context.priceStore.setCurrentPrice("NAT", newNATprice, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", newNATprice, 0);
            // collateral ratios should stay the same
            await agent.checkAgentInfo({ status: 0, vaultCollateralRatioBIPS, poolCollateralRatioBIPS }, "reset");
            // agent should not go to liquidation
            await expectRevert.custom(context.assetManager.startLiquidation(agent.vaultAddress), "LiquidationNotStarted", []);
            await agent.checkAgentInfo({ status: 0 }, "reset");
        });
    });
});
