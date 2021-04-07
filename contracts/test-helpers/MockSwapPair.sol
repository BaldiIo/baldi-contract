pragma solidity ^0.5.16;

contract MockSwapPair {
    
    uint256 public p0;
    uint256 public p1;

    address public token0;
    address public token1;

    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;

    constructor() public {

    }

        function update(
        uint112 reserve0_,
        uint112 reserve1_,
        uint32 blockTimestampLast_,
        uint256 price0CumulativeLast_,
        uint256 price1CumulativeLast_
    ) public {
        reserve0 = reserve0_;
        reserve1 = reserve1_;
        blockTimestampLast = blockTimestampLast_;
        p0 = price0CumulativeLast_;
        p1 = price1CumulativeLast_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function price0CumulativeLast() external view returns (uint) {
        return p0;
    }
    function price1CumulativeLast() external view returns (uint) {
        return p1;
    }


    function setToken0(address _token0) external {
        token0 = _token0;
    }

    function setToken1(address _token1) external {
        token1 = _token1;
    }

    function price(address token, uint256 baseDecimal) public view returns (uint256) {
        return 0;
    }
}