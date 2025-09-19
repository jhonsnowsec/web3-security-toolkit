import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Challenger } from "../../../lib/test-utils/actors/Challenger";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Liquidator } from "../../../lib/test-utils/actors/Liquidator";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { assertApproximatelyEqual } from "../../../lib/test-utils/approximation";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { EventArgs } from "../../../lib/utils/events/common";
import { DAYS, toBN, toWei } from "../../../lib/utils/helpers";
import { RedemptionRequested } from "../../../typechain-truffle/IIAssetManager";

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

    describe("simple scenarios - illegal payment challenges and full liquidation", () => {

        it("illegal payment challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // perform illegal payment
            const tx1Hash = await agent.performPayment("IllegalPayment1", 100);
            // challenge agent for illegal payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.illegalPaymentChallenge(agent, tx1Hash);
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "ChallengeAlreadyLiquidating", []);
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assert.approximately(Number(reward) / 1e18, 300, 10);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(reward), freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot withdraw or even announce withdrawal when being fully liquidated
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(fullAgentCollateral), "WithdrawalInvalidAgentStatus", []);
            await expectRevert.custom(agent.withdrawVaultCollateral(fullAgentCollateral), "WithdrawalInvalidAgentStatus", []);
            // full liquidation status should show in available agent info
            const { 0: availableAgentInfos } = await context.assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(Number(availableAgentInfos[0].status), AgentStatus.FULL_LIQUIDATION);
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("double payment challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // perform double payment
            const tx1Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(5));
            const tx2Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(5));
            const tx3Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(6));
            // check that we cannot use the same transaction multiple times or transactions with different payment references
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "ChallengeSameTransactionRepeated", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx3Hash), "ChallengeNotDuplicate", []);
            // challenge agent for double payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.doublePaymentChallenge(agent, tx1Hash, tx2Hash);
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx2Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "ChallengeAlreadyLiquidating", []);
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(reward), freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("free balance negative challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const [minted] = await minter.performMinting(agent.vaultAddress, 3);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(3));
            await minter.transferFAsset(redeemer.address, minted.mintedAmountUBA);
            // make redemption request and then pay much more than requested
            const [[rrq]] = await redeemer.requestRedemption(1);
            const tx1Hash = await agent.performPayment(underlyingRedeemer1, context.convertLotsToUBA(3), rrq.paymentReference);
            // check that we cannot use other challenge types
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "MatchingRedemptionActive", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash, tx1Hash]), "ChallengeSameTransactionRepeated", []);
            // challenge agent for negative underlying balance
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]);
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // challenge cannot be repeated
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "ChallengeAlreadyLiquidating", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "ChallengeAlreadyLiquidating", []);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({
                status: AgentStatus.FULL_LIQUIDATION,
                totalVaultCollateralWei: fullAgentCollateral.sub(reward),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA).sub(rrq.valueUBA),
                redeemingUBA: rrq.valueUBA,
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("trying to pay more than agent's balance results in failed transaction and shouldn't trigger challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            await agent.depositCollateralLotsAndMakeAvailable(10);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const [minted] = await minter.performMinting(agent.vaultAddress, 3);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(3));
            await minter.transferFAsset(redeemer.address, minted.mintedAmountUBA);
            const mintDepositedAmount = minted.mintedAmountUBA.add(minted.agentFeeUBA).add(minted.poolFeeUBA);
            assertApproximatelyEqual(await context.chain.getBalance(agent.underlyingAddress), mintDepositedAmount, "absolute", 10);
            // make redemption request and then pay much more than requested
            const [[rrq]] = await redeemer.requestRedemption(1);
            const tx1Hash = await agent.performPayment(underlyingRedeemer1, context.convertLotsToUBA(10), rrq.paymentReference);
            // agent's underlying balance stays the same
            assertApproximatelyEqual(await context.chain.getBalance(agent.underlyingAddress), mintDepositedAmount, "absolute", 10);
            // check that we cannot challenge
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "MatchingRedemptionActive", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "ChallengeSameTransactionRepeated", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "MultiplePaymentsChallengeEnoughBalance", []);
            // confirming failed transaction
            await agent.confirmFailedRedemptionPayment(rrq, tx1Hash);
            // still can't challenge afterwards
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "ChallengeTransactionAlreadyConfirmed", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "ChallengeSameTransactionRepeated", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "MultiplePaymentsChallengeEnoughBalance", []);
        });

        it("agent cannot be challenged after expiring payment, even if paid", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            const request = redemptionRequests[0];
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // perform payment, but do not prove it
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txhash = await agent.performPayment(request.paymentAddress, paymentAmount, request.paymentReference);
            // wait 24h
            mockChain.mine(100);
            await time.deterministicIncrease(1 * DAYS);
            mockChain.skipTime(1 * DAYS);
            mockChain.mine(100);
            // expire payment
            const redDef = await agent.finishRedemptionWithoutPayment(request);
            assert.isDefined(redDef);
            assertWeb3Equal(redDef.requestId, request.requestId);
            // try to challenge
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, txhash), "MatchingRedemptionActive", []);
            // check agent status
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL, redeemingUBA: 0 }, "reset");
        });

        it("agent cannot be challenged fore redemption, even if payment way too late", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            const request = redemptionRequests[0];
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // wait 24h
            mockChain.mine(100);
            await time.deterministicIncrease(1 * DAYS);
            mockChain.skipTime(1 * DAYS);
            mockChain.mine(100);
            // perform payment, but do not prove it
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txhash = await agent.performPayment(request.paymentAddress, paymentAmount, request.paymentReference);
            // try to challenge
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, txhash), "MatchingRedemptionActive", []);
            // check agent status
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL, redeemingUBA: request.valueUBA }, "reset");
        });

        it("free balance negative challenge - multiple transactions", async () => {
            const N = 10;
            const lots = 1;
            // actors
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            for (let i = 0; i < N; i++) {
                const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
                const txHash = await minter.performMintingPayment(crt);
                const minted = await minter.executeMinting(crt, txHash);
                assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            }
            // find free balance
            const agentInfo = await context.assetManager.getAgentInfo(agent.agentVault.address);
            const payGas = toBN(agentInfo.freeUnderlyingBalanceUBA).divn(N).addn(10);   // in total, pay just a bit more then there is free balance
            // transfer f-assets to redeemer
            const totalMinted = await context.fAsset.balanceOf(minter.address);
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // make redemption requests
            const requests: EventArgs<RedemptionRequested>[] = [];
            for (let i = 0; i < N; i++) {
                const [rrqs] = await redeemer.requestRedemption(lots);
                requests.push(...rrqs);
            }
            assert.equal(requests.length, N);
            // perform some payments
            const txHashes: string[] = [];
            for (const request of requests) {
                const amount = (context.convertLotsToUBA(lots)).add(payGas);
                const txHash = await agent.performPayment(request.paymentAddress, amount, request.paymentReference);
                txHashes.push(txHash);
            }
            // check that all payments are legal
            for (const txHash of txHashes) {
                await expectRevert.custom(challenger.illegalPaymentChallenge(agent, txHash), "MatchingRedemptionActive", []);
            }
            // check that N-1 payments doesn't make free underlying balance negative
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, txHashes.slice(0, N - 1)), "MultiplePaymentsChallengeEnoughBalance", []);
            // check that N payments do make the transaction negative
            const liquidationStarted = await challenger.freeBalanceNegativeChallenge(agent, txHashes);
            // check that full liquidation started
            const info = await context.assetManager.getAgentInfo(agent.agentVault.address);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
        });

        it("full liquidation", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            const mintedAmount = toBN(minted.mintedAmountUBA).add(minted.poolFeeUBA);
            // perform illegal payment
            const tx1Hash = await agent.performPayment("IllegalPayment1", 100);
            // challenge agent for illegal payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.illegalPaymentChallenge(agent, tx1Hash);
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const challengerReward = await challenger.getChallengerReward(mintedAmount, agent);
            assertWeb3Equal(endBalance.sub(startBalance), challengerReward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(challengerReward),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: mintedAmount,
                status: AgentStatus.FULL_LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateUBA = minted.mintedAmountUBA.divn(3);
            const startBalanceLiquidator1VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator1Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator1VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator1Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateUBA);
            assert.isUndefined(liquidationStarted1);
            assert.isUndefined(liquidationCancelled1);
            // full liquidation cannot be stopped
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // test rewarding
            const collateralRatioBIPS1VaultCollateral = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward), mintedAmount);
            const liquidationFactorBIPS1VaultCollateral = await liquidator.getLiquidationFactorBIPSVaultCollateral(collateralRatioBIPS1VaultCollateral, liquidationStarted.timestamp, liquidationTimestamp1);
            const liquidationReward1VaultCollateral = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, liquidationFactorBIPS1VaultCollateral);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), liquidationReward1VaultCollateral);
            const collateralRatioBIPS1Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral, mintedAmount);
            const liquidationFactorBIPS1Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS1Pool, liquidationStarted.timestamp, liquidationTimestamp1);
            const liquidationReward1Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA1, liquidationFactorBIPS1Pool);
            assertWeb3Equal(endBalanceLiquidator1Pool.sub(startBalanceLiquidator1Pool), liquidationReward1Pool);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(liquidationReward1Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA),
                mintedUBA: mintedAmount.sub(liquidateUBA),
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION
            });
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)
            const startBalanceLiquidator2VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator2Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator2VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator2Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, liquidateUBA);
            assert.isUndefined(liquidationStarted2);
            assert.isUndefined(liquidationCancelled2);
            // full liquidation cannot be stopped
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // test rewarding
            const collateralRatioBIPS2VaultCollateral = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral), mintedAmount.sub(liquidateUBA));
            const liquidationFactorBIPS2VaultCollateral = await liquidator.getLiquidationFactorBIPSVaultCollateral(collateralRatioBIPS2VaultCollateral, liquidationStarted.timestamp, liquidationTimestamp2);
            const liquidationReward2VaultCollateral = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, liquidationFactorBIPS2VaultCollateral);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), liquidationReward2VaultCollateral);
            const collateralRatioBIPS2Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(liquidationReward1Pool), mintedAmount.sub(liquidateUBA));
            const liquidationFactorBIPS2Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS2Pool, liquidationStarted.timestamp, liquidationTimestamp2);
            const liquidationReward2Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA2, liquidationFactorBIPS2Pool);
            assertWeb3Equal(endBalanceLiquidator2Pool.sub(startBalanceLiquidator2Pool), liquidationReward2Pool);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral).sub(liquidationReward2VaultCollateral),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(liquidationReward1Pool).sub(liquidationReward2Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA.muln(2)),
                mintedUBA: mintedAmount.sub(liquidateUBA.muln(2)),
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION
            });
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (last part)
            const startBalanceLiquidator3VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator3Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA3, liquidationTimestamp3, liquidationStarted3, liquidationCancelled3] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator3VaultCollateral = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator3Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA3, liquidateUBA);
            assert.isUndefined(liquidationStarted3);
            assert.isUndefined(liquidationCancelled3);
            // full liquidation cannot be stopped
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // test rewarding
            const collateralRatioBIPS3VaultCollateral = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral).sub(liquidationReward2VaultCollateral), mintedAmount.sub(liquidateUBA.muln(2)));
            const liquidationFactorBIPS3VaultCollateral = await liquidator.getLiquidationFactorBIPSVaultCollateral(collateralRatioBIPS3VaultCollateral, liquidationStarted.timestamp, liquidationTimestamp3);
            const liquidationReward3VaultCollateral = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA3, liquidationFactorBIPS3VaultCollateral);
            assertWeb3Equal(endBalanceLiquidator3VaultCollateral.sub(startBalanceLiquidator3VaultCollateral), liquidationReward3VaultCollateral);
            const collateralRatioBIPS3Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(liquidationReward1Pool).sub(liquidationReward2Pool), mintedAmount.sub(liquidateUBA.muln(2)));
            const liquidationFactorBIPS3Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS3Pool, liquidationStarted.timestamp, liquidationTimestamp3);
            const liquidationReward3Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA3, liquidationFactorBIPS3Pool);
            assertWeb3Equal(endBalanceLiquidator3Pool.sub(startBalanceLiquidator3Pool), liquidationReward3Pool);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral).sub(liquidationReward2VaultCollateral).sub(liquidationReward3VaultCollateral),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(liquidationReward1Pool).sub(liquidationReward2Pool).sub(liquidationReward3Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA.muln(3)),
                mintedUBA: mintedAmount.sub(liquidateUBA.muln(3)),
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION
            });
            // final tests
            assertWeb3Equal(liquidatedUBA1, liquidatedUBA2);
            assertWeb3Equal(liquidatedUBA1, liquidatedUBA3);
            assert(liquidationFactorBIPS1VaultCollateral.eq(liquidationFactorBIPS2VaultCollateral));
            assert(liquidationFactorBIPS2VaultCollateral.eq(liquidationFactorBIPS3VaultCollateral));
            assert(liquidationFactorBIPS1Pool.lt(liquidationFactorBIPS2Pool));
            assert(liquidationFactorBIPS2Pool.lt(liquidationFactorBIPS3Pool));
            assert(liquidationReward1VaultCollateral.eq(liquidationReward2VaultCollateral));
            assert(liquidationReward2VaultCollateral.eq(liquidationReward3VaultCollateral));
            assert(liquidationReward1Pool.lt(liquidationReward2Pool));
            assert(liquidationReward2Pool.lt(liquidationReward3Pool));
            // full liquidation cannot be stopped
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1VaultCollateral).sub(liquidationReward2VaultCollateral).sub(liquidationReward3VaultCollateral));
        });
    });
});
