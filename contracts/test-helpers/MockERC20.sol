pragma solidity ^0.5.16;
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20Detailed.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20Detailed,ERC20 {
    constructor (string memory name, string memory symbol, uint8 decimals)
        public
        ERC20Detailed(name, symbol, decimals) {
    }
}
