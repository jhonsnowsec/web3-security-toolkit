import { EventScope } from "../../../lib/utils/events/ScopedEvents";
import { BN_ZERO, ZERO_ADDRESS, formatBN, toWei } from "../../../lib/utils/helpers";
import { CollateralPoolInstance, CollateralPoolTokenInstance } from "../../../typechain-truffle";
import { AsyncLock, coinFlip, randomBN, randomChoice } from "../../../lib/test-utils/simulation-utils";
import { SimulationActor } from "./SimulationActor";
import { RedemptionPaymentReceiver } from "./SimulationCustomer";
import { SimulationRunner } from "./SimulationRunner";

const MIN_POOL_ENTER_EXIT = toWei(1);

interface PoolInfo {
    pool: CollateralPoolInstance;
    poolToken: CollateralPoolTokenInstance;
}

export class SimulationPoolTokenHolder extends SimulationActor {
    constructor(
        public runner: SimulationRunner,
        public address: string,
        public underlyingAddress: string,
    ) {
        super(runner);
    }

    lock = new AsyncLock();

    poolInfo?: PoolInfo;

    async enter(scope: EventScope) {
        await this.lock.run(async () => {
            if (!this.poolInfo) {
                const agent = randomChoice(Array.from(this.state.agents.values()));
                try {
                    this.poolInfo = {
                        pool: this.getContract<CollateralPoolInstance>(agent.collateralPoolAddress),
                        poolToken: this.getContract<CollateralPoolTokenInstance>(agent.collateralPoolTokenAddress),
                    };
                } catch (error) {
                    scope.exitOnExpectedError(error, ['Unknown contract address']); // possible when pool was just created
                }
            }
            const natPrice = this.state.prices.getNat();
            const lotSizeWei = natPrice.convertUBAToTokenWei(this.state.lotSize());
            const amount = randomBN(MIN_POOL_ENTER_EXIT, lotSizeWei.muln(3));
            this.comment(`${this.formatAddress(this.address)}: entering pool ${this.formatAddress(this.poolInfo.pool.address)} (${formatBN(amount)})`);
            await this.poolInfo.pool.enter({ from: this.address, value: amount })
                .catch(e => scope.exitOnExpectedError(e, ["InvalidAgentVaultAddress"]));
        });
    }

    async exit(scope: EventScope, full: boolean) {
        await this.lock.run(async () => {
            if (!this.poolInfo) return;
            const balance = await this.poolInfo.poolToken.nonTimelockedBalanceOf(this.address);
            const amount = full ? balance : randomBN(balance);
            if (amount.eq(BN_ZERO)) return;
            const amountFmt = amount.eq(balance) ? `full ${formatBN(balance)}` : `${formatBN(amount)} / ${formatBN(balance)}`;
            const selfCloseFAssetRequired = await this.poolInfo.pool.fAssetRequiredForSelfCloseExit(amount);
            if (selfCloseFAssetRequired.isZero()) {
                this.comment(`${this.formatAddress(this.address)}: exiting pool ${this.formatAddress(this.poolInfo.pool.address)} (${amountFmt})`);
                await this.poolInfo.pool.exit(amount, { from: this.address })
                    .catch(e => scope.exitOnExpectedError(e, ["CollateralRatioFallsBelowExitCR"]));
            } else {
                const redeemToCollateral = coinFlip(0.1);   // it will usually redeem to collateral anyway, because amount is typically < 1 lot
                this.comment(`${this.formatAddress(this.address)}: self-close exiting pool ${this.formatAddress(this.poolInfo.pool.address)} (${amountFmt}), fassets=${formatBN(selfCloseFAssetRequired)}, toCollateral=${redeemToCollateral}`);
                await this.runner.fAssetMarketplace.buy(scope, this.address, selfCloseFAssetRequired);
                await this.context.fAsset.approve(this.poolInfo.pool.address, selfCloseFAssetRequired, { from: this.address });
                const res = await this.poolInfo.pool.selfCloseExit(amount, redeemToCollateral, this.underlyingAddress, ZERO_ADDRESS, { from: this.address })
                    .catch(e => scope.exitOnExpectedError(e, ["FAssetAllowanceTooSmall", "FAssetBalanceTooLow"]));
                const redemptionRequest = this.runner.eventDecoder.findEventFrom(res, this.context.assetManager, 'RedemptionRequested');
                if (redemptionRequest) {
                    const redemptionPaymentReceiver = RedemptionPaymentReceiver.create(this.runner, this.address, this.underlyingAddress);
                    await redemptionPaymentReceiver.handleRedemption(scope, redemptionRequest.args);
                }
            }
            // if full exit was performed, we can later join different pool
            if (amount.eq(balance)) {
                this.poolInfo = undefined;
            }
        }).catch(e => {
            scope.exitOnExpectedError(e, ["InvalidAgentVaultAddress"]);
        });
    }
}
