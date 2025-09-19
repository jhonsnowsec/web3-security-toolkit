import { LiquidationEnded, LiquidationStarted } from "../../../typechain-truffle/IIAssetManager";
import { EventArgs } from "../../utils/events/common";
import { filterEvents, findEvent, optionalEventArgs, requiredEventArgs } from "../../utils/events/truffle";
import { BN_ZERO, BNish, toBN } from "../../utils/helpers";
import { Agent } from "./Agent";
import { AssetContext, AssetContextClient } from "./AssetContext";

export class Liquidator extends AssetContextClient {
    static deepCopyWithObjectCreate = true;

    constructor(
        context: AssetContext,
        public address: string
    ) {
        super(context);
    }

    static async create(ctx: AssetContext, address: string) {
        // create object
        return new Liquidator(ctx, address);
    }

    async startLiquidation(agent: Agent): Promise<BNish> {
        const res = await this.assetManager.startLiquidation(agent.agentVault.address, { from: this.address });
        const liquidationStarted = findEvent(res, 'LiquidationStarted');
        if (!liquidationStarted) assert.fail("Missing liquidation start event");
        assert.equal(liquidationStarted.args.agentVault, agent.agentVault.address);
        return liquidationStarted.args.timestamp;
    }

    async liquidate(agent: Agent, amountUBA: BNish): Promise<[liquidatedValueUBA: BN, blockTimestamp: BNish, liquidationStarted: EventArgs<LiquidationStarted> | undefined, liquidationCancelled: EventArgs<LiquidationEnded> | undefined, dustChangesUBA: BN[]]> {
        const res = await this.assetManager.liquidate(agent.agentVault.address, amountUBA, { from: this.address });
        const liquidationPerformed = optionalEventArgs(res, 'LiquidationPerformed');
        const dustChangedEvents = filterEvents(res, 'DustChanged').map(e => e.args);
        if (liquidationPerformed) {
            assert.equal(liquidationPerformed.agentVault, agent.agentVault.address);
            assert.equal(liquidationPerformed.liquidator, this.address);
        }
        const tr = await web3.eth.getTransaction(res.tx);
        const block = await web3.eth.getBlock(tr.blockHash!);
        return [liquidationPerformed?.valueUBA ?? BN_ZERO, block.timestamp, optionalEventArgs(res, 'LiquidationStarted'), optionalEventArgs(res, 'LiquidationEnded'), dustChangedEvents.map(dc => dc.dustUBA)];
    }

    async endLiquidation(agent: Agent) {
        const res = await this.assetManager.endLiquidation(agent.agentVault.address, { from: this.address });
        assert.equal(requiredEventArgs(res, 'LiquidationEnded').agentVault, agent.agentVault.address);
    }

    async getLiquidationRewardPool(liquidatedAmountUBA: BNish, factorBIPS: BNish) {
        const liquidatedAmountAMG = this.context.convertUBAToAmg(liquidatedAmountUBA);
        const priceNAT = await this.context.getCollateralPrice(this.context.collaterals[0]);
        return priceNAT.convertAmgToTokenWei(toBN(liquidatedAmountAMG).mul(toBN(factorBIPS)).divn(10_000));
    }

    async getLiquidationFactorBIPS(liquidationStartedAt: BNish, liquidationPerformedAt: BNish) {
        // calculate premium step based on time since liquidation started
        const liquidationStart = toBN(liquidationStartedAt);
        const startTs = toBN(liquidationPerformedAt);
        const step = Math.min(this.context.settings.liquidationCollateralFactorBIPS.length - 1,
            startTs.sub(liquidationStart).div(toBN(this.context.settings.liquidationStepSeconds)).toNumber());
        // premiums are expressed as percentage of minCollateralRatio
        return toBN(this.context.settings.liquidationCollateralFactorBIPS[step]);
    }

    async getLiquidationRewardVaultCollateral(liquidatedAmountUBA: BNish, factorBIPS: BNish) {
        const liquidatedAmountAMG = this.context.convertUBAToAmg(liquidatedAmountUBA);
        const priceVaultCollateral = await this.context.getCollateralPrice(this.context.collaterals[1]);
        return priceVaultCollateral.convertAmgToTokenWei(toBN(liquidatedAmountAMG).mul(toBN(factorBIPS)).divn(10_000));
    }

    async getLiquidationFactorBIPSVaultCollateral(collateralRatioBIPS: BNish, liquidationStartedAt: BNish, liquidationPerformedAt: BNish) {
        // calculate premium step based on time since liquidation started
        const liquidationStart = toBN(liquidationStartedAt);
        const startTs = toBN(liquidationPerformedAt);
        const step = Math.min(this.context.settings.liquidationFactorVaultCollateralBIPS.length - 1,
            startTs.sub(liquidationStart).div(toBN(this.context.settings.liquidationStepSeconds)).toNumber());
        // premiums are expressed as percentage of minCollateralRatio
        const factorBIPS = toBN(this.context.settings.liquidationFactorVaultCollateralBIPS[step]);
        // max premium is equal to agents collateral ratio (so that all liquidators get at least this much)
        return factorBIPS.lt(toBN(collateralRatioBIPS)) ? factorBIPS : toBN(collateralRatioBIPS);
    }

    // notice: doesn't cap the factor at pool's CR
    async getLiquidationFactorBIPSPool(collateralRatioBIPS: BNish, liquidationStartedAt: BNish, liquidationPerformedAt: BNish) {
        const liquidationFactor = await this.getLiquidationFactorBIPS(liquidationStartedAt, liquidationPerformedAt);
        const liquidationFactorVaultCollateral = await this.getLiquidationFactorBIPSVaultCollateral(collateralRatioBIPS, liquidationStartedAt, liquidationPerformedAt);
        return liquidationFactor.sub(liquidationFactorVaultCollateral);
    }
}
