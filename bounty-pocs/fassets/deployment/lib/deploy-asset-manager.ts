import { encodeAttestationName } from "@flarenetwork/js-flare-common";
import BN from "bn.js";
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { AssetManagerSettings, CollateralClass, CollateralType } from '../../lib/fasset/AssetManagerTypes';
import { web3DeepNormalize } from "../../lib/utils/web3normalize";
import { FAssetInstance } from "../../typechain-truffle";
import { JsonParameterSchema } from "./JsonParameterSchema";
import { AssetManagerParameters, CollateralTypeParameters } from './asset-manager-parameters';
import { FAssetContractStore } from "./contracts";
import { checkAllAssetManagerMethodsImplemented, createDiamondCutsForAllAssetManagerFacets, deployAllAssetManagerFacets, deployFacet } from "./deploy-asset-manager-facets";
import { deployCutsOnDiamond } from "./deploy-cuts";
import { ZERO_ADDRESS, abiEncodeCall, encodeContractNames, loadDeployAccounts, waitFinalize } from './deploy-utils';
import { CoreVaultManagerParameters } from "./core-vault-manager-parameters";

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const assetManagerParameters = new JsonParameterSchema<AssetManagerParameters>(require('../config/asset-manager-parameters.schema.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const coreVaultManagerParameters = new JsonParameterSchema<CoreVaultManagerParameters>(require('../config/core-vault-manager-parameters.schema.json'));

export async function deployAssetManagerController(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, managerParameterFiles: string[]) {
    const artifacts = hre.artifacts as Truffle.Artifacts;

    console.log(`Deploying AssetManagerController`);

    const AssetManagerController = artifacts.require("AssetManagerController");
    const AssetManagerControllerProxy = artifacts.require("AssetManagerControllerProxy");

    const { deployer } = loadDeployAccounts(hre);

    const assetManagerControllerImplAddress = await deployFacet(hre, "AssetManagerControllerImplementation", contracts, deployer, "AssetManagerController");
    const assetManagerControllerProxy = await waitFinalize(hre, deployer,
        () => AssetManagerControllerProxy.new(assetManagerControllerImplAddress, contracts.GovernanceSettings.address, deployer, contracts.AddressUpdater.address, { from: deployer }));
    const assetManagerController = await AssetManagerController.at(assetManagerControllerProxy.address);

    contracts.add("AssetManagerController", "AssetManagerControllerProxy.sol", assetManagerController.address, { mustSwitchToProduction: true });

    // add asset managers before switching to production governance
    for (const parameterFile of managerParameterFiles) {
        console.log(`   deploying AssetManager with config ${parameterFile}`);
        const assetManager = await deployAssetManager(hre, parameterFile, contracts, false);
        await waitFinalize(hre, deployer, () => assetManagerController.addAssetManager(assetManager.address, { from: deployer }));
    }

    console.log(`NOTE: perform governance call 'AddressUpdater(${contracts.AddressUpdater.address}).addOrUpdateContractNamesAndAddresses(["AssetManagerController"], [${assetManagerController.address}])'`);
}

// assumes AssetManager contract artifact has been linked already
export async function deployAssetManager(hre: HardhatRuntimeEnvironment, parametersFile: string, contracts: FAssetContractStore, standalone: boolean) {
    const artifacts = hre.artifacts as Truffle.Artifacts;

    const AssetManager = artifacts.require("AssetManager");
    const AssetManagerInit = artifacts.require("AssetManagerInit");
    const FAsset = artifacts.require('FAsset');
    const FAssetProxy = artifacts.require('FAssetProxy');

    const { deployer } = loadDeployAccounts(hre);
    const parameters = assetManagerParameters.load(parametersFile);

    const fAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");
    const fAssetProxy = await waitFinalize(hre, deployer,
        () => FAssetProxy.new(fAssetImplAddress, parameters.fAssetName, parameters.fAssetSymbol, parameters.assetName, parameters.assetSymbol, parameters.assetDecimals, { from: deployer }));
    const fAsset = await FAsset.at(fAssetProxy.address);

    const poolCollateral = convertCollateralType(contracts, parameters.poolCollateral, CollateralClass.POOL);
    const vaultCollateral = parameters.vaultCollaterals.map(p => convertCollateralType(contracts, p, CollateralClass.VAULT));
    const collateralTypes = [poolCollateral, ...vaultCollateral];

    const assetManagerSettings = web3DeepNormalize(createAssetManagerSettings(contracts, parameters, fAsset));

    // deploy asset manager diamond
    const assetManagerInitAddress = await deployFacet(hre, 'AssetManagerInit', contracts, deployer);
    await deployAllAssetManagerFacets(hre, contracts, deployer);

    const diamondCuts = await createDiamondCutsForAllAssetManagerFacets(hre, contracts);

    const initParameters = abiEncodeCall(await AssetManagerInit.at(assetManagerInitAddress),
        c => c.init(contracts.GovernanceSettings.address, deployer, assetManagerSettings, collateralTypes));

    const assetManager = await waitFinalize(hre, deployer,
        () => AssetManager.new(diamondCuts, assetManagerInitAddress, initParameters, { from: deployer }));

    await waitFinalize(hre, deployer, () => fAsset.setAssetManager(assetManager.address, { from: deployer }));

    // perform additional cuts (with own init methods)
    await deployCutsOnDiamond(hre, contracts,
        {
            diamond: assetManager.address,
            facets: [{ contract: "RedemptionTimeExtensionFacet", exposedInterfaces: ["IRedemptionTimeExtension"] }],
            init: { contract: "RedemptionTimeExtensionFacet", method: "initRedemptionTimeExtensionFacet", args: [parameters.redemptionPaymentExtensionSeconds] },
        },
        { execute: true, verbose: false });

    await deployCutsOnDiamond(hre, contracts,
        {
            diamond: assetManager.address,
            facets: [
                { contract: "CoreVaultClientFacet", exposedInterfaces: ["ICoreVaultClient"] },
                { contract: "CoreVaultClientSettingsFacet", exposedInterfaces: ["ICoreVaultClientSettings"] }
            ],
            init: {
                contract: "CoreVaultClientSettingsFacet",
                method: "initCoreVaultFacet",
                args: [ZERO_ADDRESS, parameters.coreVaultNativeAddress,
                    parameters.coreVaultTransferTimeExtensionSeconds, parameters.coreVaultRedemptionFeeBIPS,
                    parameters.coreVaultMinimumAmountLeftBIPS, parameters.coreVaultMinimumRedeemLots]
            },
        },
        { execute: true, verbose: false });

    // everything from IIAssetManager must be implemented now
    await checkAllAssetManagerMethodsImplemented(hre, assetManager.address);

    // save to contracts
    const symbol = parameters.fAssetSymbol;
    contracts.add(`AssetManager_${symbol}`, "AssetManager.sol", assetManager.address, { mustSwitchToProduction: true });
    contracts.add(symbol, "FAssetProxy.sol", fAsset.address);

    if (standalone) {
        console.log(`NOTE: perform governance call 'AssetManagerController(${contracts.AssetManagerController?.address}).addAssetManager(${assetManager.address})'`);
    }

    return assetManager;
}

export async function deployCoreVaultManager(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, parametersFile: string, setOnAssetManager: boolean) {
    const artifacts = hre.artifacts as Truffle.Artifacts;

    const IIAssetManager = artifacts.require("IIAssetManager");
    const CoreVaultManager = artifacts.require("CoreVaultManager");
    const CoreVaultManagerProxy = artifacts.require("CoreVaultManagerProxy");
    const FAsset = artifacts.require("FAsset");

    const { deployer } = loadDeployAccounts(hre);
    const parameters = coreVaultManagerParameters.load(parametersFile);

    const assetManager = await IIAssetManager.at(contracts.getAddress(parameters.assetManager));
    const settings = await assetManager.getSettings();

    const coreVaultManagerImpl = await deployFacet(hre, "CoreVaultManagerImplementation", contracts, deployer, "CoreVaultManager");
    const coreVaultManagerProxy = await waitFinalize(hre, deployer,
        () => CoreVaultManagerProxy.new(coreVaultManagerImpl, contracts.GovernanceSettings.address, deployer, deployer /* will be changed */,
                    assetManager.address, settings.chainId, parameters.custodianAddress, parameters.underlyingAddress, parameters.initialSequenceNumber,
                    { from: deployer }));
    const coreVaultManager = await CoreVaultManager.at(coreVaultManagerProxy.address);

    // hack to set contract addresses without governance call from AddressUpdater
    await waitFinalize(hre, deployer,
        () => coreVaultManager.updateContractAddresses(encodeContractNames(hre, ["AddressUpdater", "FdcVerification"]),
                    [contracts.AddressUpdater.address, contracts.FdcVerification!.address],
                    { from: deployer }));

    // set initial settings
    await waitFinalize(hre, deployer,
        () => coreVaultManager.updateSettings(parameters.escrowEndTimeSeconds, parseBN(parameters.escrowAmount),
                    parseBN(parameters.minimalAmountLeft), parseBN(parameters.chainPaymentFee),
                    { from: deployer }));

    const fAsset = await FAsset.at(settings.fAsset);
    const fAssetSymbol = await fAsset.symbol();
    contracts.add(`CoreVaultManager_${fAssetSymbol}`, "CoreVaultManagerProxy.sol", coreVaultManager.address, { mustSwitchToProduction: true });

    if (setOnAssetManager) {
        if (!(await assetManager.productionMode())) {
            await waitFinalize(hre, deployer,
                () => assetManager.setCoreVaultManager(coreVaultManager.address, { from: deployer }));
        } else {
            console.log("Asset manager is in production mode. Set core vault manager with governance call.");
        }
    } else {
        console.log("Core vault manager deployed, but not set to asset manager.");
    }
}

export async function redeployFacet(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, implementationName: string) {
    const { deployer } = loadDeployAccounts(hre);
    const implContract = contracts.getRequired(implementationName);
    const facetName = implContract.contractName.replace(/\.sol$/, "");
    await deployFacet(hre, implementationName, contracts, deployer, facetName);
}

export async function switchAllToProductionMode(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    const { deployer } = loadDeployAccounts(hre);

    const GovernedBase = artifacts.require("contracts/governance/implementation/GovernedBase.sol:GovernedBase" as 'GovernedBase');

    for (const contract of contracts.list()) {
        if (contract?.mustSwitchToProduction) {
            console.log(`Switching to production: ${contract.name}`);
            const instance = await GovernedBase.at(contract.address);
            await waitFinalize(hre, deployer, () => instance.switchToProductionMode({ from: deployer }));
            delete contract.mustSwitchToProduction;
            contracts.save();
        }
    }
}

export function convertCollateralType(contracts: FAssetContractStore, parameters: CollateralTypeParameters, collateralClass: CollateralClass): CollateralType {
    return {
        collateralClass: collateralClass,
        token: contracts.getAddress(parameters.token),
        decimals: parameters.decimals,
        validUntil: 0,  // not deprecated
        directPricePair: parameters.directPricePair,
        assetFtsoSymbol: parameters.assetFtsoSymbol,
        tokenFtsoSymbol: parameters.tokenFtsoSymbol,
        minCollateralRatioBIPS: parameters.minCollateralRatioBIPS,
        safetyMinCollateralRatioBIPS: parameters.safetyMinCollateralRatioBIPS,
    }
}

export function createAssetManagerSettings(contracts: FAssetContractStore, parameters: AssetManagerParameters, fAsset: FAssetInstance): AssetManagerSettings {
    const ten = new BN(10);
    const assetUnitUBA = ten.pow(new BN(parameters.assetDecimals));
    const assetMintingGranularityUBA = ten.pow(new BN(parameters.assetDecimals - parameters.assetMintingDecimals));
    return {
        assetManagerController: contracts.getAddress(parameters.assetManagerController ?? 'AssetManagerController'),
        fAsset: fAsset.address,
        agentVaultFactory: contracts.getAddress(parameters.agentVaultFactory ?? 'AgentVaultFactory'),
        collateralPoolFactory: contracts.getAddress(parameters.collateralPoolFactory ?? 'CollateralPoolFactory'),
        collateralPoolTokenFactory: contracts.getAddress(parameters.collateralPoolTokenFactory ?? 'CollateralPoolTokenFactory'),
        fdcVerification: contracts.getAddress(parameters.fdcVerification ?? 'FdcVerification'),
        priceReader: contracts.getAddress(parameters.priceReader ?? 'PriceReader'),
        __whitelist: ZERO_ADDRESS,
        agentOwnerRegistry: contracts.getAddress(parameters.agentOwnerRegistry ?? 'AgentOwnerRegistry'),
        burnAddress: parameters.burnAddress,
        chainId: encodeAttestationName(parameters.chainName),
        poolTokenSuffix: parameters.poolTokenSuffix,
        assetDecimals: parameters.assetDecimals,
        assetUnitUBA: assetUnitUBA,
        assetMintingDecimals: parameters.assetMintingDecimals,
        assetMintingGranularityUBA: assetMintingGranularityUBA,
        __minUnderlyingBackingBIPS: 0,
        mintingCapAMG: parseBN(parameters.mintingCap).div(assetMintingGranularityUBA),
        lotSizeAMG: parseBN(parameters.lotSize).div(assetMintingGranularityUBA),
        __requireEOAAddressProof: false, // no longer used, always false
        collateralReservationFeeBIPS: parameters.collateralReservationFeeBIPS,
        mintingPoolHoldingsRequiredBIPS: parameters.mintingPoolHoldingsRequiredBIPS,
        maxRedeemedTickets: parameters.maxRedeemedTickets,
        redemptionFeeBIPS: parameters.redemptionFeeBIPS,
        redemptionDefaultFactorVaultCollateralBIPS: parameters.redemptionDefaultFactorVaultCollateralBIPS,
        __redemptionDefaultFactorPoolBIPS: 0,
        underlyingBlocksForPayment: parameters.underlyingBlocksForPayment,
        underlyingSecondsForPayment: parameters.underlyingSecondsForPayment,
        attestationWindowSeconds: parameters.attestationWindowSeconds,
        averageBlockTimeMS: parameters.averageBlockTimeMS,
        confirmationByOthersAfterSeconds: parameters.confirmationByOthersAfterSeconds,
        confirmationByOthersRewardUSD5: parseBN(parameters.confirmationByOthersRewardUSD5),
        paymentChallengeRewardBIPS: parameters.paymentChallengeRewardBIPS,
        paymentChallengeRewardUSD5: parseBN(parameters.paymentChallengeRewardUSD5),
        __ccbTimeSeconds: 0,
        liquidationStepSeconds: parameters.liquidationStepSeconds,
        liquidationCollateralFactorBIPS: parameters.liquidationCollateralFactorBIPS,
        liquidationFactorVaultCollateralBIPS: parameters.liquidationFactorVaultCollateralBIPS,
        maxTrustedPriceAgeSeconds: parameters.maxTrustedPriceAgeSeconds,
        withdrawalWaitMinSeconds: parameters.withdrawalWaitMinSeconds,
        __announcedUnderlyingConfirmationMinSeconds: 0,
        __buybackCollateralFactorBIPS: 0,
        vaultCollateralBuyForFlareFactorBIPS: parameters.vaultCollateralBuyForFlareFactorBIPS,
        minUpdateRepeatTimeSeconds: parameters.minUpdateRepeatTimeSeconds,
        tokenInvalidationTimeMinSeconds: parameters.tokenInvalidationTimeMinSeconds,
        agentExitAvailableTimelockSeconds: parameters.agentExitAvailableTimelockSeconds,
        agentFeeChangeTimelockSeconds: parameters.agentFeeChangeTimelockSeconds,
        agentMintingCRChangeTimelockSeconds: parameters.agentMintingCRChangeTimelockSeconds,
        poolExitCRChangeTimelockSeconds: parameters.poolExitCRChangeTimelockSeconds,
        agentTimelockedOperationWindowSeconds: parameters.agentTimelockedOperationWindowSeconds,
        collateralPoolTokenTimelockSeconds: parameters.collateralPoolTokenTimelockSeconds,
        diamondCutMinTimelockSeconds: parameters.diamondCutMinTimelockSeconds,
        maxEmergencyPauseDurationSeconds: parameters.maxEmergencyPauseDurationSeconds,
        emergencyPauseDurationResetAfterSeconds: parameters.emergencyPauseDurationResetAfterSeconds,
        __cancelCollateralReservationAfterSeconds: 0,
        __rejectOrCancelCollateralReservationReturnFactorBIPS: 0,
        __rejectRedemptionRequestWindowSeconds: 0,
        __takeOverRedemptionRequestWindowSeconds: 0,
        __rejectedRedemptionDefaultFactorVaultCollateralBIPS: 0,
        __rejectedRedemptionDefaultFactorPoolBIPS: 0,
    };
}

function parseBN(s: string) {
    return new BN(s.replace(/_/g, ''), 10);
}
