import { CollateralReservationStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { BN_ZERO, DAYS, MAX_BIPS, toBN, toWei } from "../../../lib/utils/helpers";

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
    let mockChain: MockChain;
    let mockFlareDataConnectorClient: MockFlareDataConnectorClient;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
        mockFlareDataConnectorClient = context.flareDataConnectorClient as MockFlareDataConnectorClient;
    });

    describe("simple scenarios - minting failures", () => {
        it("mint defaults - no underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine a block to skip the agent creation time
            mockChain.mine();
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // test rewarding for mint default
            const startBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const startBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const startTotalCollateralPool = await agent.collateralPool.totalCollateral();
            await agent.mintingPaymentDefault(crt);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            const endBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const endBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const endTotalCollateralPool = await agent.collateralPool.totalCollateral();
            const poolFee = crFee.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(endBalanceAgent.sub(startBalanceAgent), crFee.sub(poolFee));
            assertWeb3Equal(endBalancePool.sub(startBalancePool), poolFee);
            assertWeb3Equal(endTotalCollateralPool.sub(startTotalCollateralPool), poolFee);
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.DEFAULTED);
            // check that executing minting after calling mintingPaymentDefault will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint defaults - failed underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform some payment with correct minting reference and wrong amount
            await minter.performPayment(crt.paymentAddress, 100, crt.paymentReference);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // test rewarding for mint default
            const startBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const startBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const startTotalCollateralPool = await agent.collateralPool.totalCollateral();
            await agent.mintingPaymentDefault(crt);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            const endBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const endBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const endTotalCollateralPool = await agent.collateralPool.totalCollateral();
            const poolFee = crFee.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(endBalanceAgent.sub(startBalanceAgent), crFee.sub(poolFee));
            assertWeb3Equal(endBalancePool.sub(startBalancePool), poolFee);
            assertWeb3Equal(endTotalCollateralPool.sub(startTotalCollateralPool), poolFee);
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.DEFAULTED);
            // check that executing minting after calling mintingPaymentDefault will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint unstick - no underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after no payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: 0,
                mintedUBA: 0,
                reservedUBA: context.convertLotsToUBA(lots).add(agent.poolFeeShare(crt.feeUBA))
            });
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(reservedCollateral), freeUnderlyingBalanceUBA: 0, mintedUBA: 0, reservedUBA: 0 });
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });

        it("mint unstick - failed underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform some payment with correct minting reference and wrong amount
            await minter.performPayment(crt.paymentAddress, 100, crt.paymentReference);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after failed minting payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });

        it("mint unstick - unconfirmed underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform minting payment without sending proof
            const txHash = await minter.performMintingPayment(crt);
            await context.attestationProvider.provePayment(txHash, minter.underlyingAddress, crt.paymentAddress);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after unconfirmed payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });
    });
});
