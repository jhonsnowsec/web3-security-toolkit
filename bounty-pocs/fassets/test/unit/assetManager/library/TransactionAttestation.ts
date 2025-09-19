import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { createTestAgent, createTestAgentSettings, createTestCollaterals, createTestContracts, createTestSettings, TestSettingsContracts, whitelistAgentOwner } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { SourceId } from "../../../../lib/underlying-chain/SourceId";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { randomAddress, toBN, toBNExp, toWei, ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../../lib/utils/web3normalize";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

contract(`TransactionAttestation.sol; ${getTestFile(__filename)}; Transaction attestation basic tests`, accounts => {
    const governance = accounts[10];
    const assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatMockInstance;
    let usdc: ERC20MockInstance;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    // addresses
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique

    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function depositAndMakeAgentAvailable(agentVault: AgentVaultInstance, owner: string, fullAgentCollateral: BN = toWei(3e8)) {
        await depositCollateral(owner, agentVault, fullAgentCollateral);
        await agentVault.buyCollateralPoolTokens({ from: owner, value: fullAgentCollateral });  // add pool collateral and agent pool tokens
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
    }

    async function depositCollateral(owner: string, agentVault: AgentVaultInstance, amount: BN, token: ERC20MockInstance = usdc) {
        await token.mintAmount(owner, amount);
        await token.approve(agentVault.address, amount, { from: owner });
        await agentVault.depositCollateral(token.address, amount, { from: owner });
    }

    async function reserveCollateral(agentVault: AgentVaultInstance, chain: MockChain, lots: number, underlyingMinterAddress: string, minterAddress: string) {
        // update underlying block
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await assetManager.updateCurrentBlock(proof);
        // minter
        chain.mint(underlyingMinterAddress, toBNExp(10000, 18));
        // perform minting
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const crFee = await assetManager.collateralReservationFee(lots);
        const resAg = await assetManager.reserveCollateral(agentVault.address, lots, agentInfo.feeBIPS, ZERO_ADDRESS, { from: minterAddress, value: crFee });
        return requiredEventArgs(resAg, 'CollateralReserved');
    }

    async function initialize() {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset };
    }

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should not verify payment - legal payment not proved", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const minterUnderlying = "MINTER_UNDERLYING";
        const crt = await reserveCollateral(agentVault, chain, 3, minterUnderlying, accounts[4]);
        chain.mint(underlyingAgent1, 10001);
        const txHash = await wallet.addTransaction(underlyingAgent1, underlyingAgent1, 1, PaymentReference.minting(crt.collateralReservationId), { maxFee: 100 });
        const proof = await attestationProvider.provePayment(txHash, underlyingAgent1, underlyingAgent1);
        proof.data.responseBody.blockNumber = toBN(proof.data.responseBody.blockNumber).addn(1).toString();
        await expectRevert.custom(assetManager.executeMinting(proof, crt.collateralReservationId, { from: agentOwner1 }), "LegalPaymentNotProven", [])
    });

    it("should not verify payment - invalid chain", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const minterUnderlying = "MINTER_UNDERLYING";
        const crt = await reserveCollateral(agentVault, chain, 3, minterUnderlying, accounts[4]);
        const chainId: SourceId = SourceId.DOGE;
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainId);
        chain.mint(underlyingAgent1, 10001);
        const txHash = await wallet.addTransaction(underlyingAgent1, underlyingAgent1, 1, PaymentReference.minting(crt.collateralReservationId), { maxFee: 100 });
        const proof = await attestationProvider.provePayment(txHash, underlyingAgent1, underlyingAgent1);
        await expectRevert.custom(assetManager.executeMinting(proof, crt.collateralReservationId, { from: agentOwner1 }), "InvalidChain", [])
    });

    it("should not execute minting payment default - non-payment not proved", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const minterUnderlying = "MINTER_UNDERLYING";
        const crt = await reserveCollateral(agentVault, chain, 3, minterUnderlying, accounts[4]);
        for (let i = 0; i < 200; i++) {
            await wallet.addTransaction(minterUnderlying, minterUnderlying, 1, null);
        }
        const proof = await attestationProvider.proveReferencedPaymentNonexistence(crt.paymentAddress, crt.paymentReference, crt.valueUBA.sub(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        proof.data.lowestUsedTimestamp = toBN(proof.data.lowestUsedTimestamp).addn(1).toString();
        const res = assetManager.mintingPaymentDefault(proof, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert.custom(res, 'NonPaymentNotProven', []);
    });

    it("should not execute minting payment default - invalid chain", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const minterUnderlying = "MINTER_UNDERLYING";
        const crt = await reserveCollateral(agentVault, chain, 3, minterUnderlying, accounts[4]);
        for (let i = 0; i < 200; i++) {
            await wallet.addTransaction(minterUnderlying, minterUnderlying, 1, null);
        }
        const chainId: SourceId = SourceId.DOGE;
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainId);
        const proof = await attestationProvider.proveReferencedPaymentNonexistence(crt.paymentAddress, crt.paymentReference, crt.valueUBA.sub(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const res = assetManager.mintingPaymentDefault(proof, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert.custom(res, "InvalidChain", []);
    });

    it("should not succeed challenging illegal payment - transaction not proved", async() => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const txHash = await wallet.addTransaction(underlyingAgent1, randomAddress(), 1, PaymentReference.redemption(0));
        const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
        proof.data.responseBody.spentAmount = toBN(proof.data.responseBody.spentAmount).addn(1).toString();
        const res = assetManager.illegalPaymentChallenge(proof, agentVault.address);
        await expectRevert.custom(res, "TransactionNotProven", []);
    });

    it("should not succeed challenging illegal payment - invalid chain", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const txHash = await wallet.addTransaction(underlyingAgent1, randomAddress(), 1, PaymentReference.redemption(0));
        const chainId: SourceId = SourceId.DOGE;
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainId);
        const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
        const res = assetManager.illegalPaymentChallenge(proof, agentVault.address);
        await expectRevert.custom(res, "InvalidChain", []);
    });

    it("should not update current block - block height not proved", async() => {
        await createAgent(agentOwner1, underlyingAgent1);
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        proof.data.requestBody.blockNumber = toBN(proof.data.requestBody.blockNumber).addn(1).toString();
        const res = assetManager.updateCurrentBlock(proof);
        await expectRevert.custom(res, "BlockHeightNotProven", [])
    });

    it("should not update current block - invalid chain", async () => {
        await createAgent(agentOwner1, underlyingAgent1);
        const chainId: SourceId = SourceId.DOGE;
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainId);
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        const res = assetManager.updateCurrentBlock(proof);
        await expectRevert.custom(res, "InvalidChain", [])
    });

    it("should not verify address validity - invalid chain", async () => {
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        const chainId: SourceId = SourceId.DOGE;
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainId);
        const proof = await attestationProvider.proveAddressValidity("MY_ADDRESS");
        const promise = assetManager.createAgentVault(
            web3DeepNormalize(proof), web3DeepNormalize(createTestAgentSettings(usdc.address)), { from: agentOwner1 });
        await expectRevert.custom(promise, "InvalidChain", [])
    });
});
