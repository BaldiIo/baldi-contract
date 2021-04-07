'use strict';

const { artifacts, contract, web3, legacy } = require('@nomiclabs/buidler');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { currentTime, fastForward, toUnit, bytesToString } = require('../utils')();
const { setupContract, setupAllContracts } = require('./setup');

const BigNumber = require('bignumber.js');
const fixed = num => {
	return new BigNumber(num).toFixed();
};

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
	defaults: { RATE_STALE_PERIOD },
} = require('../..');

const { toBN } = require('web3-utils');

contract('SwapOracle', async accounts => {
	const [deployerAccount, owner, accountOne, accountTwo] = accounts;

	let mockPair;
	let oracle;
	let syn;
	let rates;
	let ct;

	before(async () => {
		({
			Synthetix: syn,
			ExchangeRates: rates,
			// SystemSettings: systemSettings,
			// AddressResolver: resolver,
		} = await setupAllContracts({
			accounts,
			contracts: ['Synthetix', 'ExchangeRates', 'SystemSettings', 'AddressResolver'],
		}));
		ct = await currentTime();
		// create but don't connect up the mock flags interface yet
		mockPair = await artifacts.require('MockSwapPair').new();
		const token1 = await artifacts.require('MockERC20').new('USDT', 'USDT', 18, { from: owner });

		await mockPair.setToken1(syn.address);
		await mockPair.setToken0(token1.address);

		await mockPair.update(
			toBN('100010031093380150453'),
			toBN('99990000000000000000'),
			ct,
			toBN('685383185326597246966025515457052672'),
			toBN('685383185326597246966025515457052672')
		);
		// address _owner, address _pair, address _token, uint _period, address _exchangeRates
		oracle = await artifacts
			.require('SwapOracle')
			.new(owner, mockPair.address, syn.address, 60, rates.address, { from: owner });
		await rates.setOracle(oracle.address, { from: owner });
	});
	addSnapshotBeforeRestoreAfterEach();
	describe('update', () => {
		it('should revert while period not elapsed', async () => {
			await assert.revert(oracle.update(), 'period not elapsed');
			fastForward(50);
			await assert.revert(oracle.update(), 'period not elapsed');
		});

		it('should revert when set period by non-owner', async () => {
			await assert.revert(
				oracle.setPeriod(10, { from: deployerAccount }),
				' Only the contract owner may perform this action'
			);
			oracle.setPeriod(60, { from: owner });
		});

		it('update should be success after period', async () => {
			assert.equal(await rates.oracle(), oracle.address);

			fastForward(60);
			await oracle.update();
			const price = await oracle.averagePrice();
			assert.bnEqual(price, toBN('1000200330966898315'));

			fastForward(500);
			await oracle.update();
			const price1 = await oracle.averagePrice();

			assert.bnEqual(price, price1);

			const erates = await rates.rateForCurrency(toBytes32('SNX'));
			assert.bnEqual(price1, erates);
		});
	});
	describe('different decimals', () => {
		it('should be success', async () => {
			const mockPairDecimal = await artifacts.require('MockSwapPair').new();

			const token1 = await artifacts.require('MockERC20').new('USDT', 'USDT', 6, { from: owner });
			mockPairDecimal.setToken0(token1.address);
			mockPairDecimal.setToken1(syn.address);

			await mockPairDecimal.update(
				toBN('51000000'),
				toBN('49022491519108967195'),
				ct,
				toBN('4813259187861785211647770097187028992000000000000'),
				toBN('4813259187861785211647310')
			);
			const oracle2 = await artifacts
				.require('SwapOracle')
				.new(owner, mockPairDecimal.address, syn.address, 60, rates.address, { from: owner });
			await rates.setOracle(oracle2.address, { from: owner });
			fastForward(60);
			await oracle2.update();
			const price = await oracle2.averagePrice();
			assert.bnEqual(price, toBN('1040338000000000000'));
		});
	});
});
