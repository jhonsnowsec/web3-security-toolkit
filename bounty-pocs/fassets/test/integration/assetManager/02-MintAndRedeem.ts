import { CollateralReservationStatus, RedemptionRequestStatus } from "../../../lib/fasset/AssetManagerTypes";
import { requiredEventArgsFrom } from "../../../lib/test-utils/Web3EventDecoder";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { Approximation } from "../../../lib/test-utils/approximation";
import { impersonateContract, stopImpersonatingContract } from "../../../lib/test-utils/contract-test-helpers";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3DeepEqual, assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { BN_ZERO, MAX_BIPS, sumBN, toBN, toBNExp, toWei, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { ERC20MockInstance } from "../../../typechain-truffle";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const agentOwner3 = accounts[22];
    const minterAddress1 = accounts[30];
    const minterAddress2 = accounts[31];
    const minterAddress3 = accounts[32];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
    const redeemerAddress3 = accounts[42];
    const executorAddress1 = accounts[45];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingAgent3 = "Agent3";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingMinter3 = "Minter3";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";
    const underlyingRedeemer3 = "Redeemer3";

    let commonContext: CommonContext;
    let context: AssetContext;
    let mockChain: MockChain;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.btc);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
    });

    describe("simple scenarios - successful minting and redeeming", () => {
        it("mint and redeem f-assets", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            // update block
            const blockNumber = await context.updateUnderlyingBlock();
            const currentUnderlyingBlock = await context.assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentUnderlyingBlock[0], blockNumber);
            assertWeb3Equal(currentUnderlyingBlock[1], (await context.chain.getBlockAt(blockNumber))?.timestamp);
            // perform minting
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const lotsUBA = context.convertLotsToUBA(lots);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt.feeUBA))
            });
            const burnAddress = context.settings.burnAddress;
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            const minted = await minter.executeMinting(crt, txHash);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted.mintedAmountUBA, lotsUBA);
            const poolFeeShare = crt.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare, minted.poolFeeUBA);
            const agentFeeShare = crt.feeUBA.sub(poolFeeShare);
            assertWeb3Equal(agentFeeShare, minted.agentFeeUBA);
            const mintedUBA = crt.valueUBA.add(poolFeeShare);
            await agent.checkAgentInfo({ mintedUBA: mintedUBA, reservedUBA: 0 });
            // check that executing minting after confirmation will revert
            const txHash2 = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash2), "InvalidCrtId", []);
            // check that fee was not burned
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), 0);
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare, mintedUBA: poolFeeShare, redeemingUBA: lotsUBA });
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            // pay and confirm
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare.add(request.feeUBA), redeemingUBA: 0 });
            // redemption request info should show SUCCESSFUL state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.SUCCESSFUL);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (updating redemption fee and collateral reservation fee)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            // update block
            const blockNumber = await context.updateUnderlyingBlock();
            const currentUnderlyingBlock = await context.assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentUnderlyingBlock[0], blockNumber);
            assertWeb3Equal(currentUnderlyingBlock[1], (await context.chain.getBlockAt(blockNumber))?.timestamp);
            // perform minting
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const lotsUBA = context.convertLotsToUBA(lots);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt.feeUBA))
            });
            const burnAddress = context.settings.burnAddress;
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            const minted = await minter.executeMinting(crt, txHash);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted.mintedAmountUBA, lotsUBA);
            const poolFeeShare = crt.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare, minted.poolFeeUBA);
            const agentFeeShare = crt.feeUBA.sub(poolFeeShare);
            assertWeb3Equal(agentFeeShare, minted.agentFeeUBA);
            const mintedUBA = crt.valueUBA.add(poolFeeShare);
            await agent.checkAgentInfo({ mintedUBA: mintedUBA, reservedUBA: 0 });
            // change Collateral reservation fee bips
            const currentSettings = await context.assetManager.getSettings();
            await context.setCollateralReservationFeeBips(toBN(currentSettings.collateralReservationFeeBIPS).muln(2));
            // perform minting again
            const crFee2 = await minter.getCollateralReservationFee(lots);
            const crt2 = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash2 = await minter.performMintingPayment(crt2);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt2.feeUBA))
            });
            const startBalanceBurnAddress2 = toBN(await web3.eth.getBalance(burnAddress));
            const minted2 = await minter.executeMinting(crt2, txHash2);
            const endBalanceBurnAddress2 = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted2.mintedAmountUBA, lotsUBA);
            const poolFeeShare2 = crt2.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare2, minted2.poolFeeUBA);
            const agentFeeShare2 = crt2.feeUBA.sub(poolFeeShare);
            assertWeb3Equal(agentFeeShare2, minted2.agentFeeUBA);
            const mintedUBA2 = crt2.valueUBA.add(poolFeeShare2);
            await agent.checkAgentInfo({ mintedUBA: mintedUBA.add(mintedUBA2), reservedUBA: 0 });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA.add(minted2.mintedAmountUBA), { from: minter.address });
            // wait until another setting update is possible
            await time.deterministicIncrease(currentSettings.minUpdateRepeatTimeSeconds);
            // change redemption fee bips
            await context.setCollateralReservationFeeBips(toBN(currentSettings.redemptionFeeBIPS).muln(2));
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots * 2);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare.add(agentFeeShare2), mintedUBA: poolFeeShare.add(poolFeeShare2), redeemingUBA: lotsUBA.muln(2) });
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare.add(agentFeeShare2).add(request.feeUBA), redeemingUBA: 0 });
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets with whitelisting", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.createAgentOwnerRegistry();
            await context.agentOwnerRegistry?.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            // update block
            const blockNumber = await context.updateUnderlyingBlock();
            const currentUnderlyingBlock = await context.assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentUnderlyingBlock[0], blockNumber);
            assertWeb3Equal(currentUnderlyingBlock[1], (await context.chain.getBlockAt(blockNumber))?.timestamp);
            // perform minting
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const lotsUBA = context.convertLotsToUBA(lots);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt.feeUBA))
            });
            const burnAddress = context.settings.burnAddress;
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            const minted = await minter.executeMinting(crt, txHash);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted.mintedAmountUBA, lotsUBA);
            const poolFeeShare = crt.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare, minted.poolFeeUBA);
            const agentFeeShare = crt.feeUBA.sub(poolFeeShare);
            assertWeb3Equal(agentFeeShare, minted.agentFeeUBA);
            const mintedUBA = crt.valueUBA.add(poolFeeShare);
            await agent.checkAgentInfo({ mintedUBA: mintedUBA, reservedUBA: 0 });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare, mintedUBA: poolFeeShare, redeemingUBA: lotsUBA });
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare.add(request.feeUBA), redeemingUBA: 0 });
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets when minting cap is enabled", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            // update block
            const blockNumber = await context.updateUnderlyingBlock();
            const currentUnderlyingBlock = await context.assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentUnderlyingBlock[0], blockNumber);
            assertWeb3Equal(currentUnderlyingBlock[1], (await context.chain.getBlockAt(blockNumber))?.timestamp);
            //Set a small minting cap
            await context.assetManagerController.setMintingCapAmg([context.assetManager.address], context.convertLotsToAMG(10), { from: governance });
            // perform minting
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            //Try minting more lots than minting cap
            const res = minter.reserveCollateral(agent.vaultAddress, 15);
            await expectRevert.custom(res, "MintingCapExceeded", []);
            //Try minting less lots
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            //Try to mint again
            const res2 = minter.reserveCollateral(agent.vaultAddress, 8);
            await expectRevert.custom(res2, "MintingCapExceeded", []);
            const txHash = await minter.performMintingPayment(crt);
            const lotsUBA = context.convertLotsToUBA(lots);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt.feeUBA))
            });
            const burnAddress = context.settings.burnAddress;
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            const minted = await minter.executeMinting(crt, txHash);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted.mintedAmountUBA, lotsUBA);
            const poolFeeShare = crt.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare, minted.poolFeeUBA);
            const agentFeeShare = crt.feeUBA.sub(poolFeeShare);
            assertWeb3Equal(agentFeeShare, minted.agentFeeUBA);
            const mintedUBA = crt.valueUBA.add(poolFeeShare);
            await agent.checkAgentInfo({ mintedUBA: mintedUBA, reservedUBA: 0 });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare, mintedUBA: poolFeeShare, redeemingUBA: lotsUBA });
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const tx1Hash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, tx1Hash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare.add(request.feeUBA), redeemingUBA: 0 });
            // perform minting
            const lots2 = 9;
            const crt2 = await minter.reserveCollateral(agent.vaultAddress, lots2);
            const txHash2 = await minter.performMintingPayment(crt2);
            const lotsUBA2 = context.convertLotsToUBA(lots2);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                reservedUBA: lotsUBA2.add(agent.poolFeeShare(crt2.feeUBA))
            });
            const minted2 = await minter.executeMinting(crt2, txHash2);
            assertWeb3Equal(minted2.mintedAmountUBA, lotsUBA2);
            const poolFeeShare2 = crt2.feeUBA.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(poolFeeShare2, minted2.poolFeeUBA);
            const agentFeeShare2 = crt2.feeUBA.sub(poolFeeShare2);
            assertWeb3Equal(agentFeeShare2, minted2.agentFeeUBA);
            const mintedUBA2 = crt2.valueUBA.add(poolFeeShare2);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare2.add(agentFeeShare).add(request.feeUBA), mintedUBA: poolFeeShare.add(mintedUBA2), reservedUBA: 0 });
            await context.fAsset.transfer(redeemer.address, minted2.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests2, remainingLots2, dustChanges2] = await redeemer.requestRedemption(lots2);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare2.add(agentFeeShare).add(request.feeUBA), mintedUBA: poolFeeShare2.add(poolFeeShare), redeemingUBA: lotsUBA2 });
            assertWeb3Equal(remainingLots2, 0);
            assert.equal(dustChanges2.length, 0);
            assert.equal(redemptionRequests2.length, 1);
            const request2 = redemptionRequests2[0];
            assert.equal(request2.agentVault, agent.vaultAddress);
            const tx1Hash2 = await agent.performRedemptionPayment(request2);
            await agent.confirmActiveRedemptionPayment(request2, tx1Hash2);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: agentFeeShare2.add(request2.feeUBA).add(agentFeeShare).add(request.feeUBA), redeemingUBA: 0 });
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (two redemption tickets - same agent) + agent can confirm mintings", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter1 = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const minter2 = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            let underlyingBalance = await context.chain.getBalance(agent.underlyingAddress);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots1 = 3;
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, totalPoolCollateralNATWei: fullAgentCollateral });
            const crt1 = await minter1.reserveCollateral(agent.vaultAddress, lots1);
            await agent.checkAgentInfo({ reservedUBA: crt1.valueUBA.add(agent.poolFeeShare(crt1.feeUBA)) });
            const tx1Hash = await minter1.performMintingPayment(crt1);
            underlyingBalance = underlyingBalance.add(crt1.valueUBA).add(crt1.feeUBA);
            await agent.checkAgentInfo({ actualUnderlyingBalance: underlyingBalance }); // only change on other chain
            const minted1 = await agent.executeMinting(crt1, tx1Hash);
            assertWeb3Equal(minted1.mintedAmountUBA, context.convertLotsToUBA(lots1));
            const totalMinted1 = minted1.mintedAmountUBA.add(minted1.poolFeeUBA);
            const poolCRFee1 = await agent.poolCRFee(lots1);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted1.agentFeeUBA, mintedUBA: totalMinted1, reservedUBA: 0, totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee1) });
            const lots2 = 6;
            const crt2 = await minter2.reserveCollateral(agent.vaultAddress, lots2);
            await agent.checkAgentInfo({ reservedUBA: crt2.valueUBA.add(agent.poolFeeShare(crt2.feeUBA)) });
            const tx2Hash = await minter2.performMintingPayment(crt2);
            underlyingBalance = underlyingBalance.add(crt2.valueUBA).add(crt2.feeUBA);
            await agent.checkAgentInfo({ actualUnderlyingBalance: underlyingBalance });
            const minted2 = await agent.executeMinting(crt2, tx2Hash, minter2);
            assertWeb3Equal(minted2.mintedAmountUBA, context.convertLotsToUBA(lots2));
            const totalMinted2 = totalMinted1.add(minted2.mintedAmountUBA).add(minted2.poolFeeUBA);
            const poolCRFee2 = await agent.poolCRFee(lots2);
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: minted1.agentFeeUBA.add(minted2.agentFeeUBA), mintedUBA: totalMinted2, reservedUBA: 0,
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee1).add(poolCRFee2)
            });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted2.mintedAmountUBA, { from: minter2.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots2);
            const request = redemptionRequests[0];
            assertWeb3Equal(remainingLots, 0);
            assertWeb3Equal(request.valueUBA, context.convertLotsToUBA(lots2));
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            assert.equal(request.agentVault, agent.vaultAddress);
            const totalMinted3 = totalMinted2.sub(request.valueUBA);
            await agent.checkAgentInfo({ mintedUBA: totalMinted3, redeemingUBA: request.valueUBA });
            const txHash = await agent.performRedemptionPayment(request);
            underlyingBalance = underlyingBalance.sub(request.valueUBA).add(request.feeUBA);
            await agent.checkAgentInfo({ actualUnderlyingBalance: underlyingBalance });
            await agent.confirmActiveRedemptionPayment(request, txHash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted1.agentFeeUBA.add(minted2.agentFeeUBA).add(request.feeUBA), redeemingUBA: 0 });
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(fullAgentCollateral), "WithdrawalValueTooHigh", []);
        });

        it("mint and redeem f-assets (two redemption tickets - different agents)", async () => {
            const agent1 = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent1.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            await agent2.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots1 = 3;
            const crt1 = await minter.reserveCollateral(agent1.vaultAddress, lots1);
            const tx1Hash = await minter.performMintingPayment(crt1);
            const minted1 = await minter.executeMinting(crt1, tx1Hash);
            assertWeb3Equal(minted1.mintedAmountUBA, context.convertLotsToUBA(lots1));
            const lots2 = 6;
            const crt2 = await minter.reserveCollateral(agent2.vaultAddress, lots2);
            const tx2Hash = await minter.performMintingPayment(crt2);
            const minted2 = await minter.executeMinting(crt2, tx2Hash);
            assertWeb3Equal(minted2.mintedAmountUBA, context.convertLotsToUBA(lots2));
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted2.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots2);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 2);
            const request1 = redemptionRequests[0];
            assert.equal(request1.agentVault, agent1.vaultAddress);
            const tx3Hash = await agent1.performRedemptionPayment(request1);
            await agent1.confirmActiveRedemptionPayment(request1, tx3Hash);
            const cc = await agent1.getAgentCollateral();
            // do full calculation once, normally just need to calculate `poolFeeCollateral = cc.lockedCollateralWei(minted1.poolFeeUBA, cc.vaultCollateral)`
            const poolFeeCollateral = cc.vault.convertUBAToTokenWei(minted1.poolFeeUBA.mul(toBN(agent1.settings.mintingVaultCollateralRatioBIPS)).divn(MAX_BIPS));
            await agent1.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted1.agentFeeUBA.add(request1.feeUBA),
                mintedUBA: minted1.poolFeeUBA,
                freeVaultCollateralWei: Approximation.absolute(fullAgentCollateral.sub(poolFeeCollateral), 10)
            });
            const request2 = redemptionRequests[1];
            assert.equal(request2.agentVault, agent2.vaultAddress);
            const tx4Hash = await agent2.performRedemptionPayment(request2);
            await agent2.confirmActiveRedemptionPayment(request2, tx4Hash);
            await agent2.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted2.agentFeeUBA.add(request2.feeUBA),
                mintedUBA: context.convertLotsToUBA(3).add(minted2.poolFeeUBA)
            });
            await expectRevert.custom(agent2.announceVaultCollateralWithdrawal(fullAgentCollateral), "WithdrawalValueTooHigh", []);
        });

        it("mint and redeem f-assets (many redemption tickets, get RedemptionRequestIncomplete)", async () => {
            const N = 25;
            const MT = 20;  // max tickets redeemed
            const fullAgentCollateral = toWei(3e8);
            const agents: Agent[] = [];
            const underlyingAddress = (i: number) => `${underlyingAgent1}_vault_${i}`;
            for (let i = 0; i < N; i++) {
                const agent = await Agent.createTest(context, agentOwner1, underlyingAddress(i));
                await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
                agents.push(agent);
            }
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // perform minting
            let totalMinted = BN_ZERO;
            for (const agent of agents) {
                await context.updateUnderlyingBlock();
                const crt = await minter.reserveCollateral(agent.vaultAddress, 1);
                const txHash = await minter.performMintingPayment(crt);
                const minted = await minter.executeMinting(crt, txHash);
                assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(1));
                totalMinted = totalMinted.add(toBN(minted.mintedAmountUBA));
            }
            // check redemption tickets
            const allTickets = await context.getRedemptionQueue(10);
            assertWeb3Equal(allTickets.length, N);
            for (let i = 0; i < N; i++) {
                const agentTickets = await agents[i].getRedemptionQueue(10);
                assertWeb3Equal(agentTickets.length, 1);
                assertWeb3DeepEqual(agentTickets[0], allTickets[i]);
                // check data
                assertWeb3Equal(allTickets[i].ticketValueUBA, context.lotSize());
                assertWeb3Equal(allTickets[i].agentVault, agents[i].vaultAddress);
            }
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // request redemption
            const executorFee = toBNExp(N + 0.5, 9);  // 25.5 gwei, 0.5 gwei should be lost
            const executor = accounts[88];
            await context.updateUnderlyingBlock();
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(N, executor, executorFee);
            // validate redemption requests
            assertWeb3Equal(remainingLots, N - MT);  // should only redeem 20 tickets out of 25
            assert.equal(redemptionRequests.length, MT);
            const totalExecutorFee = sumBN(redemptionRequests, rq => toBN(rq.executorFeeNatWei));
            assertWeb3Equal(totalExecutorFee, toBNExp(N, 9));
            assert.equal(dustChanges.length, 0);
            // pay for all requests
            const mockChain = context.chain as MockChain;
            mockChain.automine = false;
            const rdTxHashes: string[] = [];
            for (let i = 0; i < redemptionRequests.length; i++) {
                const request = redemptionRequests[i];
                const agent = agents[i];
                assert.equal(request.agentVault, agent.vaultAddress);
                const txHash = await agent.performRedemptionPayment(request);
                rdTxHashes.push(txHash);
            }
            mockChain.mine();
            mockChain.automine = true;
            // confirm all requests
            for (let i = 0; i < rdTxHashes.length; i++) {
                const request = redemptionRequests[i];
                const agent = agents[i];
                await agent.confirmActiveRedemptionPayment(request, rdTxHashes[i]);
            }
        });

        it("mint and redeem f-assets (many redemption tickets to the same agent are merged at minting, so can be redeemed at once)", async () => {
            const N = 25;
            const MT = 20;  // max tickets redeemed
            const lotSize = context.lotSize();
            const fullAgentCollateral = toWei(3e8);
            const underlyingAddress = (i: number) => `${underlyingAgent1}_vault_${i}`;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // perform minting
            let totalMinted = BN_ZERO;
            let totalPoolFee = BN_ZERO;
            for (let i = 0; i < N; i++) {
                await context.updateUnderlyingBlock();
                const [minted] = await minter.performMinting(agent.vaultAddress, 1);
                assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(1));
                totalMinted = totalMinted.add(toBN(minted.mintedAmountUBA));
                totalPoolFee = totalPoolFee.add(toBN(minted.poolFeeUBA));
            }
            assertWeb3Equal(totalMinted, lotSize.muln(N));
            // check redemption tickets (there should be only 1)
            const totalTicketAmount = totalMinted.add(totalPoolFee.div(lotSize).mul(lotSize));  // whole lots of pool fee get added to ticket
            const allTickets = await context.getRedemptionQueue(10);
            assertWeb3Equal(allTickets.length, 1);
            assertWeb3Equal(allTickets[0].ticketValueUBA, totalTicketAmount);
            assertWeb3Equal(allTickets[0].agentVault, agent.vaultAddress);
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // request redemption
            const executorFee = toBNExp(N + 0.5, 9);  // 25.5 gwei, 0.5 gwei should be lost
            const executor = accounts[88];
            await context.updateUnderlyingBlock();
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(N, executor, executorFee);
            // validate redemption requests
            assertWeb3Equal(remainingLots, 0);  // should only redeem 20 tickets out of 25
            assert.equal(redemptionRequests.length, 1);
            const totalExecutorFee = sumBN(redemptionRequests, rq => toBN(rq.executorFeeNatWei));
            assertWeb3Equal(totalExecutorFee, toBNExp(N, 9));
            assert.equal(dustChanges.length, 0);
            // perform redemptions
            await agent.performRedemptions(redemptionRequests);
        });

        it("mint and redeem f-assets (one redemption ticket - two redeemers)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer1 = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const redeemer2 = await Redeemer.create(context, redeemerAddress2, underlyingRedeemer2);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // redeemers "buy" f-assets
            await context.fAsset.transfer(redeemer1.address, minted.mintedAmountUBA.divn(2), { from: minter.address });
            await context.fAsset.transfer(redeemer2.address, minted.mintedAmountUBA.divn(2), { from: minter.address });
            // perform redemptions
            const [redemptionRequests1, remainingLots1, dustChangesUBA1] = await redeemer1.requestRedemption(lots / 2);
            assertWeb3Equal(remainingLots1, 0);
            assert.equal(dustChangesUBA1.length, 0);
            assert.equal(redemptionRequests1.length, 1);
            const [redemptionRequests2, remainingLots2, dustChangesUBA2] = await redeemer2.requestRedemption(lots / 2);
            assertWeb3Equal(remainingLots2, 0);
            assert.equal(dustChangesUBA2.length, 0);
            assert.equal(redemptionRequests2.length, 1);
            const request1 = redemptionRequests1[0];
            assert.equal(request1.agentVault, agent.vaultAddress);
            const tx3Hash = await agent.performRedemptionPayment(request1);
            await agent.confirmActiveRedemptionPayment(request1, tx3Hash);
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(fullAgentCollateral), "WithdrawalValueTooHigh", []);
            const request2 = redemptionRequests2[0];
            assert.equal(request2.agentVault, agent.vaultAddress);
            const tx4Hash = await agent.performRedemptionPayment(request2);
            await agent.confirmActiveRedemptionPayment(request2, tx4Hash);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (self-mint)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform self-minting
            const lots = 3;
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            const minted = await agent.selfMint(context.convertLotsToUBA(lots), lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({ mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA) });
            // perform self close
            const [dustChanges, selfClosedUBA] = await agent.selfClose(minted.mintedAmountUBA);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.mintedAmountUBA, mintedUBA: minted.poolFeeUBA });
            assertWeb3Equal(selfClosedUBA, minted.mintedAmountUBA);
            assert.equal(dustChanges.length, 0);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (mint from free underlying)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform self-minting
            const lots = 3;
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            // topup enough to mint later
            const mintAmountUBA = context.convertLotsToUBA(lots);
            const mintPoolFeeUBA = toBN(mintAmountUBA).mul(toBN(agent.settings.feeBIPS)).divn(MAX_BIPS).mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            const topupUBA = toBN(mintAmountUBA).add(mintPoolFeeUBA.muln(2));   // add pool fee for 2 mintings
            const topupTx = await agent.performTopupPayment(topupUBA);
            await agent.confirmTopupPayment(topupTx);
            // now teh agent can mint from free inderlying
            const minted = await agent.mintFromFreeUnderlying(lots);
            assertWeb3Equal(minted.mintedAmountUBA, mintAmountUBA);
            assertWeb3Equal(minted.poolFeeUBA, mintPoolFeeUBA);
            await agent.checkAgentInfo({ mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), freeUnderlyingBalanceUBA: mintPoolFeeUBA });
            // perform self close
            const [dustChanges, selfClosedUBA] = await agent.selfClose(minted.mintedAmountUBA);
            await agent.checkAgentInfo({ mintedUBA: minted.poolFeeUBA, freeUnderlyingBalanceUBA: mintAmountUBA.add(mintPoolFeeUBA) });
            assertWeb3Equal(selfClosedUBA, minted.mintedAmountUBA);
            assert.equal(dustChanges.length, 0);
            // now the underlying is free again, so agent can re-mint
            const minted2 = await agent.mintFromFreeUnderlying(lots);
            assertWeb3Equal(minted2.mintedAmountUBA, mintAmountUBA);
            assertWeb3Equal(minted2.poolFeeUBA, mintPoolFeeUBA);
            await agent.checkAgentInfo({ mintedUBA: minted2.mintedAmountUBA.add(minted.poolFeeUBA).add(minted2.poolFeeUBA), freeUnderlyingBalanceUBA: 0 });
            // self close again
            await agent.selfClose(minted.mintedAmountUBA);
            await agent.checkAgentInfo({ mintedUBA: mintPoolFeeUBA.muln(2), freeUnderlyingBalanceUBA: mintAmountUBA });
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem f-assets (self-close)", async () => {
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
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: crt.feeUBA.sub(minted.poolFeeUBA),
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA)
            });
            // agent "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, minted.mintedAmountUBA, { from: minter.address });
            // perform self close
            const [dustChanges, selfClosedUBA] = await agent.selfClose(minted.mintedAmountUBA);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: crt.feeUBA.sub(minted.poolFeeUBA).add(crt.valueUBA),
                mintedUBA: minted.poolFeeUBA
            });
            assertWeb3Equal(selfClosedUBA, minted.mintedAmountUBA);
            assert.equal(dustChanges.length, 0);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("change wnat contract and try redeeming collateral pool tokens", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // wait for token timelock
            await time.deterministicIncrease(await context.assetManager.getCollateralPoolTokenTimelockSeconds());
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            // Upgrade wNat contract
            const ERC20Mock = artifacts.require("ERC20Mock");
            const newWNat: ERC20MockInstance = await ERC20Mock.new("new wnat", "WNat");
            await impersonateContract(context.assetManager.address, toBN(512526332000000000), accounts[0]);
            await agent.collateralPool.upgradeWNatContract(newWNat.address, { from: context.assetManager.address });
            await stopImpersonatingContract(context.assetManager.address);
            const agentInfo = await context.assetManager.getAgentInfo(agent.agentVault.address);
            const tokens = agentInfo.totalAgentPoolTokensWei;
            await context.assetManager.announceAgentPoolTokenRedemption(agent.agentVault.address, tokens, { from: agentOwner1 });
            await time.deterministicIncrease((await context.assetManager.getSettings()).withdrawalWaitMinSeconds);
            const poolTokensBefore = await agent.collateralPoolToken.totalSupply();
            //Redeem collateral pool tokens
            await agent.agentVault.redeemCollateralPoolTokens(tokens, agentOwner1, { from: agentOwner1 });
            const poolTokensAfter = await agent.collateralPoolToken.totalSupply();
            assertWeb3Equal(poolTokensBefore.sub(poolTokensAfter), tokens);
        });

        it("redemption after lot size increase should work", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            await agent2.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mint 1 lot
            await minter.performMinting(agent.vaultAddress, 1);
            await minter.performMinting(agent2.vaultAddress, 1);
            // increase lot size
            await context.setLotSizeAmg(toBN(context.settings.lotSizeAMG).muln(2));
            // mint 1 more lot
            await minter.performMinting(agent.vaultAddress, 1);
            // try redeem
            const [requests] = await redeemer.requestRedemption(1);
            assert.equal(requests.length, 1);
            assertWeb3Equal(requests[0].valueUBA, context.lotSize());
        });

        it("redemption after lot size increase should work - large number of tickets", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            await agent2.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mint 1 lot (30 times)
            for (let i = 0; i < 15; i++) {
                await minter.performMinting(agent.vaultAddress, 1);
                await minter.performMinting(agent2.vaultAddress, 1);
            }
            // increase lot size
            await context.setLotSizeAmg(toBN(context.settings.lotSizeAMG).muln(2));
            // mint 1 more lot
            await minter.performMinting(agent.vaultAddress, 1);
            // try redeem
            const [requests] = await redeemer.requestRedemption(1);
            assert.equal(requests.length, 1);
            assertWeb3Equal(requests[0].valueUBA, context.lotSize());
        });

        it("non-public agent can add 'always allowed minter' and that one doesn't pay CR fee", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const allowedMinter = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.underlyingAmount(10000));
            const fullAgentCollateral = toWei(3e8);
            await agent.depositVaultCollateral(fullAgentCollateral);
            await agent.buyCollateralPoolTokens(fullAgentCollateral);
            // allow a single minter
            await context.assetManager.addAlwaysAllowedMinterForAgent(agent.vaultAddress, allowedMinter.address, { from: agent.ownerWorkAddress });
            assertWeb3DeepEqual(await context.assetManager.alwaysAllowedMintersForAgent(agent.vaultAddress), [allowedMinter.address]);
            // ordinary minters cannot mint
            await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, 1), "AgentNotInMintQueue", []);
            // allowed minter can mint without paying collateral reservation fee
            const agentInfo = await agent.getAgentInfo();
            const mintingRes = await context.assetManager.reserveCollateral(agent.vaultAddress, 1, agentInfo.feeBIPS, ZERO_ADDRESS, { from: allowedMinter.address });
            const minting = requiredEventArgs(mintingRes, "CollateralReserved");
            const txhash = await allowedMinter.performMintingPayment(minting);
            await allowedMinter.executeMinting(minting, txhash);
            // however, if the agent becomes public, everybody has to pay collateral reservation fee
            await agent.makeAvailable();
            await expectRevert.custom(context.assetManager.reserveCollateral(agent.vaultAddress, 1, agentInfo.feeBIPS, ZERO_ADDRESS, { from: allowedMinter.address }),
                "InappropriateFeeAmount", []);
            await agent.exitAvailable();
            // allowed minter can be removed and then it cannot mint on non-pubic agent anymore
            await context.assetManager.removeAlwaysAllowedMinterForAgent(agent.vaultAddress, allowedMinter.address, { from: agent.ownerWorkAddress });
            assertWeb3DeepEqual(await context.assetManager.alwaysAllowedMintersForAgent(agent.vaultAddress), []);
            // now allowedMinter cannot mint
            await expectRevert.custom(context.assetManager.reserveCollateral(agent.vaultAddress, 1, agentInfo.feeBIPS, ZERO_ADDRESS, { from: allowedMinter.address }),
                "AgentNotInMintQueue", [])
        });

        it("non-public agent can add 'always allowed minter' for a proxy contract and people can mint through that", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            await agent.depositCollateralLots(10);
            // deploy minting proxy
            const operatorAddress = accounts[50];
            const MintingProxy = artifacts.require("MintingProxyMock");
            const mintingProxy = await MintingProxy.new(context.assetManager.address, agent.vaultAddress, operatorAddress);
            // allow a only minting proxy as minter
            await context.assetManager.addAlwaysAllowedMinterForAgent(agent.vaultAddress, mintingProxy.address, { from: agent.ownerWorkAddress });
            // ordinary minters cannot mint
            await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, 1), "AgentNotInMintQueue", []);
            // but can mint through proxy
            const maxFeeBIPS = await mintingProxy.mintingFeeBIPS();
            const res = await mintingProxy.reserveCollateral(10, maxFeeBIPS, { from: minter.address });
            const crt = requiredEventArgsFrom(res, context.assetManager, "CollateralReserved");
            const txHash = await minter.performMintingPayment(crt);
            const proof = await context.attestationProvider.provePayment(txHash, minter.underlyingAddress, crt.paymentAddress);
            await mintingProxy.executeMinting(proof, crt.collateralReservationId, { from: operatorAddress });
            // minter should receive 10 lots of fassets
            assertWeb3Equal(await context.fAsset.balanceOf(minter.address), context.convertLotsToUBA(10));
        });

        it("when agent sets non-zero redemption pool fee share, some fassets are minted to pool after redemption", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // set non-zero pool fee share
            const redemptionPoolFeeShareBIPS = 4000;
            await agent.changeSettings({ redemptionPoolFeeShareBIPS });
            //
            const lots = 10;
            const [minted] = await minter.performMinting(agent.vaultAddress, lots);
            await agent.checkAgentInfo({ mintedUBA: toBN(minted.mintedAmountUBA).add(toBN(minted.poolFeeUBA)) });
            //
            const [rrqs] = await redeemer.requestRedemption(lots);
            await agent.checkAgentInfo({ mintedUBA: toBN(minted.poolFeeUBA), redeemingUBA: toBN(minted.mintedAmountUBA) });
            assert.equal(rrqs.length, 1);
            const poolBalanceBefore = await context.fAsset.balanceOf(agent.collateralPool.address);
            const [rresp0] = await agent.performRedemptions(rrqs);
            const poolBalanceAfter = await context.fAsset.balanceOf(agent.collateralPool.address);
            const totalRedemptionFee = context.convertLotsToUBA(lots).mul(toBN(context.settings.redemptionFeeBIPS)).divn(MAX_BIPS);
            const poolRedemptionFee = totalRedemptionFee.muln(redemptionPoolFeeShareBIPS).divn(MAX_BIPS);
            expectEvent(rresp0, "RedemptionPoolFeeMinted", { poolFeeUBA: poolRedemptionFee })
            assertWeb3Equal(poolBalanceAfter.sub(poolBalanceBefore), poolRedemptionFee);
            await agent.checkAgentInfo({ mintedUBA: toBN(minted.poolFeeUBA).add(poolRedemptionFee), redeemingUBA: 0 });
        });

        it("revert when adding and removing allowed minter for agent from wrong address", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const allowedMinter = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.underlyingAmount(10000));
            await expectRevert.custom(context.assetManager.addAlwaysAllowedMinterForAgent(agent.vaultAddress, allowedMinter.address), "OnlyAgentVaultOwner", []);
            await expectRevert.custom(context.assetManager.removeAlwaysAllowedMinterForAgent(agent.vaultAddress, allowedMinter.address), "OnlyAgentVaultOwner", []);
        });

        it("obtain collateral reservation and redemption request info", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(10));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.updateUnderlyingBlock();
            await agent.depositCollateralLotsAndMakeAvailable(10);
            const agentInfo = await agent.getAgentInfo();
            // mint
            const mintReq = await minter.reserveCollateral(agent.vaultAddress, 5, executorAddress1, toWei("0.01"));
            const crInfo = await context.assetManager.collateralReservationInfo(mintReq.collateralReservationId);
            // console.log(deepFormat(crInfo));
            assertWeb3Equal(crInfo.collateralReservationId, mintReq.collateralReservationId);
            assertWeb3Equal(crInfo.agentVault, mintReq.agentVault);
            assertWeb3Equal(crInfo.minter, mintReq.minter);
            assertWeb3Equal(crInfo.paymentAddress, mintReq.paymentAddress);
            assertWeb3Equal(crInfo.paymentReference, mintReq.paymentReference);
            assertWeb3Equal(crInfo.valueUBA, mintReq.valueUBA);
            assertWeb3Equal(crInfo.mintingFeeUBA, mintReq.feeUBA);
            assertWeb3Equal(crInfo.firstUnderlyingBlock, mintReq.firstUnderlyingBlock);
            assertWeb3Equal(crInfo.lastUnderlyingBlock, mintReq.lastUnderlyingBlock);
            assertWeb3Equal(crInfo.lastUnderlyingTimestamp, mintReq.lastUnderlyingTimestamp);
            assertWeb3Equal(crInfo.poolFeeShareBIPS, agentInfo.poolFeeShareBIPS);
            assertWeb3Equal(crInfo.executor, mintReq.executor);
            assertWeb3Equal(crInfo.executorFeeNatWei, mintReq.executorFeeNatWei);
            assertWeb3Equal(crInfo.status, CollateralReservationStatus.ACTIVE);
            // execute mint
            const mintTxHash = await minter.performMintingPayment(mintReq);
            const minted = await minter.executeMinting(mintReq, mintTxHash);
            // now the info still works, but success status has changed
            const crInfo2 = await context.assetManager.collateralReservationInfo(mintReq.collateralReservationId);
            assertWeb3Equal(crInfo2.status, CollateralReservationStatus.SUCCESSFUL);
            // redeem
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(5));
            const [[redeemReq]] = await redeemer.requestRedemption(5, executorAddress1, toWei("0.02"));
            const redeemInfo = await context.assetManager.redemptionRequestInfo(redeemReq.requestId);
            // console.log(deepFormat(redeemInfo));
            assertWeb3Equal(redeemInfo.redemptionRequestId, redeemReq.requestId);
            assertWeb3Equal(redeemInfo.agentVault, redeemReq.agentVault);
            assertWeb3Equal(redeemInfo.redeemer, redeemReq.redeemer);
            assertWeb3Equal(redeemInfo.valueUBA, redeemReq.valueUBA);
            assertWeb3Equal(redeemInfo.feeUBA, redeemReq.feeUBA);
            assertWeb3Equal(redeemInfo.paymentAddress, redeemReq.paymentAddress);
            assertWeb3Equal(redeemInfo.paymentReference, redeemReq.paymentReference);
            assertWeb3Equal(redeemInfo.firstUnderlyingBlock, redeemReq.firstUnderlyingBlock);
            assertWeb3Equal(redeemInfo.lastUnderlyingBlock, redeemReq.lastUnderlyingBlock);
            assertWeb3Equal(redeemInfo.lastUnderlyingTimestamp, redeemReq.lastUnderlyingTimestamp);
            assertWeb3Equal(redeemInfo.executor, redeemReq.executor);
            assertWeb3Equal(redeemInfo.executorFeeNatWei, redeemReq.executorFeeNatWei);
            assertWeb3Equal(redeemInfo.status, 0);
            assertWeb3Equal(redeemInfo.poolSelfClose, false);
            assertWeb3Equal(redeemInfo.transferToCoreVault, false);
            // default
            context.skipToExpiration(redeemReq.lastUnderlyingBlock, redeemReq.lastUnderlyingTimestamp);
            await redeemer.redemptionPaymentDefault(redeemReq);
            // info should still return, but status is now DEFAULTED
            const redeemInfo2 = await context.assetManager.redemptionRequestInfo(redeemReq.requestId);
            assertWeb3Equal(redeemInfo2.redemptionRequestId, redeemReq.requestId);
            assertWeb3Equal(redeemInfo2.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // now pay too late and confirm payment
            await agent.performRedemptions([redeemReq]);
            // info should now show FAILED state
            const redeemInfo3 = await context.assetManager.redemptionRequestInfo(redeemReq.requestId);
            assertWeb3Equal(redeemInfo3.status, RedemptionRequestStatus.DEFAULTED_FAILED);
        });

        it("collateral reservation and redemption info revert if the id isn't valid", async () => {
            await expectRevert.custom(context.assetManager.collateralReservationInfo(100), "InvalidCrtId", []);
        });
    });
});
