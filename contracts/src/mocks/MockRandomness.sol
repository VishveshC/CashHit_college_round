// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IRandomness} from "../interfaces/IRandomness.sol";

interface IRandomnessConsumer {
    function fulfillRandomness(uint256 requestId, uint256 word) external;
}

/// @title DEMO ONLY deterministic randomness adapter
/// @notice Local request/fulfillment harness; its output is predictable and is not verifiable randomness.
/// @dev The deploying engine is the immutable consumer. Public controls are excluded from public builds.
contract MockRandomness is IRandomness {
    error Unauthorized();
    error InvalidChainId();
    error InvalidState();

    address public immutable consumer;
    uint8 public requestMode;
    mapping(uint256 requestId => bool known) public requested;

    constructor() {
        if (block.chainid != 31337) revert InvalidChainId();
        consumer = msg.sender;
    }

    /// @notice Reserves an engine-allocated request ID and optionally calls back synchronously.
    /// @dev Mode 0 records an asynchronous request; mode 1 reverts; mode 2 calls back before returning.
    function requestRandomness(uint256 requestId) external {
        if (msg.sender != consumer) revert Unauthorized();
        if (requestId == 0 || requested[requestId]) revert InvalidState();
        if (requestMode == 1) revert InvalidState();

        requested[requestId] = true;
        if (requestMode == 2) {
            IRandomnessConsumer(consumer).fulfillRandomness(requestId, _word(requestId));
        }
    }

    /// @notice DEMO ONLY: fulfills a known request with internally derived deterministic entropy.
    /// @dev Any local caller may trigger fulfillment, but cannot choose or alter the entropy word.
    function fulfill(uint256 requestId) external {
        if (!requested[requestId]) revert InvalidState();
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, _word(requestId));
    }

    /// @notice DEMO ONLY: selects asynchronous, reverting, or synchronous request behavior.
    function setRequestMode(uint8 mode) external {
        if (mode > 2) revert InvalidState();
        requestMode = mode;
    }

    function _word(uint256 requestId) private view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), consumer, requestId)));
    }
}
