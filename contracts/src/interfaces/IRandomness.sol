// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Narrow callback-adapter boundary used by the local arbitration engine.
interface IRandomness {
    function requestRandomness(uint256 requestId) external;
}
