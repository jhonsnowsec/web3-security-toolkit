import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { toBN, toWei } from "../../../lib/utils/helpers";

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

    describe("simple scenarios - creating and converting dust", () => {
        it("mint and redeem f-assets (self-close can create and/or remove dust)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
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
            const info0 = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA) });
            assertWeb3Equal(info0.dustUBA, minted.poolFeeUBA);
            // agent "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, minted.mintedAmountUBA, { from: minter.address });
            // perform partial self close
            const dustAmountUBA = context.convertAmgToUBA(5);
            const selfCloseAmountUBA = minted.mintedAmountUBA.sub(dustAmountUBA);
            const [dustChangesUBA1, selfClosedUBA1] = await agent.selfClose(selfCloseAmountUBA);
            const info = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(selfCloseAmountUBA), mintedUBA: minted.poolFeeUBA.add(dustAmountUBA) });
            assertWeb3Equal(info.dustUBA, minted.poolFeeUBA.add(dustAmountUBA)); // pool fee + self-close dust
            assertWeb3Equal(selfClosedUBA1, selfCloseAmountUBA);
            assert.equal(dustChangesUBA1.length, 1);
            assertWeb3Equal(dustChangesUBA1[0], minted.poolFeeUBA.add(dustAmountUBA)); // then fail and add dust produced by self-close
            await expectRevert.custom(agent.destroy(), "DestroyNotAnnounced", []);
            const [dustChangesUBA2, selfClosedUBA2] = await agent.selfClose(dustAmountUBA);
            const info2 = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(selfCloseAmountUBA).add(dustAmountUBA), mintedUBA: minted.poolFeeUBA });
            assertWeb3Equal(info2.dustUBA, minted.poolFeeUBA);
            assertWeb3Equal(selfClosedUBA2, dustAmountUBA);
            assert.equal(dustChangesUBA2.length, 1);
            assertWeb3Equal(dustChangesUBA2[0], minted.poolFeeUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (changing lot size can create dust)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            assertWeb3Equal((await agent.getAgentInfo()).dustUBA, minted.poolFeeUBA);
            // change lot size
            const currentSettings = await context.assetManager.getSettings();
            await context.setLotSizeAmg(toBN(currentSettings.lotSizeAMG).muln(2));
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges1] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 2);
            assert.equal(dustChanges1.length, 1);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assertWeb3Equal(request.valueUBA, context.convertLotsToUBA(1));
            const redeemerDustAmountUBA = minted.mintedAmountUBA.sub(request.valueUBA);
            assertWeb3Equal(dustChanges1[0].dustUBA, redeemerDustAmountUBA.add(minted.poolFeeUBA));
            assert.equal(dustChanges1[0].agentVault, agent.agentVault.address);
            assert.equal(request.agentVault, agent.vaultAddress);
            const info = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: request.valueUBA });
            assertWeb3Equal(info.dustUBA, redeemerDustAmountUBA.add(minted.poolFeeUBA));
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            const info2 = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.feeUBA), mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA), redeemingUBA: 0, dustUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA) });
            assertWeb3Equal(info2.dustUBA, redeemerDustAmountUBA.add(minted.poolFeeUBA));
            // agent "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, redeemerDustAmountUBA, { from: redeemer.address });
            // perform self close
            const [dustChangesUBA2, selfClosedUBA] = await agent.selfClose(redeemerDustAmountUBA);
            const info3 = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.feeUBA).add(redeemerDustAmountUBA), mintedUBA: minted.poolFeeUBA, dustUBA: minted.poolFeeUBA });
            assertWeb3Equal(info3.dustUBA, minted.poolFeeUBA);
            assertWeb3Equal(selfClosedUBA, redeemerDustAmountUBA);
            assert.equal(dustChangesUBA2.length, 1);
            assertWeb3Equal(dustChangesUBA2[0], minted.poolFeeUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets - convert dust to tickets", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // perform partial self close (assume pool fee is less than one lot minus 5 amg to not get dust over one lot)
            const redeemerDustAmountUBA = context.convertLotsToUBA(1).sub(context.convertAmgToUBA(5)).sub(minted.poolFeeUBA);
            const selfCloseAmountUBA = minted.mintedAmountUBA.sub(redeemerDustAmountUBA);
            // agent "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, selfCloseAmountUBA, { from: minter.address });
            const [dustChangesUBA, selfClosedUBA1] = await agent.selfClose(selfCloseAmountUBA);
            const info = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(selfCloseAmountUBA), mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA) });
            assertWeb3Equal(info.dustUBA, redeemerDustAmountUBA.add(minted.poolFeeUBA));
            assertWeb3Equal(selfClosedUBA1, selfCloseAmountUBA);
            assert.equal(dustChangesUBA.length, 1);
            assertWeb3Equal(dustChangesUBA[0], redeemerDustAmountUBA.add(minted.poolFeeUBA));
            // change lot size
            const currentSettings = await context.assetManager.getSettings();
            await context.setLotSizeAmg(toBN(currentSettings.lotSizeAMG).divn(4));
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA.sub(selfCloseAmountUBA), { from: minter.address });
            // perform redemption - no tickets
            await expectRevert.custom(redeemer.requestRedemption(3), "RedeemZeroLots", []);
            const info2 = await agent.checkAgentInfo({ mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA) });
            assertWeb3Equal(info2.dustUBA, redeemerDustAmountUBA.add(minted.poolFeeUBA));
            // convert dust to redemption tickets
            const dustChangeUBA2 = await redeemer.convertDustToTicket(agent);
            const newDustAmount = context.convertLotsToUBA(1).sub(context.convertAmgToUBA(5));
            assertWeb3Equal(dustChangeUBA2, newDustAmount);
            const info3 = await agent.checkAgentInfo({ mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA) });
            assertWeb3Equal(info3.dustUBA, newDustAmount);
            // perform redemption from new tickets
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(3);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            const info4 = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(selfCloseAmountUBA).add(request.feeUBA), mintedUBA: redeemerDustAmountUBA.add(minted.poolFeeUBA).sub(request.valueUBA) });
            assertWeb3Equal(info4.dustUBA, newDustAmount);
            // agent "buys" f-assets
            const redeemerDustAmountUBA2 = minted.mintedAmountUBA.sub(selfCloseAmountUBA).sub(request.valueUBA);
            await context.fAsset.transfer(agent.ownerWorkAddress, redeemerDustAmountUBA2, { from: redeemer.address });
            // perform self close
            const [dustChangesUBA2, selfClosedUBA] = await agent.selfClose(redeemerDustAmountUBA2);
            const info5 = await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(selfCloseAmountUBA).add(request.feeUBA).add(redeemerDustAmountUBA2), mintedUBA: minted.poolFeeUBA });
            assertWeb3Equal(info5.dustUBA, minted.poolFeeUBA);
            assertWeb3Equal(selfClosedUBA, redeemerDustAmountUBA2);
            assert.equal(dustChangesUBA2.length, 1);
            assertWeb3Equal(dustChangesUBA2[0], minted.poolFeeUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });
    });
});
