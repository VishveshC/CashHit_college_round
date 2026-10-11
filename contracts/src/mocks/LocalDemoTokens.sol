// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mintable local-demo token base. Constructors reject every chain except Anvil's 31337.
abstract contract LocalDemoToken is ERC20 {
    error DemoOnlyLocalChain();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (block.chainid != 31337) revert DemoOnlyLocalChain();
    }

    /// @notice Mints demo funds for a local walkthrough.
    /// @dev Anyone can mint; this contract is a local demo fixture, never a production asset.
    function mint(address recipient, uint256 rawAmount) external {
        _mint(recipient, rawAmount);
    }
}

/// @dev DEMO ONLY: local USDC-shaped mock with six decimals, not an issuer-backed stablecoin.
contract MockUSDC is LocalDemoToken {
    constructor() LocalDemoToken("Fairwork Demo USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev DEMO ONLY: local WBTC-shaped mock with eight decimals, not backed by bitcoin.
contract MockWBTC is LocalDemoToken {
    constructor() LocalDemoToken("Fairwork Demo Wrapped Bitcoin", "WBTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }
}
