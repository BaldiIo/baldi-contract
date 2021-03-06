'use strict';

const path = require('path');
const { gray, green, yellow, redBright, red } = require('chalk');
const { table } = require('table');
const w3utils = require('web3-utils');
const Deployer = require('../Deployer');
const { loadCompiledFiles, getLatestSolTimestamp } = require('../solidity');
// const checkAggregatorPrices = require('../check-aggregator-prices');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	performTransactionalStep,
	parameterNotice,
} = require('../util');

const {
	toBytes32,
	constants: {
		BUILD_FOLDER,
		CONFIG_FILENAME,
		CONTRACTS_FOLDER,
		SYNTHS_FILENAME,
		DEPLOYMENT_FILENAME,
		ZERO_ADDRESS,
		inflationStartTimestampInSecs,
	},
	defaults: {
		WAITING_PERIOD_SECS,
		PRICE_DEVIATION_THRESHOLD_FACTOR,
		TRADING_REWARDS_ENABLED,
		ISSUANCE_RATIO,
		FEE_PERIOD_DURATION,
		TARGET_THRESHOLD,
		LIQUIDATION_DELAY,
		LIQUIDATION_RATIO,
		LIQUIDATION_PENALTY,
		RATE_STALE_PERIOD,
		EXCHANGE_FEE_RATES,
		MINIMUM_STAKE_TIME,
		AGGREGATOR_WARNING_FLAGS,
	},
} = require('../../../.');

const DEFAULTS = {
	gasPrice: '1',
	methodCallGasLimit: 250e3, // 250k
	contractDeploymentGasLimit: 6.9e6, // TODO split out into seperate limits for different contracts, Proxys, Synths, Synthetix
	network: 'kovan',
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
};

const deploy = async ({
	addNewSynths,
	gasPrice = DEFAULTS.gasPrice,
	methodCallGasLimit = DEFAULTS.methodCallGasLimit,
	contractDeploymentGasLimit = DEFAULTS.contractDeploymentGasLimit,
	network = DEFAULTS.network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	oracleExrates,
	privateKey,
	yes,
	dryRun = false,
	forceUpdateInverseSynthsOnTestnet = false,
	useFork,
} = {}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const {
		config,
		configFile,
		synths,
		deployment,
		deploymentFile,
		ownerActions,
		ownerActionsFile,
		feeds,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});
	// Object.values(deployment.targets).forEach((v) => {
	// 	console.log(`${v.name}: "${v.address}",`)
	// })
	// return

	// standalone feeds are those without a synth using them
	const standaloneFeeds = Object.values(feeds).filter(
		({ asset }) => !synths.find(synth => synth.asset === asset)
		// !synths.find(synth => synth.asset === asset) ||
		// Note: ETH still used as a rate for Depot, can remove the below once the Depot uses sETH rate or is
		// removed from the system
		// asset === 'ETH'
	);

	console.log(
		gray('Checking all contracts not flagged for deployment have addresses in this network...')
	);
	const missingDeployments = Object.keys(config).filter(name => {
		return !config[name].deploy && (!deployment.targets[name] || !deployment.targets[name].address);
	});

	if (missingDeployments.length) {
		throw Error(
			`Cannot use existing contracts for deployment as addresses not found for the following contracts on ${network}:\n` +
				missingDeployments.join('\n') +
				'\n' +
				gray(`Used: ${deploymentFile} as source`)
		);
	}

	console.log(gray('Loading the compiled contracts locally...'));
	const { earliestCompiledTimestamp, compiled } = loadCompiledFiles({ buildPath });
	// now get the latest time a Solidity file was edited
	const latestSolTimestamp = getLatestSolTimestamp(CONTRACTS_FOLDER);

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
		useFork,
	});
	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const deployer = new Deployer({
		compiled,
		contractDeploymentGasLimit,
		config,
		configFile,
		deployment,
		deploymentFile,
		gasPrice,
		methodCallGasLimit,
		network,
		privateKey,
		providerUrl,
		dryRun,
		useFork,
	});

	const { account } = deployer;

	const getExistingContract = ({ contract }) => {
		const { address, source } = deployment.targets[contract];
		const { abi } = deployment.sources[source];

		return deployer.getContract({
			address,
			abi,
		});
	};

	let currentSynthetixSupply;
	let currentSynthetixPrice;
	let oldExrates;
	let currentLastMintEvent;
	let currentWeekOfInflation;
	let systemSuspended = false;
	let systemSuspendedReason;

	try {
		const oldSynthetix = getExistingContract({ contract: 'Synthetix' });
		currentSynthetixSupply = await oldSynthetix.methods.totalSupply().call();

		// inflationSupplyToDate = total supply - 100m
		const inflationSupplyToDate = w3utils
			.toBN(currentSynthetixSupply)
			.sub(w3utils.toBN(w3utils.toWei((100e6).toString())));

		// current weekly inflation 75m / 52
		const weeklyInflation = w3utils.toBN(w3utils.toWei((75e6 / 52).toString()));
		currentWeekOfInflation = inflationSupplyToDate.div(weeklyInflation);

		// Check result is > 0 else set to 0 for currentWeek
		currentWeekOfInflation = currentWeekOfInflation.gt(w3utils.toBN('0'))
			? currentWeekOfInflation.toNumber()
			: 0;

		// Calculate lastMintEvent as Inflation start date + number of weeks issued * secs in weeks
		const mintingBuffer = 86400;
		const secondsInWeek = 604800;
		const inflationStartDate = inflationStartTimestampInSecs;
		currentLastMintEvent =
			inflationStartDate + currentWeekOfInflation * secondsInWeek + mintingBuffer;
	} catch (err) {
		// if (network === 'local') {
		currentSynthetixSupply = w3utils.toWei((100e6).toString());
		currentWeekOfInflation = 0;
		currentLastMintEvent = 0;
		// } else {
		console.warn(
			yellow(
				'Cannot connect to existing Synthetix contract. Please double check the deploymentPath is correct for the network allocated'
			)
		);
		// process.exitCode = 1;
		// return;
		// }
	}

	try {
		oldExrates = getExistingContract({ contract: 'ExchangeRates' });
		currentSynthetixPrice = await oldExrates.methods.rateForCurrency(toBytes32('BADI')).call();
		if (!oracleExrates) {
			oracleExrates = await oldExrates.methods.oracle().call();
		}
	} catch (err) {
		// if (network === 'local') {
		currentSynthetixPrice = w3utils.toWei('0.2');
		oracleExrates = account;
		oldExrates = undefined; // unset to signify that a fresh one will be deployed
		// } else {
		console.warn(
			yellow(
				'Cannot connect to existing ExchangeRates contract. Please double check the deploymentPath is correct for the network allocated'
			)
		);
		// process.exitCode = 1;
		// return;
		// }
	}

	try {
		const oldSystemStatus = getExistingContract({ contract: 'SystemStatus' });

		const systemSuspensionStatus = await oldSystemStatus.methods.systemSuspension().call();

		systemSuspended = systemSuspensionStatus.suspended;
		systemSuspendedReason = systemSuspensionStatus.reason;
	} catch (err) {
		// if (network !== 'local') {
		console.warn(
			yellow(
				'Cannot connect to existing SystemStatus contract. Please double check the deploymentPath is correct for the network allocated'
			)
		);
		// process.exitCode = 1;
		// return;
		// }
	}

	for (const address of [account, oracleExrates]) {
		if (!w3utils.isAddress(address)) {
			console.error(red('Invalid address detected (please check your inputs):', address));
			process.exitCode = 1;
			return;
		}
	}

	const newSynthsToAdd = synths
		.filter(({ name }) => !config[`Synth${name}`])
		.map(({ name }) => name);

	// let aggregatedPriceResults = 'N/A';

	// if (oldExrates && network !== 'local') {
	// 	const padding = '\n\t\t\t\t';
	// 	const aggResults = await checkAggregatorPrices({
	// 		network,
	// 		providerUrl,
	// 		synths,
	// 		oldExrates,
	// 		standaloneFeeds,
	// 	});
	// 	aggregatedPriceResults = padding + aggResults.join(padding);
	// }

	const deployerBalance = parseInt(
		w3utils.fromWei(await deployer.web3.eth.getBalance(account), 'ether'),
		10
	);
	if (useFork) {
		// Make sure the pwned account has ETH when using a fork
		const accounts = await deployer.web3.eth.getAccounts();

		await deployer.web3.eth.sendTransaction({
			from: accounts[0],
			to: account,
			value: w3utils.toWei('10', 'ether'),
		});
	} else if (deployerBalance < 5) {
		console.log(
			yellow(`??? WARNING: Deployer account balance could be too low: ${deployerBalance} ETH`)
		);
	}

	parameterNotice({
		'Dry Run': dryRun ? green('true') : yellow('??? NO'),
		'Using a fork': useFork ? green('true') : yellow('??? NO'),
		Network: network,
		'Gas price to use': `${gasPrice} GWEI`,
		'Deployment Path': new RegExp(network, 'gi').test(deploymentPath)
			? deploymentPath
			: yellow('????????? cant find network name in path. Please double check this! ') + deploymentPath,
		'Local build last modified': `${new Date(earliestCompiledTimestamp)} ${yellow(
			((new Date().getTime() - earliestCompiledTimestamp) / 60000).toFixed(2) + ' mins ago'
		)}`,
		'Last Solidity update':
			new Date(latestSolTimestamp) +
			(latestSolTimestamp > earliestCompiledTimestamp
				? yellow(' ????????? this is later than the last build! Is this intentional?')
				: green(' ???')),
		'Add any new synths found?': addNewSynths
			? green('??? YES\n\t\t\t\t') + newSynthsToAdd.join(', ')
			: yellow('??? NO'),
		'Deployer account:': account,
		'Synthetix totalSupply': `${Math.round(w3utils.fromWei(currentSynthetixSupply) / 1e6)}m`,
		'ExchangeRates Oracle': oracleExrates,
		'Last Mint Event': `${currentLastMintEvent} (${new Date(currentLastMintEvent * 1000)})`,
		'Current Weeks Of Inflation': currentWeekOfInflation,
		// 'Aggregated Prices': aggregatedPriceResults,
		'System Suspended': systemSuspended
			? green(' ???', 'Reason:', systemSuspendedReason)
			: yellow('??? NO'),
	});

	if (!yes) {
		try {
			await confirmAction(
				yellow(
					`????????? WARNING: This action will deploy the following contracts to ${network}:\n${Object.entries(
						config
					)
						.filter(([, { deploy }]) => deploy)
						.map(([contract]) => contract)
						.join(', ')}` + `\nIt will also set proxy targets and add synths to Synthetix.\n`
				) +
					gray('-'.repeat(50)) +
					'\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	console.log(gray(`Starting deployment to ${network.toUpperCase()}`));

	const runStep = async opts =>
		performTransactionalStep({
			gasLimit: methodCallGasLimit, // allow overriding of gasLimit
			...opts,
			account,
			gasPrice,
			etherscanLinkPrefix,
			ownerActions,
			ownerActionsFile,
			dryRun,
		});

	console.log(gray(`\n------ DEPLOY LIBRARIES ------\n`));

	await deployer.deployContract({
		name: 'SafeDecimalMath',
	});

	await deployer.deployContract({
		name: 'Math',
	});

	console.log(gray(`\n------ DEPLOY CORE PROTOCOL ------\n`));

	const addressOf = c => (c ? c.options.address : '');

	const addressResolver = await deployer.deployContract({
		name: 'AddressResolver',
		args: [account],
	});

	const readProxyForResolver = await deployer.deployContract({
		name: 'ReadProxyAddressResolver',
		source: 'ReadProxy',
		args: [account],
	});

	const resolverAddress = addressOf(addressResolver);

	if (addressResolver && readProxyForResolver) {
		await runStep({
			contract: 'ReadProxyAddressResolver',
			target: readProxyForResolver,
			read: 'target',
			expected: input => input === resolverAddress,
			write: 'setTarget',
			writeArg: resolverAddress,
		});
	}

	await deployer.deployContract({
		name: 'FlexibleStorage',
		deps: ['ReadProxyAddressResolver'],
		args: [addressOf(readProxyForResolver)],
	});

	const systemSettings = await deployer.deployContract({
		name: 'SystemSettings',
		args: [account, resolverAddress],
	});

	const systemStatus = await deployer.deployContract({
		name: 'SystemStatus',
		args: [account],
	});

	const exchangeRates = await deployer.deployContract({
		name: 'ExchangeRates',
		args: [account, oracleExrates, resolverAddress, [toBytes32('BADI')], [currentSynthetixPrice]],
	});

	const rewardEscrow = await deployer.deployContract({
		name: 'RewardEscrow',
		args: [account, ZERO_ADDRESS, ZERO_ADDRESS],
	});

	const synthetixEscrow = await deployer.deployContract({
		name: 'SynthetixEscrow',
		args: [account, ZERO_ADDRESS],
	});

	const synthetixState = await deployer.deployContract({
		name: 'SynthetixState',
		args: [account, account],
	});

	const proxyFeePool = await deployer.deployContract({
		name: 'ProxyFeePool',
		source: 'Proxy',
		args: [account],
	});

	const delegateApprovalsEternalStorage = await deployer.deployContract({
		name: 'DelegateApprovalsEternalStorage',
		source: 'EternalStorage',
		args: [account, ZERO_ADDRESS],
	});

	const delegateApprovals = await deployer.deployContract({
		name: 'DelegateApprovals',
		args: [account, addressOf(delegateApprovalsEternalStorage)],
	});

	if (delegateApprovals && delegateApprovalsEternalStorage) {
		await runStep({
			contract: 'EternalStorage',
			target: delegateApprovalsEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(delegateApprovals),
			write: 'setAssociatedContract',
			writeArg: addressOf(delegateApprovals),
		});
	}

	const liquidations = await deployer.deployContract({
		name: 'Liquidations',
		args: [account, resolverAddress],
	});

	const eternalStorageLiquidations = await deployer.deployContract({
		name: 'EternalStorageLiquidations',
		source: 'EternalStorage',
		args: [account, addressOf(liquidations)],
	});

	if (liquidations && eternalStorageLiquidations) {
		await runStep({
			contract: 'EternalStorageLiquidations',
			target: eternalStorageLiquidations,
			read: 'associatedContract',
			expected: input => input === addressOf(liquidations),
			write: 'setAssociatedContract',
			writeArg: addressOf(liquidations),
		});
	}

	const feePoolEternalStorage = await deployer.deployContract({
		name: 'FeePoolEternalStorage',
		args: [account, ZERO_ADDRESS],
	});

	const feePool = await deployer.deployContract({
		name: 'FeePool',
		deps: ['ProxyFeePool', 'AddressResolver'],
		args: [addressOf(proxyFeePool), account, resolverAddress],
	});

	if (proxyFeePool && feePool) {
		await runStep({
			contract: 'ProxyFeePool',
			target: proxyFeePool,
			read: 'target',
			expected: input => input === addressOf(feePool),
			write: 'setTarget',
			writeArg: addressOf(feePool),
		});
	}

	if (feePoolEternalStorage && feePool) {
		await runStep({
			contract: 'FeePoolEternalStorage',
			target: feePoolEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(feePool),
			write: 'setAssociatedContract',
			writeArg: addressOf(feePool),
		});
	}

	const feePoolState = await deployer.deployContract({
		name: 'FeePoolState',
		deps: ['FeePool'],
		args: [account, addressOf(feePool)],
	});

	if (feePool && feePoolState) {
		// Rewire feePoolState if there is a feePool upgrade
		await runStep({
			contract: 'FeePoolState',
			target: feePoolState,
			read: 'feePool',
			expected: input => input === addressOf(feePool),
			write: 'setFeePool',
			writeArg: addressOf(feePool),
		});
	}

	const rewardsDistribution = await deployer.deployContract({
		name: 'RewardsDistribution',
		deps: ['RewardEscrow', 'ProxyFeePool'],
		args: [
			account, // owner
			ZERO_ADDRESS, // authority (synthetix)
			ZERO_ADDRESS, // Synthetix Proxy
			addressOf(rewardEscrow),
			addressOf(proxyFeePool),
		],
	});

	// constructor(address _owner, uint _lastMintEvent, uint _currentWeek)
	const supplySchedule = await deployer.deployContract({
		name: 'SupplySchedule',
		args: [account, currentLastMintEvent, currentWeekOfInflation],
	});

	// New Synthetix proxy.
	const proxyERC20Synthetix = await deployer.deployContract({
		name: 'ProxyERC20',
		args: [account],
	});

	const tokenStateSynthetix = await deployer.deployContract({
		name: 'TokenStateSynthetix',
		source: 'TokenState',
		args: [account, account],
	});

	const synthetix = await deployer.deployContract({
		name: 'Synthetix',
		deps: ['ProxyERC20', 'TokenStateSynthetix', 'AddressResolver'],
		args: [
			addressOf(proxyERC20Synthetix),
			addressOf(tokenStateSynthetix),
			account,
			currentSynthetixSupply,
			resolverAddress,
		],
	});

	if (synthetix && proxyERC20Synthetix) {
		await runStep({
			contract: 'ProxyERC20',
			target: proxyERC20Synthetix,
			read: 'target',
			expected: input => input === addressOf(synthetix),
			write: 'setTarget',
			writeArg: addressOf(synthetix),
		});
		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			read: 'proxy',
			expected: input => input === addressOf(proxyERC20Synthetix),
			write: 'setProxy',
			writeArg: addressOf(proxyERC20Synthetix),
		});
	}

	// Old Synthetix proxy based off Proxy.sol: this has been deprecated.
	// To be removed after May 30, 2020:
	// https://docs.synthetix.io/integrations/guide/#proxy-deprecation
	// const proxySynthetix = await deployer.deployContract({
	// 	name: 'ProxySynthetix',
	// 	source: 'Proxy',
	// 	args: [account],
	// });
	// if (proxySynthetix && synthetix) {
	// 	await runStep({
	// 		contract: 'ProxySynthetix',
	// 		target: proxySynthetix,
	// 		read: 'target',
	// 		expected: input => input === addressOf(synthetix),
	// 		write: 'setTarget',
	// 		writeArg: addressOf(synthetix),
	// 	});
	// 	await runStep({
	// 		contract: 'Synthetix',
	// 		target: synthetix,
	// 		read: 'integrationProxy',
	// 		expected: input => input === addressOf(proxySynthetix),
	// 		write: 'setIntegrationProxy',
	// 		writeArg: addressOf(proxySynthetix),
	// 	});
	// }

	const exchanger = await deployer.deployContract({
		name: 'Exchanger',
		deps: ['AddressResolver'],
		args: [account, resolverAddress],
	});

	const exchangeState = await deployer.deployContract({
		name: 'ExchangeState',
		deps: ['Exchanger'],
		args: [account, addressOf(exchanger)],
	});

	if (exchanger && exchangeState) {
		// The exchangeState contract has Exchanger as it's associated contract
		await runStep({
			contract: 'ExchangeState',
			target: exchangeState,
			read: 'associatedContract',
			expected: input => input === exchanger.options.address,
			write: 'setAssociatedContract',
			writeArg: exchanger.options.address,
		});
	}

	if (exchanger && systemStatus) {
		// SIP-65: ensure Exchanger can suspend synths if price spikes occur
		await runStep({
			contract: 'SystemStatus',
			target: systemStatus,
			read: 'accessControl',
			readArg: [toBytes32('Synth'), addressOf(exchanger)],
			expected: ({ canSuspend }) => canSuspend,
			write: 'updateAccessControl',
			writeArg: [toBytes32('Synth'), addressOf(exchanger), true, false],
		});
	}

	// only reset token state if redeploying
	if (tokenStateSynthetix && config['TokenStateSynthetix'].deploy) {
		const initialIssuance = w3utils.toWei('100000000');
		await runStep({
			contract: 'TokenStateSynthetix',
			target: tokenStateSynthetix,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
		});
	}

	if (tokenStateSynthetix && synthetix) {
		await runStep({
			contract: 'TokenStateSynthetix',
			target: tokenStateSynthetix,
			read: 'associatedContract',
			expected: input => input === addressOf(synthetix),
			write: 'setAssociatedContract',
			writeArg: addressOf(synthetix),
		});
	}

	if (tokenStateSynthetix && synthetix) {
		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			read: 'tokenState',
			expected: input => input === addressOf(tokenStateSynthetix),
			write: 'setTokenState',
			writeArg: addressOf(tokenStateSynthetix),
		});
	}

	const issuer = await deployer.deployContract({
		name: 'Issuer',
		deps: ['AddressResolver'],
		args: [account, addressOf(addressResolver)],
	});

	const issuerAddress = addressOf(issuer);

	await deployer.deployContract({
		name: 'TradingRewards',
		deps: ['AddressResolver', 'Exchanger'],
		args: [account, account, resolverAddress],
	});

	if (synthetixState && issuer) {
		// The SynthetixState contract has Issuer as it's associated contract (after v2.19 refactor)
		await runStep({
			contract: 'SynthetixState',
			target: synthetixState,
			read: 'associatedContract',
			expected: input => input === issuerAddress,
			write: 'setAssociatedContract',
			writeArg: issuerAddress,
		});
	}

	if (synthetixEscrow) {
		await deployer.deployContract({
			name: 'EscrowChecker',
			deps: ['SynthetixEscrow'],
			args: [addressOf(synthetixEscrow)],
		});
	}

	if (rewardEscrow && synthetix) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'synthetix',
			expected: input => input === addressOf(synthetix),
			write: 'setSynthetix',
			writeArg: addressOf(synthetix),
		});
	}

	if (rewardEscrow && feePool) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'feePool',
			expected: input => input === addressOf(feePool),
			write: 'setFeePool',
			writeArg: addressOf(feePool),
		});
	}

	if (supplySchedule && synthetix) {
		await runStep({
			contract: 'SupplySchedule',
			target: supplySchedule,
			read: 'synthetixProxy',
			expected: input => input === addressOf(proxyERC20Synthetix),
			write: 'setSynthetixProxy',
			writeArg: addressOf(proxyERC20Synthetix),
		});
	}

	if (synthetix && rewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'authority',
			expected: input => input === addressOf(synthetix),
			write: 'setAuthority',
			writeArg: addressOf(synthetix),
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'synthetixProxy',
			expected: input => input === addressOf(proxyERC20Synthetix),
			write: 'setSynthetixProxy',
			writeArg: addressOf(proxyERC20Synthetix),
		});
	}

	// ----------------
	// Setting proxyERC20 Synthetix for synthetixEscrow
	// ----------------

	// Skip setting unless redeploying either of these,
	if (synthetix && synthetixEscrow) {
		// Note: currently on mainnet SynthetixEscrow.methods.synthetix() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		// if (network === 'mainnet') {
		// 	await runStep({
		// 		contract: 'SynthetixEscrow',
		// 		target: synthetixEscrow,
		// 		read: 'havven',
		// 		expected: input => input === addressOf(proxyERC20Synthetix),
		// 		write: 'setHavven',
		// 		writeArg: addressOf(proxyERC20Synthetix),
		// 	});
		// } else {
		await runStep({
			contract: 'SynthetixEscrow',
			target: synthetixEscrow,
			read: 'synthetix',
			expected: input => input === addressOf(proxyERC20Synthetix),
			write: 'setSynthetix',
			writeArg: addressOf(proxyERC20Synthetix),
		});
		// }
	}

	// ----------------
	// Synths
	// ----------------
	console.log(gray(`\n------ DEPLOY SYNTHS ------\n`));

	for (const { name: currencyKey, subclass, asset } of synths) {
		console.log(gray(`\n   --- SYNTH ${currencyKey} ---\n`));

		const tokenStateForSynth = await deployer.deployContract({
			name: `TokenState${currencyKey}`,
			source: 'TokenState',
			args: [account, ZERO_ADDRESS],
			force: addNewSynths,
		});

		// Legacy proxy will be around until May 30, 2020
		// https://docs.synthetix.io/integrations/guide/#proxy-deprecation
		// Until this time, on mainnet we will still deploy ProxyERC20sUSD and ensure that
		// SynthsUSD.proxy is ProxyERC20sUSD, SynthsUSD.integrationProxy is ProxysUSD
		// const synthProxyIsLegacy = currencyKey === 'sUSD' && network === 'mainnet';

		const proxyForSynth = await deployer.deployContract({
			name: `Proxy${currencyKey}`,
			// source: synthProxyIsLegacy ? 'Proxy' : 'ProxyERC20',
			source: 'ProxyERC20',
			args: [account],
			force: addNewSynths,
		});

		// additionally deploy an ERC20 proxy for the synth if it's legacy (sUSD)
		// let proxyERC20ForSynth;
		// if (currencyKey === 'sUSD') {
		// 	proxyERC20ForSynth = await deployer.deployContract({
		// 		name: `ProxyERC20${currencyKey}`,
		// 		source: `ProxyERC20`,
		// 		args: [account],
		// 		force: addNewSynths,
		// 	});
		// }

		const currencyKeyInBytes = toBytes32(currencyKey);

		const synthConfig = config[`Synth${currencyKey}`] || {};

		// track the original supply if we're deploying a new synth contract for an existing synth
		let originalTotalSupply = 0;
		if (synthConfig.deploy) {
			try {
				const oldSynth = getExistingContract({ contract: `Synth${currencyKey}` });
				originalTotalSupply = await oldSynth.methods.totalSupply().call();
			} catch (err) {
				if (network !== 'local') {
					// only throw if not local - allows local environments to handle both new
					// and updating configurations
					console.warn(
						yellow(
							'Cannot connect to existing Synth${currencyKey} contract. Please double check the deploymentPath is correct for the network allocated'
						)
					);
				}
			}
		}

		// MultiCollateral needs additionalConstructorArgs to be ordered
		const additionalConstructorArgsMap = {
			// MultiCollateralSynth: [toBytes32('EtherCollateral')],
			// future subclasses...
		};

		// user confirm totalSupply is correct for oldSynth before deploy new Synth
		if (synthConfig.deploy && !yes && originalTotalSupply > 0) {
			try {
				await confirmAction(
					yellow(
						`????????? WARNING: Please confirm - ${network}:\n` +
							`Synth${currencyKey} totalSupply is ${originalTotalSupply} \n`
					) +
						gray('-'.repeat(50)) +
						'\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		const sourceContract = subclass || 'Synth';
		const synth = await deployer.deployContract({
			name: `Synth${currencyKey}`,
			source: sourceContract,
			deps: [`TokenState${currencyKey}`, `Proxy${currencyKey}`, 'Synthetix', 'FeePool'],
			args: [
				// proxyERC20ForSynth ? addressOf(proxyERC20ForSynth) : addressOf(proxyForSynth),
				addressOf(proxyForSynth),
				addressOf(tokenStateForSynth),
				`Synth ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				originalTotalSupply,
				resolverAddress,
			].concat(additionalConstructorArgsMap[sourceContract] || []),
			force: addNewSynths,
		});

		if (tokenStateForSynth && synth) {
			await runStep({
				contract: `TokenState${currencyKey}`,
				target: tokenStateForSynth,
				read: 'associatedContract',
				expected: input => input === addressOf(synth),
				write: 'setAssociatedContract',
				writeArg: addressOf(synth),
			});
		}

		// Setup proxy for synth
		if (proxyForSynth && synth) {
			await runStep({
				contract: `Proxy${currencyKey}`,
				target: proxyForSynth,
				read: 'target',
				expected: input => input === addressOf(synth),
				write: 'setTarget',
				writeArg: addressOf(synth),
			});

			// Migration Phrase 2: if there's a ProxyERC20sUSD then the Synth's proxy must use it
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'proxy',
				expected: input => input === addressOf(proxyForSynth),
				write: 'setProxy',
				writeArg: addressOf(proxyForSynth),
			});

			// if (proxyERC20ForSynth) {
			// 	// Migration Phrase 2: if there's a ProxyERC20sUSD then the Synth's integration proxy must
			// 	await runStep({
			// 		contract: `Synth${currencyKey}`,
			// 		target: synth,
			// 		read: 'integrationProxy',
			// 		expected: input => input === addressOf(proxyForSynth),
			// 		write: 'setIntegrationProxy',
			// 		writeArg: addressOf(proxyForSynth),
			// 	});

			// 	// and make sure this new proxy has the target of the synth
			// 	await runStep({
			// 		contract: `ProxyERC20${currencyKey}`,
			// 		target: proxyERC20ForSynth,
			// 		read: 'target',
			// 		expected: input => input === addressOf(synth),
			// 		write: 'setTarget',
			// 		writeArg: addressOf(synth),
			// 	});
			// }
		}

		// Now setup connection to the Synth with Synthetix
		if (synth && issuer) {
			await runStep({
				contract: 'Issuer',
				target: issuer,
				read: 'synths',
				readArg: currencyKeyInBytes,
				expected: input => input === addressOf(synth),
				write: 'addSynth',
				writeArg: addressOf(synth),
			});
		}

		const { feed, t } = feeds[asset] || {};

		// now setup price aggregator if any for the synth
		if (w3utils.isAddress(feed) && exchangeRates && t == 'chainlink') {
			await runStep({
				contract: `ExchangeRates`,
				target: exchangeRates,
				read: 'aggregators',
				readArg: currencyKeyInBytes,
				expected: input => input === feed,
				write: 'addAggregator',
				writeArg: [currencyKeyInBytes, feed],
			});
		}
	}

	// console.log(gray(`\n------ DEPLOY ANCILLARY CONTRACTS ------\n`));
	//
	// await deployer.deployContract({
	// 	name: 'Depot',
	// 	deps: ['ProxyERC20', 'SynthsUSD', 'FeePool'],
	// 	args: [account, account, resolverAddress],
	// });
	//
	// await deployer.deployContract({
	// 	name: 'EtherCollateral',
	// 	deps: ['AddressResolver'],
	// 	args: [account, resolverAddress],
	// });

	// ----------------
	// Binary option market factory and manager setup
	// ----------------

	// console.log(gray(`\n------ DEPLOY BINARY OPTIONS ------\n`));

	// await deployer.deployContract({
	// 	name: 'BinaryOptionMarketFactory',
	// 	args: [account, resolverAddress],
	// 	deps: ['AddressResolver'],
	// });

	// const day = 24 * 60 * 60;
	// const maxOraclePriceAge = 120 * 60; // Price updates are accepted from up to two hours before maturity to allow for delayed chainlink heartbeats.
	// const expiryDuration = 26 * 7 * day; // Six months to exercise options before the market is destructible.
	// const maxTimeToMaturity = 730 * day; // Markets may not be deployed more than two years in the future.
	// const creatorCapitalRequirement = w3utils.toWei('1000'); // 1000 sUSD is required to create a new market.
	// const creatorSkewLimit = w3utils.toWei('0.05'); // Market creators must leave 5% or more of their position on either side.
	// const poolFee = w3utils.toWei('0.008'); // 0.8% of the market's value goes to the pool in the end.
	// const creatorFee = w3utils.toWei('0.002'); // 0.2% of the market's value goes to the creator.
	// const refundFee = w3utils.toWei('0.05'); // 5% of a bid stays in the pot if it is refunded.
	// await deployer.deployContract({
	// 	name: 'BinaryOptionMarketManager',
	// 	args: [
	// 		account,
	// 		resolverAddress,
	// 		maxOraclePriceAge,
	// 		expiryDuration,
	// 		maxTimeToMaturity,
	// 		creatorCapitalRequirement,
	// 		creatorSkewLimit,
	// 		poolFee,
	// 		creatorFee,
	// 		refundFee,
	// 	],
	// 	deps: ['AddressResolver'],
	// });

	// console.log(gray(`\n------ DEPLOY DAPP UTILITIES ------\n`));

	await deployer.deployContract({
		name: 'SynthUtil',
		deps: ['ReadProxyAddressResolver'],
		args: [addressOf(readProxyForResolver)],
	});

	await deployer.deployContract({
		name: 'DappMaintenance',
		args: [account],
	});

	// await deployer.deployContract({
	// 	name: 'BinaryOptionMarketData',
	// });

	console.log(gray(`\n------ CONFIGURE STANDLONE FEEDS ------\n`));

	// Setup remaining price feeds (that aren't synths)

	for (const sf of standaloneFeeds) {
		const { asset, feed, t } = sf;
		if (w3utils.isAddress(feed) && exchangeRates) {
			if (t == 'chainlink') {
				await runStep({
					contract: `ExchangeRates`,
					target: exchangeRates,
					read: 'aggregators',
					readArg: toBytes32(asset),
					expected: input => input === feed,
					write: 'addAggregator',
					writeArg: [toBytes32(asset), feed],
				});
				// eslint-disable-next-line eqeqeq
			} else if (t == 'swap') {
				if (asset == 'BADI') {
					const swapOracle = await deployer.deployContract({
						name: 'SwapOracle',
						args: [account, feed, addressOf(proxyERC20Synthetix), 60, addressOf(exchangeRates)],
					});
					if (swapOracle) {
						await runStep({
							contract: `ExchangeRates`,
							target: exchangeRates,
							read: 'oracle',
							expected: input => input === addressOf(swapOracle),
							write: 'setOracle',
							writeArg: [addressOf(swapOracle)],
						});
					}
				}
			}
		}
	}

	console.log(gray(`\n------ CONFIGURE ADDRESS RESOLVER ------\n`));

	if (addressResolver) {
		// collect all required addresses on-chain
		const allRequiredAddressesInContracts = await Promise.all(
			Object.entries(deployer.deployedContracts)
				.filter(([, target]) =>
					target.options.jsonInterface.find(({ name }) => name === 'getResolverAddressesRequired')
				)
				.map(([, target]) =>
					// Note: if running a dryRun then the output here will only be an estimate, as
					// the correct list of addresses require the contracts be deployed so these entries can then be read.
					(
						target.methods.getResolverAddressesRequired().call() ||
						// if dryRun and the contract is new then there's nothing to read on-chain, so resolve []
						Promise.resolve([])
					).then(names => names.map(w3utils.hexToUtf8))
				)
		);
		const allRequiredAddresses = Array.from(
			// create set to remove dupes
			new Set(
				// flatten into one array and remove blanks
				allRequiredAddressesInContracts
					.reduce((memo, entry) => memo.concat(entry), [])
					.filter(entry => entry)
					// Note: The below are required for Depot.sol and EtherCollateral.sol
					// but as these contracts cannot be redeployed yet (they have existing value)
					// we cannot look up their dependencies on-chain. (since Hadar v2.21)
					// .concat(['SynthsUSD', 'SynthsETH', 'Depot', 'EtherCollateral', 'SystemSettings'])
					.concat(['SynthsUSD', 'SynthsETH', 'SystemSettings'])
			)
		).sort();

		// now map these into a list of names and addreses
		const expectedAddressesInResolver = allRequiredAddresses.map(name => {
			const contract = deployer.deployedContracts[name];
			// quick sanity check of names in expected list
			if (!contract) {
				throw Error(
					`Error setting up AddressResolver: cannot find one of the contracts listed as required in a contract: ${name} in the list of deployment targets`
				);
			}
			return {
				name,
				address: addressOf(contract),
			};
		});

		// Count how many addresses are not yet in the resolver
		const addressesNotInResolver = (
			await Promise.all(
				expectedAddressesInResolver.map(({ name, address }) => {
					// when a dryRun redeploys a new AddressResolver, this will return undefined, so instead resolve with
					// empty promise
					const promise =
						addressResolver.methods.getAddress(toBytes32(name)).call() || Promise.resolve();

					return promise.then(foundAddress => ({ name, address, found: address === foundAddress }));
				})
			)
		).filter(entry => !entry.found);

		// and add everything if any not found (will overwrite any conflicts)
		if (addressesNotInResolver.length > 0) {
			console.log(
				gray(
					`Detected ${addressesNotInResolver.length} / ${expectedAddressesInResolver.length} missing or incorrect in the AddressResolver.\n\t` +
						addressesNotInResolver.map(({ name, address }) => `${name} ${address}`).join('\n\t') +
						`\nAdding all addresses in one transaction.`
				)
			);
			await runStep({
				gasLimit: 750e3, // higher gas required
				contract: `AddressResolver`,
				target: addressResolver,
				write: 'importAddresses',
				writeArg: [
					addressesNotInResolver.map(({ name }) => toBytes32(name)),
					addressesNotInResolver.map(({ address }) => address),
				],
			});
		}

		// Now for all targets that have a setResolverAndSyncCache, we need to ensure the resolver is set
		for (const [contract, target] of Object.entries(deployer.deployedContracts)) {
			// old "setResolver" for Depot, from prior to SIP-48
			const setResolverFncEntry = target.options.jsonInterface.find(
				({ name }) => name === 'setResolverAndSyncCache' || name === 'setResolver'
			);

			if (setResolverFncEntry) {
				// prior to SIP-46, contracts used setResolver and had no check
				const isPreSIP46 = setResolverFncEntry.name === 'setResolver';
				await runStep({
					gasLimit: 750e3, // higher gas required
					contract,
					target,
					read: isPreSIP46 ? 'resolver' : 'isResolverCached',
					readArg: isPreSIP46 ? undefined : resolverAddress,
					expected: input => (isPreSIP46 ? input === resolverAddress : input),
					write: isPreSIP46 ? 'setResolver' : 'setResolverAndSyncCache',
					writeArg: resolverAddress,
				});
			}
		}
	}

	// now after resolvers have been set
	console.log(gray(`\n------ CONFIGURE INVERSE SYNTHS ------\n`));

	for (const { name: currencyKey, inverted } of synths) {
		if (inverted) {
			const { entryPoint, upperLimit, lowerLimit } = inverted;

			// helper function
			const setInversePricing = ({ freezeAtUpperLimit, freezeAtLowerLimit }) =>
				runStep({
					contract: 'ExchangeRates',
					target: exchangeRates,
					write: 'setInversePricing',
					writeArg: [
						toBytes32(currencyKey),
						w3utils.toWei(entryPoint.toString()),
						w3utils.toWei(upperLimit.toString()),
						w3utils.toWei(lowerLimit.toString()),
						freezeAtUpperLimit,
						freezeAtLowerLimit,
					],
				});

			// when the oldExrates exists - meaning there is a valid ExchangeRates in the existing deployment.json
			// for this environment (true for all environments except the initial deploy in 'local' during those tests)
			if (oldExrates) {
				// get inverse synth's params from the old exrates, if any exist
				const {
					entryPoint: oldEntryPoint,
					upperLimit: oldUpperLimit,
					lowerLimit: oldLowerLimit,
					frozenAtUpperLimit: currentRateIsFrozenUpper,
					frozenAtLowerLimit: currentRateIsFrozenLower,
				} = await oldExrates.methods.inversePricing(toBytes32(currencyKey)).call();

				const currentRateIsFrozen = currentRateIsFrozenUpper || currentRateIsFrozenLower;
				// and the last rate if any exists
				const currentRateForCurrency = await oldExrates.methods
					.rateForCurrency(toBytes32(currencyKey))
					.call();

				// and total supply, if any
				const synth = deployer.deployedContracts[`Synth${currencyKey}`];
				const totalSynthSupply = await synth.methods.totalSupply().call();
				console.log(gray(`totalSupply of ${currencyKey}: ${Number(totalSynthSupply)}`));

				// When there's an inverted synth with matching parameters
				if (
					entryPoint === +w3utils.fromWei(oldEntryPoint) &&
					upperLimit === +w3utils.fromWei(oldUpperLimit) &&
					lowerLimit === +w3utils.fromWei(oldLowerLimit)
				) {
					if (oldExrates.options.address !== addressOf(exchangeRates)) {
						const freezeAtUpperLimit = +w3utils.fromWei(currentRateForCurrency) === upperLimit;
						const freezeAtLowerLimit = +w3utils.fromWei(currentRateForCurrency) === lowerLimit;
						console.log(
							gray(
								`Detected an existing inverted synth for ${currencyKey} with identical parameters and a newer ExchangeRates. ` +
									`Persisting its frozen status (${currentRateIsFrozen}) and if frozen, then freeze rate at upper (${freezeAtUpperLimit}) or lower (${freezeAtLowerLimit}).`
							)
						);

						// then ensure it gets set to the same frozen status and frozen rate
						// as the old exchange rates
						await setInversePricing({
							freezeAtUpperLimit,
							freezeAtLowerLimit,
						});
					} else {
						console.log(
							gray(
								`Detected an existing inverted synth for ${currencyKey} with identical parameters and no new ExchangeRates. Skipping check of frozen status.`
							)
						);
					}
				} else if (Number(currentRateForCurrency) === 0) {
					console.log(gray(`Detected a new inverted synth for ${currencyKey}. Proceeding to add.`));
					// Then a new inverted synth is being added (as there's no previous rate for it)
					await setInversePricing({ freezeAtUpperLimit: false, freezeAtLowerLimit: false });
				} else if (Number(totalSynthSupply) === 0) {
					console.log(
						gray(
							`Inverted synth at ${currencyKey} has 0 total supply and its inverted parameters have changed. ` +
								`Proceeding to reconfigure its parameters as instructed, unfreezing it if currently frozen.`
						)
					);
					// Then a new inverted synth is being added (as there's no existing supply)
					await setInversePricing({ freezeAtUpperLimit: false, freezeAtLowerLimit: false });
				} else if (network !== 'mainnet' && forceUpdateInverseSynthsOnTestnet) {
					// as we are on testnet and the flag is enabled, allow a mutative pricing change
					console.log(
						redBright(
							`????????? WARNING: The parameters for the inverted synth ${currencyKey} ` +
								`have changed and it has non-zero totalSupply. This is allowed only on testnets`
						)
					);
					await setInversePricing({ freezeAtUpperLimit: false, freezeAtLowerLimit: false });
				} else {
					// Then an existing synth's inverted parameters have changed.
					// For safety sake, let's inform the user and skip this step
					console.log(
						redBright(
							`????????? WARNING: The parameters for the inverted synth ${currencyKey} ` +
								`have changed and it has non-zero totalSupply. This use-case is not supported by the deploy script. ` +
								`This should be done as a purge() and setInversePricing() separately`
						)
					);
				}
			} else {
				// When no exrates, then totally fresh deploy (local deployment)
				await setInversePricing({ freezeAtUpperLimit: false, freezeAtLowerLimit: false });
			}
		}
	}

	// then ensure the defaults of SystemSetting
	// are set (requires FlexibleStorage to have been correctly configured)
	if (systemSettings) {
		console.log(gray(`\n------ CONFIGURE SYSTEM SETTINGS ------\n`));

		// Now ensure all the fee rates are set for various synths (this must be done after the AddressResolver
		// has populated all references).
		// Note: this populates rates for new synths regardless of the addNewSynths flag
		const synthRates = await Promise.all(
			synths.map(({ name }) => systemSettings.methods.exchangeFeeRate(toBytes32(name)).call())
		);

		const synthsRatesToUpdate = synths
			.map((synth, i) =>
				Object.assign(
					{
						currentRate: w3utils.fromWei(synthRates[i] || '0'),
						targetRate: EXCHANGE_FEE_RATES[synth.category],
					},
					synth
				)
			)
			.filter(({ currentRate }) => currentRate === '0');

		console.log(gray(`Found ${synthsRatesToUpdate.length} synths needs exchange rate pricing`));

		if (synthsRatesToUpdate.length) {
			console.log(
				gray(
					'Setting the following:',
					synthsRatesToUpdate
						.map(
							({ name, targetRate, currentRate }) =>
								`\t${name} from ${currentRate * 100}% to ${w3utils.fromWei(targetRate) * 100}%`
						)
						.join('\n')
				)
			);

			await runStep({
				gasLimit: Math.max(methodCallGasLimit, 40e3 * synthsRatesToUpdate.length), // higher gas required, 40k per synth is sufficient
				contract: 'SystemSettings',
				target: systemSettings,
				write: 'setExchangeFeeRateForSynths',
				writeArg: [
					synthsRatesToUpdate.map(({ name }) => toBytes32(name)),
					synthsRatesToUpdate.map(({ targetRate }) => targetRate),
				],
			});
		}

		// setup initial values if they are unset
		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'waitingPeriodSecs',
			expected: input => input !== '0',
			write: 'setWaitingPeriodSecs',
			writeArg: WAITING_PERIOD_SECS,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'priceDeviationThresholdFactor',
			expected: input => input !== '0', // only change if non-zero
			write: 'setPriceDeviationThresholdFactor',
			writeArg: PRICE_DEVIATION_THRESHOLD_FACTOR,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'tradingRewardsEnabled',
			expected: input => input === TRADING_REWARDS_ENABLED, // only change if non-default
			write: 'setTradingRewardsEnabled',
			writeArg: TRADING_REWARDS_ENABLED,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'issuanceRatio',
			expected: input => input !== '0', // only change if non-zero
			write: 'setIssuanceRatio',
			writeArg: ISSUANCE_RATIO,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'feePeriodDuration',
			expected: input => input !== '0', // only change if non-zero
			write: 'setFeePeriodDuration',
			writeArg: FEE_PERIOD_DURATION,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'targetThreshold',
			expected: input => input !== '0', // only change if non-zero
			write: 'setTargetThreshold',
			writeArg: TARGET_THRESHOLD,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'liquidationDelay',
			expected: input => input !== '0', // only change if non-zero
			write: 'setLiquidationDelay',
			writeArg: LIQUIDATION_DELAY,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'liquidationRatio',
			expected: input => input !== '0', // only change if non-zero
			write: 'setLiquidationRatio',
			writeArg: LIQUIDATION_RATIO,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'liquidationPenalty',
			expected: input => input !== '0', // only change if non-zero
			write: 'setLiquidationPenalty',
			writeArg: LIQUIDATION_PENALTY,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'rateStalePeriod',
			expected: input => input !== '0', // only change if non-zero
			write: 'setRateStalePeriod',
			writeArg: RATE_STALE_PERIOD,
		});

		await runStep({
			contract: 'SystemSettings',
			target: systemSettings,
			read: 'minimumStakeTime',
			expected: input => input !== '0', // only change if non-zero
			write: 'setMinimumStakeTime',
			writeArg: MINIMUM_STAKE_TIME,
		});

		const aggregatorWarningFlags = AGGREGATOR_WARNING_FLAGS[network];

		if (aggregatorWarningFlags) {
			await runStep({
				contract: 'SystemSettings',
				target: systemSettings,
				read: 'aggregatorWarningFlags',
				expected: input => input !== ZERO_ADDRESS, // only change if non-zero
				write: 'setAggregatorWarningFlags',
				writeArg: aggregatorWarningFlags,
			});
		}
	}
	console.log(gray(`\n------ deployment.json --------\n`));
	Object.values(deployer.deployment.targets).forEach(a => {
		console.log(`${a.name}: "${a.address}",`);
	});

	console.log(gray(`\n------ DEPLOY COMPLETE ------\n`));

	console.log(
		green(`\nSuccessfully deployed ${deployer.newContractsDeployed.length} contracts!\n`)
	);

	const tableData = deployer.newContractsDeployed.map(({ name, address }) => [
		name,
		address,
		`${etherscanLinkPrefix}/address/${address}`,
	]);
	console.log();
	if (tableData.length) {
		console.log(gray(`All contracts deployed on "${network}" network:`));
		console.log(table(tableData));
	} else {
		console.log(gray('Note: No new contracts deployed.'));
	}
};

module.exports = {
	deploy,
	DEFAULTS,
	cmd: program =>
		program
			.command('deploy')
			.description('Deploy compiled solidity files')
			.option(
				'-a, --add-new-synths',
				`Whether or not any new synths in the ${SYNTHS_FILENAME} file should be deployed if there is no entry in the config file`
			)
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				DEFAULTS.buildPath
			)
			.option(
				'-c, --contract-deployment-gas-limit <value>',
				'Contract deployment gas limit',
				parseInt,
				DEFAULTS.contractDeploymentGasLimit
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME}, the synth list ${SYNTHS_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option(
				'-f, --fee-auth <value>',
				'The address of the fee authority for this network (default is to use existing)'
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option(
				'-l, --oracle-gas-limit <value>',
				'The address of the gas limit oracle for this network (default is use existing)'
			)
			.option(
				'-m, --method-call-gas-limit <value>',
				'Method call gas limit',
				parseInt,
				DEFAULTS.methodCallGasLimit
			)
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-o, --oracle-exrates <value>',
				'The address of the oracle for this network (default is use existing)'
			)
			.option(
				'-r, --dry-run',
				'If enabled, will not run any transactions but merely report on them.'
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-u, --force-update-inverse-synths-on-testnet',
				'Allow inverse synth pricing to be updated on testnet regardless of total supply'
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.option(
				'-k, --use-fork',
				'Perform the deployment on a forked chain running on localhost (see fork command).',
				false
			)
			.action(async (...args) => {
				try {
					await deploy(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}
			}),
};
