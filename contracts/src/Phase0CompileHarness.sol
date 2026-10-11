// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Phase 0 compile harness only. It is abstract and has no escrow behavior.
abstract contract Phase0CompileHarness is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    constructor() EIP712("Fairwork Phase 0 Compile Harness", "0") {}

    /// @dev Compiles the selected signature and EIP-712 primitives for later phases.
    function _compileOnlyRecover(bytes32 structHash, bytes calldata signature)
        internal
        view
        returns (address)
    {
        return ECDSA.recover(_hashTypedDataV4(structHash), signature);
    }
}
