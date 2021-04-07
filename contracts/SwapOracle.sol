pragma solidity ^0.5.16;

import "./Owned.sol";
import "./MixinResolver.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IERC20.sol";


library FixedPoint {
    // range: [0, 2**112 - 1]
    // resolution: 1 / 2**112
    struct uq112x112 {
        uint224 _x;
    }

    // returns a uq112x112 which represents the ratio of the numerator to the denominator
    // equivalent to encode(numerator).div(denominator)
    function fraction(uint112 numerator, uint112 denominator) internal pure returns (uq112x112 memory) {
        require(denominator > 0, "FixedPoint: DIV_BY_ZERO");
        return uq112x112((uint224(numerator) << 112) / denominator);
    }

    // decode a uq112x112 into a uint with 18 decimals of precision
    function decode112with18(uq112x112 memory self) internal pure returns (uint) {
        // we only have 256 - 224 = 32 bits to spare, so scaling up by ~60 bits is dangerous
        // instead, get close to:
        //  (x * 1e18) >> 112
        // without risk of overflowing, e.g.:
        //  (x) / 2 ** (112 - lg(1e18))
        return uint(self._x) / 5192296858534827;
    }
}

// library with helper methods for oracles that are concerned with computing average prices
library UniswapV2OracleLibrary {
    using FixedPoint for FixedPoint.uq112x112;

    // helper function that returns the current block timestamp within the range of uint32, i.e. [0, 2**32 - 1]
    function currentBlockTimestamp() internal view returns (uint32) {
        return uint32(block.timestamp % 2 ** 32);
    }

    // produces the cumulative price using counterfactuals to save gas and avoid a call to sync.
    function currentCumulativePrices(
        address pair
    ) internal view returns (uint price0Cumulative, uint price1Cumulative, uint32 blockTimestamp) {
        blockTimestamp = currentBlockTimestamp();
        price0Cumulative = IUniswapV2Pair(pair).price0CumulativeLast();
        price1Cumulative = IUniswapV2Pair(pair).price1CumulativeLast();

        // if time has elapsed since the last update on the pair, mock the accumulated price values
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
        if (blockTimestampLast != blockTimestamp) {
            // subtraction overflow is desired
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            // addition overflow is desired
            // counterfactual
            price0Cumulative += uint(FixedPoint.fraction(reserve1, reserve0)._x) * timeElapsed;
            // counterfactual
            price1Cumulative += uint(FixedPoint.fraction(reserve0, reserve1)._x) * timeElapsed;
        }
    }
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint);
    function price1CumulativeLast() external view returns (uint);
    function token0() external view returns (address);
    function token1() external view returns (address);
}


// Example Oracle Simple for fixed window
contract SwapOracle is Owned {
    using FixedPoint for FixedPoint.uq112x112;
    IUniswapV2Pair public pair;

    uint public period;
    uint public priceCumulativeLast;
    uint public averagePrice;
    uint32 public blockTimestampLast;

    //tokenIndex,price of token0 or token1, false = token0， true = token1
    //token0 means reserve1 / reserve0
    //token1 means reserve0 / reserve1
    bool public tokenIndex;
    address public token;
    uint public decimalScale;

    IExchangeRates public exchangeRates;
    bytes32 private constant SNX = "BADI";
    uint public constant BaseUnit = 1e18;

    constructor(address _owner, address _pair, address _token, uint _period, address _exchangeRates)
        public
        Owned(_owner) {
        pair = IUniswapV2Pair(_pair);
        token = _token;
        period = _period;
        address t0 = pair.token0();
        address t1 = pair.token1();
        uint8 decimals0 = IERC20(t0).decimals();
        uint8 decimals1 = IERC20(t1).decimals();

        require(t0 == token || t1 == token, "the pair must contain token");
        if (t0 == token) {
           //tokenIndex = true => token1 means reserve0 / reserve1
            tokenIndex = true;
            decimalScale = 10 ** uint(18 + decimals0 - decimals1);
        } else {
            //tokenIndex = false => token0 means reserve1 / reserve0
            decimalScale = 10 ** uint(18 + decimals1 - decimals0);
        }
        exchangeRates = IExchangeRates(_exchangeRates);
        (uint priceComulative, uint32 blockTimestamp) = currentComulativePrice();
        priceCumulativeLast = priceComulative;
        blockTimestampLast = blockTimestamp;
    }

    function setPeriod(uint _period) external onlyOwner {
        require(_period > 0, "period must gather than zero");
        period = _period;
    }

    function update() external {
        (uint priceComulative, uint32 blockTimestamp) = currentComulativePrice();
        uint32 timeElapsed = blockTimestamp - blockTimestampLast; // overflow is desired
        
        // ensure that at least one full period has passed since the last update
        require(timeElapsed >= period, "period not elapsed");
        FixedPoint.uq112x112 memory priceAverage = FixedPoint.uq112x112(uint224((priceComulative - priceCumulativeLast) / timeElapsed));
        averagePrice = priceAverage.decode112with18();
        averagePrice = mul(averagePrice, decimalScale) / BaseUnit ;
        priceCumulativeLast = priceComulative;
        blockTimestampLast = blockTimestamp;
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = SNX;
        uint[] memory rates = new uint[](1);
        rates[0] = averagePrice;

        require(exchangeRates.updateRates(keys, rates, block.timestamp), "failed to update rate");
    }

    function currentComulativePrice() internal view returns (uint price, uint32 blockTimestamp){
        (uint price0Cumulative, uint price1Cumulative, uint32 bts) =
            UniswapV2OracleLibrary.currentCumulativePrices(address(pair));
        blockTimestamp = bts;    
        if (tokenIndex) {
            price = price0Cumulative;
        } else {
            price = price1Cumulative;
        }
    }


    function mul(uint a, uint b) internal pure returns (uint) {
        if (a == 0) return 0;
        uint c = a * b;
        require(c / a == b, "multiplication overflow");
        return c;
    }

    function debugUpdateRates(
        bytes32[] calldata currencyKeys,
        uint[] calldata newRates,
        uint timeSent
    ) external onlyOwner returns (bool) {
       exchangeRates.updateRates(currencyKeys, newRates, timeSent);
    }

}
