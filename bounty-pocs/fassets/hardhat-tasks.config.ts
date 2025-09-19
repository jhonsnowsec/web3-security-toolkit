import "dotenv/config";

import "@nomiclabs/hardhat-truffle5";
import "@nomiclabs/hardhat-web3";
import fs from "fs/promises";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import { task } from "hardhat/config";
import path from "path";
import 'solidity-coverage';
import { FAssetContractStore } from "./deployment/lib/contracts";
import { deployAssetManager, deployAssetManagerController, deployCoreVaultManager, redeployFacet, switchAllToProductionMode } from "./deployment/lib/deploy-asset-manager";
import { deployAgentOwnerRegistry, deployAgentVaultFactory, deployCollateralPoolFactory, deployCollateralPoolTokenFactory, verifyAgentOwnerRegistry, verifyAgentVaultFactory, verifyCollateralPoolFactory, verifyCollateralPoolTokenFactory } from "./deployment/lib/deploy-asset-manager-dependencies";
import { deployCuts } from "./deployment/lib/deploy-cuts";
import { deployPriceReaderV2, verifyFtsoV2PriceStore } from "./deployment/lib/deploy-ftsov2-price-store";
import { networkConfigName } from "./deployment/lib/deploy-utils";
import { linkContracts } from "./deployment/lib/link-contracts";
import { verifyAllAssetManagerFacets, verifyAssetManager, verifyAssetManagerController, verifyContract, verifyCoreVaultManager } from "./deployment/lib/verify-fasset-contracts";
import "./type-extensions";

const FASSETS_LIST = "fassets.json";

task("link-contracts", "Link contracts with external libraries")
    .addVariadicPositionalParam("contracts", "The contract names to link")
    .addOptionalParam("mapfile", "Name for the map file with deployed library mapping addresses; if omitted, no map file is read or created")
    .setAction(async ({ contracts, mapfile }: {
        contracts: string[],
        mapfile?: string
    }, hre) => {
        await linkContracts(hre, contracts, mapfile);
    });

task("deploy-price-reader-v2", "Deploy price reader v2.")
    .setAction(async ({}, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        await deployPriceReaderV2(hre, contracts);
    });

task("deploy-asset-manager-dependencies", "Deploy some or all asset manager dependencies.")
    .addVariadicPositionalParam("contractNames", `Contract names to deploy`, [])
    .addFlag("all", "Deploy all dependencies (AgentOwnerRegistry, AgentVaultFactory, CollateralPoolFactory, CollateralPoolTokenFactory)")
    .setAction(async ({ contractNames, all }: {contractNames: string[], all: boolean }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        if (all || contractNames.includes('AgentOwnerRegistry')) {
            const address = await deployAgentOwnerRegistry(hre, contracts);
            console.log(`AgentOwnerRegistry deployed at ${address}`);
        }
        if (all || contractNames.includes('AgentVaultFactory')) {
            const address = await deployAgentVaultFactory(hre, contracts);
            console.log(`AgentVaultFactory deployed at ${address}`);
        }
        if (all || contractNames.includes('CollateralPoolFactory')) {
            const address = await deployCollateralPoolFactory(hre, contracts);
            console.log(`CollateralPoolFactory deployed at ${address}`);
        }
        if (all || contractNames.includes('CollateralPoolTokenFactory')) {
            const address = await deployCollateralPoolTokenFactory(hre, contracts);
            console.log(`CollateralPoolTokenFactory deployed at ${address}`);
        }
    });

task("deploy-asset-managers", "Deploy some or all asset managers. Optionally also deploys asset manager controller.")
    .addFlag("deployController", "Also deploy AssetManagerController, AgentVaultFactory and FdcVerification")
    .addFlag("all", `Deploy all asset managers listed in the file ${FASSETS_LIST}`)
    .addVariadicPositionalParam("managers", `Asset manager file names (default extension is .json). Must be in the directory deployment/config/\${networkConfig}. Alternatively, add -all flag to use all parameter files listed in ${FASSETS_LIST}.`, [])
    .setAction(async ({ managers, deployController, all }: {
        managers: string[],
        deployController: boolean,
        all: boolean
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        const managerParameterFiles = await getManagerFiles(all, `deployment/config/${networkConfig}`, managers);
        await hre.run("compile");
        // optionally run the deploy together with controller
        if (deployController) {
            await deployAssetManagerController(hre, contracts, managerParameterFiles);
        } else {
            for (const paramFile of managerParameterFiles) {
                await deployAssetManager(hre, paramFile, contracts, true);
            }
        }
    });

task("deploy-core-vault-manager", "Deploy core vault manager for one fasset.")
    .addFlag("set", "Also set the deployed core vault manager to the corresponing asset manager. Only works when asset manager is not in production mode.")
    .addPositionalParam("parametersFile", "The file with core vault manager parameters.")
    .setAction(async ({ parametersFile, set }: {
        parametersFile: string,
        set: boolean
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        await deployCoreVaultManager(hre, contracts, parametersFile, set);
    });

task("verify-contract", "Verify a contract in contracts.json.")
    .addFlag("force", "re-verify partially verified contract")
    .addPositionalParam("contract", "name or address of the contract to verify.")
    .addVariadicPositionalParam("constructorArgs", "constructor arguments", [])
    .setAction(async ({ force, contract, constructorArgs }: {
        force: boolean,
        contract: string,
        constructorArgs: string[]
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await verifyContract(hre, contract, contracts, constructorArgs, force);
    });

task("redeploy-facet", "Redeploy a facet or proxy implementation and update contracts.json.")
    .addPositionalParam("implementationName", "name of the implementation contract to redeploy")
    .setAction(async ({ implementationName }: {
        implementationName: string
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        await redeployFacet(hre, contracts, implementationName);
    });

task("verify-asset-manager-dependencies", "Verify some or all asset manager dependencies.")
    .addVariadicPositionalParam("contractNames", `Contract names to deploy`, [])
    .addFlag("force", "re-verify partially verified proxy contract")
    .addFlag("all", "Deploy all dependencies (AgentOwnerRegistry, AgentVaultFactory, CollateralPoolFactory, CollateralPoolTokenFactory)")
    .setAction(async ({ contractNames, all, force }: { contractNames: string[], all: boolean, force: boolean }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        if (all || contractNames.includes('AgentOwnerRegistry')) {
            await verifyAgentOwnerRegistry(hre, contracts, force);
        }
        if (all || contractNames.includes('AgentVaultFactory')) {
            await verifyAgentVaultFactory(hre, contracts, force);
        }
        if (all || contractNames.includes('CollateralPoolFactory')) {
            await verifyCollateralPoolFactory(hre, contracts, force);
        }
        if (all || contractNames.includes('CollateralPoolTokenFactory')) {
            await verifyCollateralPoolTokenFactory(hre, contracts, force);
        }
    });

task("verify-asset-managers", "Verify deployed asset managers.")
    .addFlag("all", `Verify all asset managers listed in the file ${FASSETS_LIST}`)
    .addVariadicPositionalParam("managers", `Asset manager file names (default extension is .json). Must be in the directory deployment/config/\${networkConfig}. Alternatively, add -all flag to use all parameter files listed in ${FASSETS_LIST}.`, [])
    .setAction(async ({ managers, all }: {
        managers: string[],
        all: boolean
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        const managerParameterFiles = await getManagerFiles(all, `deployment/config/${networkConfig}`, managers);
        for (const paramFile of managerParameterFiles) {
            await verifyAssetManager(hre, paramFile, contracts);
        }
    });

task("verify-asset-manager-controller", "Verify deployed asset manager controller.")
    .setAction(async ({}, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await verifyAssetManagerController(hre, contracts);
    });

task("verify-price-reader-v2", "Verify deployed price reader v2.")
    .setAction(async ({}, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await verifyFtsoV2PriceStore(hre, contracts);
    });

task("verify-asset-manager-facets", "Verify all asset manager facets.")
    .setAction(async ({ }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await verifyAllAssetManagerFacets(hre, contracts);
    });

task("verify-core-vault-manager", "Verify core vault manager for one fasset.")
    .addPositionalParam("parametersFile", "The file with core vault manager parameters.")
    .setAction(async ({ parametersFile }: {
        parametersFile: string
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        await verifyCoreVaultManager(hre, contracts, parametersFile);
    });

task("switch-to-production", "Switch all deployed files to production mode.")
    .setAction(async ({}, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await switchAllToProductionMode(hre, contracts);
    });

task("diamond-cut", "Create diamond cut defined by JSON file.")
    .addPositionalParam("json", "Diamond cut JSON definition file")
    .addFlag("execute", "Execute diamond cut; if not set, just print calldata. Execute is automatically disabled in production mode.")
    .setAction(async ({ json, execute }: {
        json: string,
        execute: boolean
    }, hre) => {
        const networkConfig = networkConfigName(hre);
        const contracts = new FAssetContractStore(`deployment/deploys/${networkConfig}.json`, true);
        await hre.run("compile");
        await deployCuts(hre, contracts, json, { execute: execute, verbose: true });
    });


async function getManagerFiles(all: boolean, configDir: string, managers: string[]) {
    if (all) {
        // read the list for deploy from FASSETS_LIST file
        const parsedFile = await fs.readFile(path.join(configDir, FASSETS_LIST), "ascii")
        managers = JSON.parse(parsedFile) as string[];
    } else if (managers.length === 0) {
        console.error(`Provide a nonempty list of managers to deploy or --all to use all parameter files listed in ${FASSETS_LIST}.`);
        process.exit(1);
    }
    // use files provided on command line or from FASSETS_LIST file, optionally adding suffix '.json'
    return managers.map((name: string) => {
        const parts = path.parse(name);
        return path.join(configDir, `${parts.name}${parts.ext || '.json'}`);
    });
}
