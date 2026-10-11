// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {LocalDemoToken, MockUSDC, MockWBTC} from "../src/mocks/LocalDemoTokens.sol";

contract LocalDemoTokensTest is Test {
    address private constant RECIPIENT = address(0xD06);

    function setUp() public {
        vm.chainId(31337);
    }

    function test_D06_A17_DemoTokenConstructorsRejectNonlocalChains() public {
        vm.chainId(1);
        vm.expectRevert(LocalDemoToken.DemoOnlyLocalChain.selector);
        new MockUSDC();

        vm.chainId(8453);
        vm.expectRevert(LocalDemoToken.DemoOnlyLocalChain.selector);
        new MockWBTC();
    }

    function test_D06_DemoTokenMetadataAndMintAmountsUseRawUnits() public {
        MockUSDC usdc = new MockUSDC();
        MockWBTC wbtc = new MockWBTC();

        assertEq(usdc.name(), "Fairwork Demo USD Coin", "D-06 USDC-shaped demo name");
        assertEq(usdc.symbol(), "USDC", "D-06 six-decimal demo symbol");
        assertEq(usdc.decimals(), 6, "D-06 MockUSDC uses six decimals");
        assertEq(wbtc.name(), "Fairwork Demo Wrapped Bitcoin", "D-06 WBTC-shaped demo name");
        assertEq(wbtc.symbol(), "WBTC", "D-06 eight-decimal demo symbol");
        assertEq(wbtc.decimals(), 8, "D-06 MockWBTC uses eight decimals");

        usdc.mint(RECIPIENT, 1_234_567);
        wbtc.mint(RECIPIENT, 80_000_001);
        assertEq(usdc.balanceOf(RECIPIENT), 1_234_567, "D-06 USDC demo mint preserves raw units");
        assertEq(wbtc.balanceOf(RECIPIENT), 80_000_001, "D-06 WBTC demo mint preserves raw units");
        assertEq(usdc.totalSupply(), 1_234_567, "D-06 USDC total supply tracks minted raw units");
        assertEq(wbtc.totalSupply(), 80_000_001, "D-06 WBTC total supply tracks minted raw units");
    }
}
