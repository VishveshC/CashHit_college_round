// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mintable test token with a fixed, configurable decimals value.
contract MockToken is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test token that can charge a transfer fee, including on escrow withdrawals.
contract ConfigurableFeeToken is MockToken {
    uint16 public feeBps;
    bool public feeEnabled;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint16 feeBps_)
        MockToken(name_, symbol_, decimals_)
    {
        feeBps = feeBps_;
    }

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeEnabled && from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, to, value - fee);
            super._update(from, address(0), fee);
            return;
        }
        super._update(from, to, value);
    }
}

/// @dev Deliberately returns false from transferFrom when enabled.
contract FalseReturnToken is MockToken {
    bool public falseOnTransferFrom;

    constructor(uint8 decimals_) MockToken("False Return", "FALSE", decimals_) {}

    function setFalseOnTransferFrom(bool enabled) external {
        falseOnTransferFrom = enabled;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (falseOnTransferFrom) return false;
        return super.transferFrom(from, to, value);
    }
}

/// @dev ERC-20-compatible test token whose transfer functions return no data.
contract NoReturnToken {
    string public name = "No Return";
    string public symbol = "NONE";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address account => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "recipient");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Token hook used to attempt nested escrow mutations during transfer callbacks.
contract ReentrantToken is ConfigurableFeeToken {
    address public callbackTarget;
    bytes public callbackData;
    bool public hookOnTransferFrom;
    bool public hookOnTransfer;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    uint256 public observedClaimable;

    constructor(uint8 decimals_) ConfigurableFeeToken("Reentrant", "RENT", decimals_, 100) {}

    function configureCallback(address target, bytes calldata data, bool onTransferFrom, bool onTransfer)
        external
    {
        callbackTarget = target;
        callbackData = data;
        hookOnTransferFrom = onTransferFrom;
        hookOnTransfer = onTransfer;
        reentryAttempted = false;
        reentrySucceeded = false;
        observedClaimable = type(uint256).max;
    }

    function callConfiguredTarget() external returns (bool success) {
        (success,) = callbackTarget.call(callbackData);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (hookOnTransferFrom) _attemptCallback(false);
        return super.transferFrom(from, to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (hookOnTransfer) _attemptCallback(true);
        return super.transfer(to, value);
    }

    function _attemptCallback(bool inspectClaimable) private {
        hookOnTransferFrom = false;
        hookOnTransfer = false;
        reentryAttempted = true;
        (reentrySucceeded,) = callbackTarget.call(callbackData);
        if (inspectClaimable) {
            (bool ok, bytes memory result) = callbackTarget.staticcall(
                abi.encodeWithSignature("claimable(address,address)", address(this), address(this))
            );
            if (ok && result.length >= 32) observedClaimable = abi.decode(result, (uint256));
        }
    }
}
