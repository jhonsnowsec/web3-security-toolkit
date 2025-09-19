import BN from "bn.js";
import { closeSync } from "fs";
import { AgentInfo, AgentStatus, CollateralClass, CollateralType } from "../../../lib/fasset/AssetManagerTypes";
import { NAT_WEI } from "../../../lib/fasset/Conversions";
import { CollateralPoolEvents, CollateralPoolTokenEvents } from "../../../lib/fasset/IAssetContext";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Prices } from "../../../lib/state/Prices";
import { InitialAgentData, TrackedAgentState } from "../../../lib/state/TrackedAgentState";
import { ITransaction } from "../../../lib/underlying-chain/interfaces/IBlockChain";
import { EvmEventArgs } from "../../../lib/utils/events/IEvmEvents";
import { EvmEvent } from "../../../lib/utils/events/common";
import { ContractWithEvents } from "../../../lib/utils/events/truffle";
import { openNewFile } from "../../../lib/utils/file-utils";
import { BN_ZERO, expectErrors, formatBN, latestBlockTimestamp, sumBN, toBN, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { ILogger } from "../../../lib/utils/logging";
import { CollateralPoolInstance, CollateralPoolTokenInstance } from "../../../typechain-truffle";
import { CPEntered, CPExited, CPFeeDebtChanged } from "../../../typechain-truffle/CollateralPool";
import {
    AgentAvailable, AvailableAgentExited, CollateralReservationDeleted, CollateralReserved, DustChanged, LiquidationPerformed, MintingExecuted, MintingPaymentDefault,
    RedeemedInCollateral, RedemptionDefault, RedemptionPaymentBlocked, RedemptionPaymentFailed, RedemptionPerformed, RedemptionPoolFeeMinted, RedemptionRequested, RedemptionTicketCreated,
    RedemptionTicketDeleted, RedemptionTicketUpdated, ReturnFromCoreVaultCancelled, ReturnFromCoreVaultConfirmed, ReturnFromCoreVaultRequested, SelfClose, SelfMint, TransferToCoreVaultDefaulted, TransferToCoreVaultStarted, TransferToCoreVaultSuccessful, UnderlyingBalanceToppedUp, UnderlyingWithdrawalAnnounced, UnderlyingWithdrawalCancelled, UnderlyingWithdrawalConfirmed
} from "../../../typechain-truffle/IIAssetManager";
import { SparseArray } from "../../../lib/test-utils/SparseMatrix";
import { BalanceTrackingList, BalanceTrackingRow } from "./AgentBalanceTracking";
import { SimulationState, SimulationStateLogRecord } from "./SimulationState";
import { SimulationStateComparator } from "./SimulationStateComparator";

export interface CollateralReservation {
    id: number;
    agentVault: string;
    minter: string;
    valueUBA: BN;
    feeUBA: BN;
    lastUnderlyingBlock: BN;
    lastUnderlyingTimestamp: BN;
    paymentAddress: string;
    paymentReference: string;
}

export interface ReturnFromCoreVault {
    id: number;
    agentVault: string;
    valueUBA: BN;
}

export interface RedemptionTicket {
    id: number;
    agentVault: string;
    amountUBA: BN;
}

export interface RedemptionRequest {
    id: number;
    agentVault: string;
    valueUBA: BN;
    feeUBA: BN;
    lastUnderlyingBlock: BN;
    lastUnderlyingTimestamp: BN;
    paymentAddress: string;
    paymentReference: string;
    poolSelfClose: boolean;
    // stateful part
    collateralReleased: boolean;
    underlyingReleased: boolean;
}

type UnderlyingBalanceChangeType = 'minting' | 'redemption' | 'topup' | 'withdrawal' | 'coreVaultReturn';

export interface UnderlyingBalanceChange {
    type: UnderlyingBalanceChangeType,
    amountUBA: BN,
}

const CollateralPool = artifacts.require("CollateralPool");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");

export class SimulationAgentState extends TrackedAgentState {
    constructor(
        parent: SimulationState,
        data: InitialAgentData,
    ) {
        super(parent, data);
        void this.initializePoolState();    // must be called async
    }

    override parent!: SimulationState;

    // collections
    collateralReservations: Map<number, CollateralReservation> = new Map();
    redemptionTickets: Map<number, RedemptionTicket> = new Map();
    redemptionTicketsLastUpdateAt: Map<number, number> = new Map();
    redemptionRequests: Map<number, RedemptionRequest> = new Map();
    underlyingBalanceChanges: UnderlyingBalanceChange[] = [];
    returnsFromCoreVault: Map<number, ReturnFromCoreVault> = new Map();

    // pool data
    poolTokenBalances = new SparseArray();
    poolFeeDebt = new SparseArray();
    lastPoolFeeDebtChange = new Map<string, number>();

    // log
    actionLog: SimulationStateLogRecord[] = [];
    balanceTrackingList = new BalanceTrackingList();

    // getters

    get totalPoolFee() {
        return this.parent.fAssetBalance.get(this.collateralPoolAddress);
    }

    get totalAgentPoolTokensWei() {
        return this.poolTokenBalances.get(this.address);
    }

    // init

    override initializeState(agentInfo: AgentInfo) {
        super.initializeState(agentInfo);
        this.poolTokenBalances.set(this.address, agentInfo.totalAgentPoolTokensWei);
    }

    async initializePoolState() {
        const collateralPool: ContractWithEvents<CollateralPoolInstance, CollateralPoolEvents> = await CollateralPool.at(this.collateralPoolAddress);
        const collateralPoolToken: ContractWithEvents<CollateralPoolTokenInstance, CollateralPoolTokenEvents> = await CollateralPoolToken.at(this.collateralPoolTokenAddress);
        // pool eneter and exit event
        this.parent.truffleEvents.event(collateralPool, 'CPEntered').immediate().subscribe(args => this.handlePoolEnter(args));
        this.parent.truffleEvents.event(collateralPool, 'CPExited').immediate().subscribe(args => this.handlePoolExit(args));
        this.parent.truffleEvents.event(collateralPool, 'CPFeeDebtChanged').immediate().subscribe(args => this.handleFeeDebtChanged(args));
        // pool token transfer event
        this.parent.truffleEvents.event(collateralPoolToken, 'Transfer').immediate().subscribe(args => {
            this.handlePoolTokenTransfer(args.from, args.to, toBN(args.value));
        });
    }

    // handlers: agent availability

    override handleAgentAvailable(args: EvmEventArgs<AgentAvailable>) {
        super.handleAgentAvailable(args);
    }

    override handleAvailableAgentExited(args: EvmEventArgs<AvailableAgentExited>) {
        super.handleAvailableAgentExited(args);
    }

    // handlers: minting

    override handleCollateralReserved(args: EvmEventArgs<CollateralReserved>) {
        super.handleCollateralReserved(args);
        this.addCollateralReservation(args);
    }

    override handleMintingExecuted(args: EvmEventArgs<MintingExecuted>) {
        super.handleMintingExecuted(args);
        // update underlying free balance
        const depositUBA = toBN(args.mintedAmountUBA).add(args.agentFeeUBA).add(args.poolFeeUBA);
        this.addUnderlyingBalanceChange(args.$event, 'minting', depositUBA);
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.collateralReservationId, mintAmount: args.mintedAmountUBA, mintFeeAgent: args.agentFeeUBA, mintFeePool: args.poolFeeUBA });
        // delete collateral reservation
        const collateralReservationId = Number(args.collateralReservationId);
        if (collateralReservationId > 0) {  // collateralReservationId == 0 for self-minting
            this.deleteCollateralReservation(args.$event, collateralReservationId);
        }
    }

    override handleSelfMint(args: EvmEventArgs<SelfMint>) {
        super.handleSelfMint(args);
        // update underlying free balance
        const depositUBA = toBN(args.depositedAmountUBA);
        this.addUnderlyingBalanceChange(args.$event, 'minting', depositUBA);
        // update balance tracking
        const mintFeeAgent = depositUBA.sub(toBN(args.poolFeeUBA));
        this.addBalanceTrackingRow(args.$event, { requestId: "0", mintAmount: args.mintedAmountUBA, mintFeeAgent: mintFeeAgent, mintFeePool: args.poolFeeUBA });
    }

    override handleMintingPaymentDefault(args: EvmEventArgs<MintingPaymentDefault>) {
        super.handleMintingPaymentDefault(args);
        this.deleteCollateralReservation(args.$event, Number(args.collateralReservationId));
    }

    override handleCollateralReservationDeleted(args: EvmEventArgs<CollateralReservationDeleted>) {
        super.handleCollateralReservationDeleted(args);
        this.deleteCollateralReservation(args.$event, Number(args.collateralReservationId));
    }

    // handlers: redemption and self-close

    override handleRedemptionRequested(args: EvmEventArgs<RedemptionRequested>): void {
        super.handleRedemptionRequested(args);
        // create request and close tickets
        const request = this.addRedemptionRequest(args);
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: request.id, redemptionRequested: args.valueUBA, redeeming: args.valueUBA, redemptionFee: args.feeUBA });
        this.logAction(`new RedemptionRequest(${request.id}): amount=${formatBN(request.valueUBA)} fee=${formatBN(request.feeUBA)}`, args.$event);
    }

    override handleRedemptionPerformed(args: EvmEventArgs<RedemptionPerformed>): void {
        super.handleRedemptionPerformed(args);
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.requestId, redeeming: toBN(args.redemptionAmountUBA).neg(), redemptionSpent: args.spentUnderlyingUBA });
        this.confirmRedemptionPayment('performed', args)
    }

    override handleRedemptionPaymentFailed(args: EvmEventArgs<RedemptionPaymentFailed>): void {
        super.handleRedemptionPaymentFailed(args);
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.requestId, redemptionSpent: args.spentUnderlyingUBA });
        this.confirmRedemptionPayment('failed', args)
    }

    override handleRedemptionPaymentBlocked(args: EvmEventArgs<RedemptionPaymentBlocked>): void {
        super.handleRedemptionPaymentBlocked(args);
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.requestId, redeeming: toBN(args.redemptionAmountUBA).neg(), redemptionSpent: args.spentUnderlyingUBA });
        this.confirmRedemptionPayment('blocked', args)
    }

    override handleRedemptionDefault(args: EvmEventArgs<RedemptionDefault>): void {
        super.handleRedemptionDefault(args);
        // release request
        const request = this.getRedemptionRequest(Number(args.requestId));
        request.collateralReleased = true;
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.requestId, redeeming: toBN(args.redemptionAmountUBA).neg() });
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    override handleRedemptionPoolFeeMinted(args: EvmEventArgs<RedemptionPoolFeeMinted>): void {
        super.handleRedemptionPoolFeeMinted(args);
        this.addBalanceTrackingRow(args.$event, { mintFeePool: args.poolFeeUBA });
    }

    override handleRedeemedInCollateral(args: EvmEventArgs<RedeemedInCollateral>): void {
        super.handleRedeemedInCollateral(args);
        this.addBalanceTrackingRow(args.$event, { redemptionRequested: args.redemptionAmountUBA });
    }

    override handleSelfClose(args: EvmEventArgs<SelfClose>): void {
        super.handleSelfClose(args);
        this.addBalanceTrackingRow(args.$event, { selfClose: args.valueUBA });
    }

    // handlers: tickets

    override handleRedemptionTicketCreated(args: EvmEventArgs<RedemptionTicketCreated>): void {
        super.handleRedemptionTicketCreated(args);
        this.addRedemptionTicket(args.$event, Number(args.redemptionTicketId), toBN(args.ticketValueUBA));
    }

    override handleRedemptionTicketUpdated(args: EvmEventArgs<RedemptionTicketUpdated>): void {
        super.handleRedemptionTicketUpdated(args);
        this.updateRedemptionTicket(args.$event, Number(args.redemptionTicketId), toBN(args.ticketValueUBA));
    }

    override handleRedemptionTicketDeleted(args: EvmEventArgs<RedemptionTicketDeleted>): void {
        super.handleRedemptionTicketDeleted(args);
        this.deleteRedemptionTicket(args.$event, Number(args.redemptionTicketId));
    }

    // handlers: dust

    override handleDustChanged(args: EvmEventArgs<DustChanged>): void {
        const prevDustUBA = this.dustUBA;
        super.handleDustChanged(args);
        // log change
        const change = this.dustUBA.sub(prevDustUBA);
        this.logAction(`dust changed by ${change}, new dust=${formatBN(this.dustUBA)}`, args.$event);
    }

    // handlers: underlying withdrawal

    override handleUnderlyingWithdrawalAnnounced(args: EvmEventArgs<UnderlyingWithdrawalAnnounced>): void {
        this.expect(this.announcedUnderlyingWithdrawalId.isZero(), `underlying withdrawal announcement made twice`, args.$event);
        super.handleUnderlyingWithdrawalAnnounced(args);
    }

    override handleUnderlyingWithdrawalConfirmed(args: EvmEventArgs<UnderlyingWithdrawalConfirmed>): void {
        this.expect(this.announcedUnderlyingWithdrawalId.eq(args.announcementId), `underlying withdrawal id mismatch`, args.$event);
        super.handleUnderlyingWithdrawalConfirmed(args);
        this.addUnderlyingBalanceChange(args.$event, 'withdrawal', toBN(args.spentUBA).neg());
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { requestId: args.announcementId, withdraw: args.spentUBA });
    }

    override handleUnderlyingWithdrawalCancelled(args: EvmEventArgs<UnderlyingWithdrawalCancelled>): void {
        this.expect(this.announcedUnderlyingWithdrawalId.eq(args.announcementId), `underlying withdrawal id mismatch`, args.$event);
        super.handleUnderlyingWithdrawalCancelled(args);
    }

    override handleUnderlyingBalanceToppedUp(args: EvmEventArgs<UnderlyingBalanceToppedUp>): void {
        super.handleUnderlyingBalanceToppedUp(args);
        this.addUnderlyingBalanceChange(args.$event, 'topup', toBN(args.depositedUBA));
        // update balance tracking
        this.addBalanceTrackingRow(args.$event, { topup: args.depositedUBA });
    }

    // handlers: liquidation

    override handleLiquidationPerformed(args: EvmEventArgs<LiquidationPerformed>): void {
        super.handleLiquidationPerformed(args);
    }

    // handlers: core vault

    override handleTransferToCoreVaultStarted(args: EvmEventArgs<TransferToCoreVaultStarted>): void {
        super.handleTransferToCoreVaultStarted(args);
    }

    override handleTransferToCoreVaultSuccessful(args: EvmEventArgs<TransferToCoreVaultSuccessful>): void {
        super.handleTransferToCoreVaultSuccessful(args);
    }

    override handleTransferToCoreVaultDefaulted(args: EvmEventArgs<TransferToCoreVaultDefaulted>): void {
        super.handleTransferToCoreVaultDefaulted(args);
    }

    override handleReturnFromCoreVaultRequested(args: EvmEventArgs<ReturnFromCoreVaultRequested>): void {
        super.handleReturnFromCoreVaultRequested(args);
        this.returnsFromCoreVault.set(Number(args.requestId), { id: Number(args.requestId), agentVault: args.agentVault, valueUBA: toBN(args.valueUBA) });
    }

    override handleReturnFromCoreVaultConfirmed(args: EvmEventArgs<ReturnFromCoreVaultConfirmed>): void {
        super.handleReturnFromCoreVaultConfirmed(args);
        this.returnsFromCoreVault.delete(Number(args.requestId));
        this.addUnderlyingBalanceChange(args.$event, 'coreVaultReturn', toBN(args.remintedUBA));
    }

    override handleReturnFromCoreVaultCancelled(args: EvmEventArgs<ReturnFromCoreVaultCancelled>): void {
        super.handleReturnFromCoreVaultCancelled(args);
        this.returnsFromCoreVault.delete(Number(args.requestId));
    }


    // handlers: underlying transactions

    handleTransactionFromUnderlying(transaction: ITransaction) {
        this.logAction(`underlying withdraw amount=${formatBN(transaction.outputs[0][1])} to=${transaction.outputs[0][0]}`, "UNDERLYING_TRANSACTION");
        // update balance tracking
        const [operation, requestId] = this.underlyingOperationText(transaction.reference, "unknown underlying withdrawal");
        for (const [address, amount] of transaction.outputs) {
            this.addBalanceTrackingRow(null, { operation, requestId, underlyingWithdraw: amount });
        }
    }

    handleTransactionToUnderlying(transaction: ITransaction) {
        this.logAction(`underlying deposit amount=${formatBN(transaction.outputs[0][1])} from=${transaction.inputs[0][0]}`, "UNDERLYING_TRANSACTION");
        // update balance tracking
        const [operation, requestId] = this.underlyingOperationText(transaction.reference, "unknown underlying deposit");
        for (const [address, amount] of transaction.outputs) {
            this.addBalanceTrackingRow(null, { operation, requestId, underlyingDeposit: amount });
        }
    }

    private underlyingOperations: Record<number, string> = {
        0x0001: "minting", 0x0002: "redemption", 0x0003: "announced withdrawal",
        0x0011: "topup", 0x0012: "self mint", 0x0013: "address ownership proof",
    }

    private underlyingOperationText(paymentReference: string | null, defaultText: string): [string, string | null] {
        if (!PaymentReference.isValid(paymentReference)) return [defaultText, null];
        const type = PaymentReference.decodeTypeIndex(paymentReference);
        const idBN = PaymentReference.decodeId(paymentReference);
        const id = type >= 0x10 ? null : String(idBN);
        return ['underlying ' + this.underlyingOperations[type], id];
    }

    // handlers: pool enter and exit

    handlePoolEnter(args: EvmEventArgs<CPEntered>): void {
        // const debtChange = this.calculatePoolFeeDebtChange(toBN(args.receivedTokensWei), toBN(args.addedFAssetFeesUBA));
        // this.poolFeeDebt.addTo(args.tokenHolder, debtChange);
    }

    handlePoolExit(args: EvmEventArgs<CPExited>): void {
        // const debtChange = this.calculatePoolFeeDebtChange(toBN(args.burnedTokensWei).neg(), toBN(args.receviedFAssetFeesUBA).neg());
        // this.poolFeeDebt.addTo(args.tokenHolder, debtChange);
    }

    handleFeeDebtChanged(args: EvmEventArgs<CPFeeDebtChanged>): void {
        const eventAt = this.calcBlockIndex(args.$event);
        const lastChangeAt = this.lastPoolFeeDebtChange.get(args.tokenHolder) ?? -1;
        if (eventAt > lastChangeAt) {
            this.poolFeeDebt.set(args.tokenHolder, toBN(args.newFeeDebtUBA));
            this.lastPoolFeeDebtChange.set(args.tokenHolder, eventAt);
        } else {
            this.parent.logger?.log(`???? ISSUE poolFeeDebt[${args.tokenHolder}] not changed due to inconsistent event ordering: prev change at ${lastChangeAt}, this change at ${eventAt}`);
        }
    }

    private calculatePoolFeeDebtChange(receivedPoolTokens: BN, sentFAssets: BN) {
        // pool enter and exit events happen after pool tokens and fees are sent or recieved, so we have to
        // calculate the totals before pool tokens were issued/burned and f-assets were sent in/out
        const totalPoolTokens = this.poolTokenBalances.total().sub(receivedPoolTokens);
        const totalPoolFees = this.totalPoolFee.sub(sentFAssets);
        const totalFeeDebt = this.poolFeeDebt.total();
        // calculate virtual fee
        const totalVirtualFees = totalPoolFees.add(totalFeeDebt);
        const virtualFeeDebtChange = totalVirtualFees.isZero() ? BN_ZERO : totalVirtualFees.mul(receivedPoolTokens).div(totalPoolTokens);
        return virtualFeeDebtChange.sub(sentFAssets);   // part is paid by sent f-assets
    }

    // handlers: pool token transfer

    handlePoolTokenTransfer(from: string, to: string, amount: BN) {
        if (from !== ZERO_ADDRESS) {
            this.poolTokenBalances.addTo(from, amount.neg());
        }
        if (to !== ZERO_ADDRESS) {
            this.poolTokenBalances.addTo(to, amount);
        }
    }

    // handlers: pool fasset fee transfer

    handlePoolFeeDeposit(from: string, amount: BN) {
    }

    handlePoolFeeWithdrawal(to: string, amount: BN) {
    }

    // agent state changing

    private addBalanceTrackingRow(event: EvmEvent | null, data: Partial<BalanceTrackingRow>) {
        const block = event?.blockNumber ?? null;
        const operation = event?.event ?? "?";
        const trackedMinted = this.mintedUBA;
        const trackedRedeeming = this.redeemingUBA;
        const trackedAccountedUnderlying = this.underlyingBalanceUBA;
        this.balanceTrackingList.addRow({ block, operation, trackedMinted, trackedRedeeming, trackedAccountedUnderlying, ...data });
    }

    newCollateralReservation(args: EvmEventArgs<CollateralReserved>): CollateralReservation {
        return {
            id: Number(args.collateralReservationId),
            agentVault: args.agentVault,
            minter: args.minter,
            valueUBA: toBN(args.valueUBA),
            feeUBA: toBN(args.feeUBA),
            lastUnderlyingBlock: toBN(args.lastUnderlyingBlock),
            lastUnderlyingTimestamp: toBN(args.lastUnderlyingTimestamp),
            paymentAddress: args.paymentAddress,
            paymentReference: args.paymentReference,
        };
    }

    addCollateralReservation(args: EvmEventArgs<CollateralReserved>) {
        const cr = this.newCollateralReservation(args);
        this.collateralReservations.set(cr.id, cr);
        this.logAction(`new CollateralReservation(${cr.id}): amount=${formatBN(cr.valueUBA)} fee=${formatBN(cr.feeUBA)}`, args.$event);
    }

    deleteCollateralReservation(event: EvmEvent, crId: number) {
        const cr = this.collateralReservations.get(crId);
        if (!cr) assert.fail(`Invalid collateral reservation id ${crId}`);
        this.logAction(`delete CollateralReservation(${cr.id}): amount=${formatBN(cr.valueUBA)}`, event);
        this.collateralReservations.delete(crId);
    }

    newRedemptionTicket(ticketId: number, amountUBA: BN): RedemptionTicket {
        return {
            id: ticketId,
            agentVault: this.address,
            amountUBA: amountUBA
        };
    }

    addNewRedemptionTicket(event: EvmEvent, ticketId: number, amountUBA: BN) {
        const ticket = this.newRedemptionTicket(ticketId, amountUBA);
        this.redemptionTickets.set(ticket.id, ticket);
        this.logAction(`new RedemptionTicket(${ticket.id}): amount=${formatBN(ticket.amountUBA)}`, event);
    }

    addRedemptionTicket(event: EvmEvent, ticketId: number, amountUBA: BN) {
        this.performRedemptionTicketChange(event, ticketId, "addRedemptionTicket", () => {
            this.addNewRedemptionTicket(event, ticketId, amountUBA);
        });
    }

    updateRedemptionTicket(event: EvmEvent, ticketId: number, amountUBA: BN) {
        this.performRedemptionTicketChange(event, ticketId, "updateRedemptionTicket", () => {
            const ticket = this.redemptionTickets.get(ticketId);
            if (ticket) {
                ticket.amountUBA = amountUBA;
                this.logAction(`updated RedemptionTicket(${ticket.id}): oldAmount=${formatBN(ticket.amountUBA)} amount=${formatBN(amountUBA)}`, event);
            } else {
                this.parent.logger?.log(`???? ISSUE ticket ${ticketId} update before add due to inconsistent event ordering`);
                this.addNewRedemptionTicket(event, ticketId, amountUBA);
            }
    });
    }

    deleteRedemptionTicket(event: EvmEvent, ticketId: number) {
        this.performRedemptionTicketChange(event, ticketId, "deleteRedemptionTicket", () => {
            const ticket = this.redemptionTickets.get(ticketId);
            if (ticket) {
                this.redemptionTickets.delete(ticketId);
                this.logAction(`deleted RedemptionTicket(${ticket.id}): amount=${formatBN(ticket.amountUBA)}`, event);
            } else {
                this.parent.logger?.log(`???? ISSUE ticket ${ticketId} delete before add due to inconsistent event ordering`);
            }
        });
    }

    performRedemptionTicketChange(event: EvmEvent, ticketId: number, name: string, action: () => void) {
        const eventAt = this.calcBlockIndex(event);
        const lastChangeAt = this.redemptionTicketsLastUpdateAt.get(ticketId) ?? 0;
        if (eventAt > lastChangeAt) {
            action();
            this.redemptionTicketsLastUpdateAt.set(ticketId, eventAt);
        } else {
            this.parent.logger?.log(`???? ISSUE ${name} not executed due to inconsistent event ordering: prev change at ${lastChangeAt}, this change at ${eventAt}`);
        }
    }

    newRedemptionRequest(args: EvmEventArgs<RedemptionRequested>): RedemptionRequest {
        return {
            id: Number(args.requestId),
            agentVault: args.agentVault,
            valueUBA: toBN(args.valueUBA),
            feeUBA: toBN(args.feeUBA),
            lastUnderlyingBlock: toBN(args.lastUnderlyingBlock),
            lastUnderlyingTimestamp: toBN(args.lastUnderlyingTimestamp),
            paymentAddress: args.paymentAddress,
            paymentReference: args.paymentReference,
            poolSelfClose: this.isPoolSelfCloseRedemption(args.requestId),
            collateralReleased: false,
            underlyingReleased: false,
        };
    }

    addRedemptionRequest(args: EvmEventArgs<RedemptionRequested>) {
        const request = this.newRedemptionRequest(args);
        if (this.redemptionRequests.has(request.id)) assert.fail(`Duplicate redemption request id ${request.id}`);
        this.redemptionRequests.set(request.id, request);
        return request;
    }

    getRedemptionRequest(requestId: number) {
        return this.redemptionRequests.get(requestId) ?? assert.fail(`Invalid redemption request id ${requestId}`);
    }

    confirmRedemptionPayment(type: 'performed' | 'failed' | 'blocked', args: { $event: EvmEvent, requestId: BN, spentUnderlyingUBA: BN }) {
        // update underlying balance
        this.addUnderlyingBalanceChange(args.$event, 'redemption', toBN(args.spentUnderlyingUBA).neg());
        // release request
        const request = this.getRedemptionRequest(Number(args.requestId));
        if (type === 'performed' || type === 'blocked') {
            request.collateralReleased = true;
        }
        request.underlyingReleased = true;
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    releaseClosedRedemptionRequests(event: EvmEvent, request: RedemptionRequest) {
        if (request.collateralReleased && request.underlyingReleased) {
            this.redemptionRequests.delete(request.id);
            this.logAction(`delete RedemptionRequest(${request.id}): amount=${formatBN(request.valueUBA)}`, event);
        }
    }

    addUnderlyingBalanceChange(event: EvmEvent, type: UnderlyingBalanceChangeType, amountUBA: BN) {
        const change: UnderlyingBalanceChange = { type, amountUBA };
        this.underlyingBalanceChanges.push(change);
        this.logAction(`new UnderlyingBalanceChange(${type}): amount=${formatBN(amountUBA)}`, event);
    }

    // totals

    calculateReservedUBA() {
        return sumBN(this.collateralReservations.values(), ticket => ticket.valueUBA.add(this.calculatePoolFee(ticket.feeUBA)));
    }

    calculateMintedUBA() {
        return sumBN(this.redemptionTickets.values(), ticket => ticket.amountUBA).add(this.dustUBA);
    }

    calculateRedeemingUBA() {
        return sumBN(this.redemptionRequests.values(), request => request.collateralReleased ? BN_ZERO : request.valueUBA);
    }

    calculatePoolRedeemingUBA() {
        return sumBN(this.redemptionRequests.values(), request => request.collateralReleased || request.poolSelfClose ? BN_ZERO : request.valueUBA);
    }

    calculateUnderlyingBalanceUBA() {
        return sumBN(this.underlyingBalanceChanges, change => change.amountUBA);
    }

    calculateFreeUnderlyingBalanceUBA() {
        const mintedUBA = this.calculateMintedUBA();
        const redeemingUBA = this.calculateRedeemingUBA();
        return this.calculateUnderlyingBalanceUBA().sub(mintedUBA).sub(redeemingUBA);
    }

    calculateTotalCoreVaultReturns() {
        return sumBN(this.returnsFromCoreVault.values(), ticket => ticket.valueUBA);
    }

    // calculations

    poolName() {
        return this.parent.eventFormatter.formatAddress(this.collateralPoolAddress);
    }

    private collateralRatioForPrice(prices: Prices, collateral: CollateralType) {
        const redeemingUBA = collateral.collateralClass === CollateralClass.VAULT ? this.redeemingUBA : this.poolRedeemingUBA;
        const backedAmount = (Number(this.reservedUBA) + Number(this.mintedUBA) + Number(redeemingUBA)) / Number(this.parent.settings.assetUnitUBA);
        if (backedAmount === 0) return Number.POSITIVE_INFINITY;
        const totalCollateralWei = collateral.collateralClass === CollateralClass.VAULT ? this.totalVaultCollateralWei : this.totalPoolCollateralNATWei;
        const totalCollateral = Number(totalCollateralWei) / Number(NAT_WEI);
        const assetToTokenPrice = prices.get(collateral).assetToTokenPriceNum();
        const backingCollateral = Number(backedAmount) * assetToTokenPrice;
        return totalCollateral / backingCollateral;
    }

    collateralRatio(collateral: CollateralType) {
        const ratio = this.collateralRatioForPrice(this.parent.prices, collateral);
        const ratioFromTrusted = this.collateralRatioForPrice(this.parent.trustedPrices, collateral);
        return Math.max(ratio, ratioFromTrusted);
    }

    // pool calculations

    calculateTotalPoolFeeDebt() {
        return this.poolFeeDebt.total();
    }

    calculateTotalVirtualPoolFees() {
        const totalDebt = this.poolFeeDebt.total();
        return this.totalPoolFee.add(totalDebt);
    }

    calculateVirtualFeesOf(address: string) {
        const totalVirtualFees = this.calculateTotalVirtualPoolFees();
        return totalVirtualFees.isZero() ? BN_ZERO : totalVirtualFees.mul(this.poolTokenBalances.get(address)).div(this.poolTokenBalances.total());
    }

    // checking

    async checkInvariants(checker: SimulationStateComparator) {
        const agentName = this.name();
        // get actual agent state
        // this.parent.logger?.log(`STARTING DIFFERENCE CHECK FOR ${agentName} - GET INFO`);
        const agentInfo = await this.parent.context.assetManager.getAgentInfo(this.address)
            .catch(e => expectErrors(e, ["InvalidAgentVaultAddress"]));
        if (!agentInfo) {
            checker.logger.log(`    ${agentName}: agent already destroyed.`);
            return;
        }
        // this.parent.logger?.log(`STARTING DIFFERENCE CHECK FOR ${agentName} - AFTER GET INFO`);
        // reserved
        const reservedUBA = this.calculateReservedUBA().add(this.calculateTotalCoreVaultReturns());
        checker.checkEquality(`${agentName}.reservedUBA`, agentInfo.reservedUBA, this.reservedUBA);
        checker.checkEquality(`${agentName}.reservedUBA.from_requests`, agentInfo.reservedUBA, reservedUBA);
        // minted
        const mintedUBA = this.calculateMintedUBA();
        checker.checkEquality(`${agentName}.mintedUBA`, agentInfo.mintedUBA, this.mintedUBA);
        checker.checkEquality(`${agentName}.mintedUBA.from_tickets`, agentInfo.mintedUBA, mintedUBA);
        // redeeming
        const redeemingUBA = this.calculateRedeemingUBA();
        checker.checkEquality(`${agentName}.redeemingUBA`, agentInfo.redeemingUBA, this.redeemingUBA);
        checker.checkEquality(`${agentName}.redeemingUBA.from_requests`, agentInfo.redeemingUBA, redeemingUBA);
        // poolRedeeming
        const poolRedeemingUBA = this.calculatePoolRedeemingUBA();
        checker.checkEquality(`${agentName}.poolRedeemingUBA`, agentInfo.poolRedeemingUBA, this.poolRedeemingUBA);
        checker.checkEquality(`${agentName}.poolRedeemingUBA.from_requests`, agentInfo.poolRedeemingUBA, poolRedeemingUBA);
        // free balance
        const freeUnderlyingBalanceUBA = this.calculateFreeUnderlyingBalanceUBA();
        checker.checkEquality(`${agentName}.underlyingFreeBalanceUBA`, agentInfo.freeUnderlyingBalanceUBA, this.freeUnderlyingBalanceUBA);
        checker.checkEquality(`${agentName}.underlyingFreeBalanceUBA.from_tickets_and_requests`, agentInfo.freeUnderlyingBalanceUBA, freeUnderlyingBalanceUBA);
        // pool fees
        const MAX_ERR = 10; // virtual fee calculation is approximate and may have rounding errors
        const collateralPool = await CollateralPool.at(this.collateralPoolAddress);
        const collateralPoolToken = await CollateralPoolToken.at(this.collateralPoolTokenAddress);
        const collateralPoolName = this.poolName();
        checker.checkEquality(`${collateralPoolName}.totalPoolFees`, await this.parent.context.fAsset.balanceOf(this.collateralPoolAddress), this.totalPoolFee);
        checker.checkEquality(`${collateralPoolName}.totalPoolTokens`, await collateralPoolToken.totalSupply(), this.poolTokenBalances.total());
        checker.checkEquality(`${collateralPoolName}.totalPoolFeeDebt`, await collateralPool.totalFAssetFeeDebt(), this.poolFeeDebt.total(), { maxDiff: MAX_ERR });
        for (const tokenHolder of this.poolTokenBalances.keys()) {
            const tokenHolderName = this.parent.eventFormatter.formatAddress(tokenHolder);
            checker.checkEquality(`${collateralPoolName}.poolTokensOf(${tokenHolderName})`, await collateralPoolToken.balanceOf(tokenHolder), this.poolTokenBalances.get(tokenHolder));
            const poolFeeDebt = await collateralPool.fAssetFeeDebtOf(tokenHolder);
            checker.checkEquality(`${collateralPoolName}.poolFeeDebtOf(${tokenHolderName})`, poolFeeDebt, this.poolFeeDebt.get(tokenHolder), { maxDiff: MAX_ERR });
            const virtualFees = await collateralPool.virtualFAssetOf(tokenHolder);
            checker.checkEquality(`${collateralPoolName}.virtualPoolFeesOf(${tokenHolderName})`, virtualFees, this.calculateVirtualFeesOf(tokenHolder), { maxDiff: MAX_ERR });
            checker.checkNumericDifference(`${collateralPoolName}.virtualPoolFeesOf(${tokenHolderName}) >= debt`, virtualFees, 'gte', poolFeeDebt, { maxDiff: MAX_ERR });
        }
        // minimum underlying backing (unless in full liquidation)
        if (this.status !== AgentStatus.FULL_LIQUIDATION && this.status !== AgentStatus.DESTROYING) {
            const underlyingBalanceUBA = await this.parent.context.chain.getBalance(this.underlyingAddressString);
            // don't count problems here because it results in false positive errors, e.g. if there is payment after redemption default
            checker.checkNumericDifference(`${agentName}.underlyingBalanceUBA`, underlyingBalanceUBA, 'gte', mintedUBA.add(freeUnderlyingBalanceUBA), { severe: false });
        }
        // status
        checker.checkStringEquality(`${agentName}.status`, agentInfo.status, this.status);
        // log
        // if (problems > 0) {
        //     this.writeActionLog(checker.logger);
        // }
    }

    // expectations and logs

    expect(condition: boolean, message: string, event: EvmEvent) {
        if (!condition) {
            const text = `expectation failed for ${this.name()}: ${message}`;
            this.parent.failedExpectations.push({ text, event });
        }
    }

    logAction(text: string, event: EvmEvent | string) {
        this.actionLog.push({ text, event });
    }

    writeActionLog(logger: ILogger) {
        logger.log(`    action log for ${this.name()}`);
        for (const log of this.actionLog) {
            logger.log(`        ${log.text}  ${typeof log.event === 'string' ? log.event : this.parent.eventInfo(log.event)}`);
        }
    }

    // info

    writePoolSummary(logger: ILogger) {
        logger.log(`    ${this.poolName()}:  wnat=${formatBN(this.totalPoolCollateralNATWei)}  poolTokens=${formatBN(this.poolTokenBalances.total())}` +
            `  fassetFees=${formatBN(this.totalPoolFee)}  feeDebt=${formatBN(this.poolFeeDebt.total())}  virtualFees=${formatBN(this.calculateTotalVirtualPoolFees())}`);
        for (const tokenHolder of this.poolTokenBalances.keys()) {
            const tokenHolderName = this.parent.eventFormatter.formatAddress(tokenHolder);
            logger.log(`        ${tokenHolderName}:  poolTokens=${formatBN(this.poolTokenBalances.get(tokenHolder))}  feeDebt=${formatBN(this.poolFeeDebt.get(tokenHolder))}` +
                `  virtualPoolFees=${formatBN(this.calculateVirtualFeesOf(tokenHolder))}`);
        }
    }

    writeBalanceTrackingList(dir: string) {
        const path = `${dir}/${this.name().toLowerCase().replace(/\*/g, 'x')}.csv`;
        const fd = openNewFile(path, 'w', false);
        try {
            this.balanceTrackingList.writeCSV(fd);
        } finally {
            closeSync(fd);
        }
    }
}
