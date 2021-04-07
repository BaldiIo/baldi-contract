/**
 *  eth95
 *  npm install -g eth95
 *  node publish eth95  //to generate config for eth95
 *  eth95 build/eth95   //run at `http://localhost:3000`, can use metamask to read contract
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { gray } = require('chalk');
const stringify = input => JSON.stringify(input, null, '\t') + '\n';

const {
	constants: { BUILD_FOLDER, DEPLOYMENT_FILENAME },
} = require('../../..');

const DEPLOYED_FOLDER = path.join(__dirname, '..', '..', 'deployed');
const ARTFIFACTS_FOLDER = path.join(__dirname, '..', '..', '..', BUILD_FOLDER, 'eth95');

const networkToChainId = {
	hecot: 256,
};

const eth95 = async () => {
	console.log(gray(`sync deployed folder ${DEPLOYED_FOLDER} to ${ARTFIFACTS_FOLDER}`));
	if (!fs.existsSync(ARTFIFACTS_FOLDER)) {
		fs.mkdirSync(ARTFIFACTS_FOLDER);
	}

	const loadDeployment = network => {
		const deploymentFile = path.join(DEPLOYED_FOLDER, network, DEPLOYMENT_FILENAME);

		if (!fs.existsSync(deploymentFile)) {
			throw Error(`file not found ${deploymentFile}`);
		}
		const deployment = JSON.parse(fs.readFileSync(deploymentFile));
		return deployment;
	};

	const loadArtiContract = name => {
		const contract = path.join(ARTFIFACTS_FOLDER, `${name}.json`);
		if (!fs.existsSync(contract)) {
			return;
		}
		return JSON.parse(fs.readFileSync(contract));
	};

	const writeArtiContract = contract => {
		const contractFile = path.join(ARTFIFACTS_FOLDER, `${contract.contractName}.json`);
		fs.writeFileSync(contractFile, stringify(contract));
	};

	Object.keys(networkToChainId).forEach(n => {
		const deployment = loadDeployment(n);
		Object.values(deployment.targets).forEach(contract => {
			let artiContract = loadArtiContract(contract.name);
			if (!artiContract) {
				artiContract = {
					contractName: contract.name,
					abi: deployment.sources[contract.source].abi,
					networks: {},
				};
			}
			artiContract.abi = deployment.sources[contract.source].abi;
			artiContract.networks[networkToChainId[n]] = { address: contract.address };
			writeArtiContract(artiContract);
		});
	});
};

module.exports = {
	eth95,
	cmd: program =>
		program
			.command('eth95')
			.description('generate artifacts with address for eth95')
			.action(eth95),
};
