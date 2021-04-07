'use strict';

const path = require('path');
const fs = require('fs');
const w3utils = require('web3-utils');
const Web3 = require('web3');
const { red, gray, green, yellow } = require('chalk');

const { getUsers } = require('../../..');

const DEFAULTS = {
	gasPrice: '1',
	gasLimit: 1.5e6, // 1.5m
	network: 'hecot',
};

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
} = require('../util');

const EscrowConfig = {
	// '0xdbe9c704937f74368b9c08e600D36847B1a21a37': [
	// 	w3utils.toWei('100', 'ether'),
	// 	w3utils.toWei('50', 'ether'),
	// 	w3utils.toWei('100', 'ether'),
	// ],
	'0x646b6BE5818f1483b94a68bE361d94A43f85f4fA': [w3utils.toWei('100', 'ether')],
};

const DAY = 86400;

// const HOUR = 3600;

const escrowAppend = async ({
	deploymentPath,
	network = DEFAULTS.network,
	gasPrice = DEFAULTS.gasPrice,
	gasLimit = DEFAULTS.gasLimit,
	privateKey,
	yes,
	useFork,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const { deployment } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	let provideUrlX;
	const { providerUrl, privateKey: envPrivateKey } = loadConnections({
		network,
		useFork,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}
	if (network === 'hecot') {
		provideUrlX = 'http://10.136.0.124:8545';
	} else {
		provideUrlX = providerUrl;
	}
	const web3 = new Web3(new Web3.providers.HttpProvider(provideUrlX));

	let account;
	if (useFork) {
		account = getUsers({ network, user: 'owner' }).address; // protocolDAO
	} else {
		web3.eth.accounts.wallet.add(privateKey);
		account = web3.eth.accounts.wallet[0].address;
	}
	console.log(gray(`Using account with public key ${account}`));

	if (!deployment.targets['SynthetixEscrow'] || !deployment.targets['Synthetix']) {
		throw Error('SynthetixEscrow or Synthetix not in deployment.targets');
	}

	const escrowContract = new web3.eth.Contract(
		deployment.sources['SynthetixEscrow'].abi,
		deployment.targets['SynthetixEscrow'].address
	);
	const synContract = new web3.eth.Contract(
		deployment.sources['Synthetix'].abi,
		deployment.targets['Synthetix'].address
	);
	// const feePeriodLength = await sourceContract.methods.FEE_PERIOD_LENGTH().call();
	// const { transactionHash } = await targetContract.methods.importFeePeriod(...importArgs).send({
	//     from: account,
	//     gasLimit: Number(gasLimit),
	//     gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
	// });
	const owner = await escrowContract.methods.owner().call();
	if (owner !== account) {
		throw Error(`accout ${account} is not owner of SynthetixEscrow`);
	}

	const { timestamp } = await web3.eth.getBlock('latest');
	const setupExpiryTime = await escrowContract.methods.setupExpiryTime().call();
	console.log('setupExpiryTime ', setupExpiryTime, setupExpiryTime.toString());
	if (timestamp > setupExpiryTime) {
		throw Error(`time expiry which should before ${setupExpiryTime}`);
	}
	// const { transactionHash } = await targetContract.methods.importFeePeriod(...importArgs).send({
	//     from: account,
	//     gasLimit: Number(gasLimit),
	//     gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
	// });

	const interval = DAY / 2;
	const escrowKeys = Object.keys(EscrowConfig);
	for (let i = 0; i < escrowKeys.length; i++) {
		const address = escrowKeys[i];
		const vests = EscrowConfig[address];
		console.log(
			'vest address',
			address,
			'escrowContract._address',
			escrowContract._address,
			'synadd',
			synContract._address
		);
		for (let j = 0; j < vests.length; j++) {
			const time = timestamp + interval * (j + 1);
			console.log('time > ', time);
			await synContract.methods.transfer(escrowContract._address, vests[j]).send({
				from: account,
				gasLimit: Number(gasLimit),
				gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
			});
			await escrowContract.methods.appendVestingEntry(address, time, vests[j]).send({
				from: account,
				gasLimit: Number(gasLimit),
				gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
			});
		}
	}

	console.log(gray('Action complete.'));
};

module.exports = {
	escrowAppend,
	cmd: program =>
		program
			.command('escrow')
			.description('add escrow')
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option('-l, --gas-limit <value>', 'Gas limit', parseInt, DEFAULTS.gasLimit)
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-k, --use-fork',
				'Perform the deployment on a forked chain running on localhost (see fork command).',
				false
			)

			.action(async (...args) => {
				try {
					await escrowAppend(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}
			}),
};
