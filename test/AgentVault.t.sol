// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/interfaces/IPayable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockToken} from "../src/origin/MockToken.sol";
import {RiftMarket} from "../src/market/RiftMarket.sol";
import {IRiftMarket, RiftAgentVault, RiftAgentVaultFactory} from "../src/agent/RiftAgentVault.sol";

/// @notice The agent vault against a real RiftMarket: every limit is enforced on-chain, funds only move to
///         the market, the owner or (capped) the fee recipient, and the owner keeps full control.
contract AgentVaultTest is Test {
    address internal proxy = makeAddr("callbackProxy");
    address internal reactive = makeAddr("reactive");
    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");
    address internal underwriter = makeAddr("underwriter");

    MockToken internal usd;
    RiftMarket internal market;
    RiftAgentVaultFactory internal factory;
    RiftAgentVault internal vault;

    function _limits() internal pure returns (RiftAgentVault.Limits memory) {
        return RiftAgentVault.Limits({
            maxSpendPerDay: 1_000e18,
            maxNotional: 5_000e18,
            maxFeePerDay: 5e18,
            maxLeverage: 5,
            allowed: 7 // trade | protect | underwrite
        });
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockToken("Test USD", "tUSD");
        market = new RiftMarket(IPayable(payable(proxy)), IERC20(address(usd)));
        market.setReactive(reactive);
        usd.mint(underwriter, 100_000e18);
        vm.startPrank(underwriter);
        usd.approve(address(market), type(uint256).max);
        market.deposit(100_000e18);
        vm.stopPrank();
        _mark(0);

        factory = new RiftAgentVaultFactory(IRiftMarket(address(market)), agent, treasury);
        vm.prank(owner);
        vault = factory.createVault(_limits());
        usd.mint(address(vault), 5_000e18);
    }

    function _mark(int256 bps) internal {
        vm.prank(proxy);
        market.updateMark(reactive, bps, block.timestamp, 84532, 0);
    }

    // ---------------------------------------------------------------- factory

    function test_factoryWiresOwnerAgentAndFee() public view {
        assertEq(address(factory.vaultOf(owner)), address(vault));
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
        assertEq(vault.feeRecipient(), treasury);
        assertEq(address(vault.token()), address(usd));
    }

    function test_oneVaultPerOwner() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVaultFactory.VaultExists.selector, address(vault)));
        factory.createVault(_limits());
    }

    function test_badLimitsRejected() public {
        RiftAgentVault.Limits memory l = _limits();
        l.maxLeverage = 11;
        vm.prank(stranger);
        vm.expectRevert(RiftAgentVault.BadLimits.selector);
        factory.createVault(l);
    }

    // ---------------------------------------------------------------- the agent inside its limits

    function test_agentTradesWithinLimits() public {
        vm.prank(agent);
        vault.openPosition(true, 2_500e18, 500e18); // 5x, 500 of 1,000 daily
        (bool open,,,,,) = market.positions(address(vault));
        assertTrue(open, "position belongs to the vault");
        (uint256 spend,) = vault.remainingToday();
        assertEq(spend, 500e18);

        uint256 before = usd.balanceOf(address(vault));
        vm.prank(agent);
        vault.closePosition();
        assertEq(usd.balanceOf(address(vault)), before + 500e18, "close pays the vault, not the agent");
        assertEq(usd.balanceOf(agent), 0);
    }

    function test_agentBuysCoverAndDeposits() public {
        uint256 premium = market.quotePremium(1_000e18, 1 days);
        vm.prank(agent);
        uint256 id = vault.buyProtection(1_000e18, 1 days);
        assertEq(market.policy(id).buyer, address(vault));

        vm.prank(agent);
        vault.deposit(200e18);
        assertGt(market.sharesOf(address(vault)), 0);

        (uint256 spend,) = vault.remainingToday();
        assertEq(spend, 1_000e18 - premium - 200e18, "premium and deposit both count");
    }

    function test_dailySpendCap() public {
        vm.startPrank(agent);
        vault.deposit(800e18);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.OverDailySpend.selector, 300e18, 200e18));
        vault.deposit(300e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days); // next UTC day
        _mark(0);
        vm.prank(agent);
        vault.deposit(300e18);
    }

    function test_notionalAndLeverageCaps() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.OverNotional.selector, 6_000e18, 5_000e18));
        vault.openPosition(true, 6_000e18, 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.OverLeverage.selector, 4_000e18, 500e18, 5));
        vault.openPosition(true, 4_000e18, 500e18); // 8x > 5x
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.OverNotional.selector, 6_000e18, 5_000e18));
        vault.buyProtection(6_000e18, 1 days);
        vm.stopPrank();
    }

    function test_allowedActions() public {
        RiftAgentVault.Limits memory l = _limits();
        l.allowed = 2; // protect only
        vm.prank(owner);
        vault.setLimits(l);

        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.NotAllowed.selector, 1));
        vault.openPosition(true, 1_000e18, 500e18);
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.NotAllowed.selector, 4));
        vault.deposit(100e18);
        vault.buyProtection(1_000e18, 1 days);
        vm.stopPrank();
    }

    function test_closeAllowedEvenWhenTradingIsOff() public {
        vm.prank(agent);
        vault.openPosition(false, 1_000e18, 500e18);
        RiftAgentVault.Limits memory l = _limits();
        l.allowed = 0;
        vm.prank(owner);
        vault.setLimits(l);
        vm.prank(agent);
        vault.closePosition(); // de-risking is always allowed
    }

    // ---------------------------------------------------------------- agent payment

    function test_feeUnderDailyCap() public {
        vm.startPrank(agent);
        vault.chargeFee(3e18, "premium message");
        vault.chargeFee(2e18, "premium message");
        vm.expectRevert(abi.encodeWithSelector(RiftAgentVault.OverDailyFee.selector, 1, 0));
        vault.chargeFee(1, "premium message");
        vm.stopPrank();
        assertEq(usd.balanceOf(treasury), 5e18, "fees go to the fixed recipient only");

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vault.chargeFee(1e18, "next day");
    }

    function test_onlyAgentCharges() public {
        vm.prank(owner);
        vm.expectRevert(RiftAgentVault.NotOperator.selector);
        vault.chargeFee(1e18, "x");
        vm.prank(stranger);
        vm.expectRevert(RiftAgentVault.NotOperator.selector);
        vault.chargeFee(1e18, "x");
    }

    // ---------------------------------------------------------------- owner control

    function test_strangerCannotAct() public {
        vm.startPrank(stranger);
        vm.expectRevert(RiftAgentVault.NotOperator.selector);
        vault.openPosition(true, 1_000e18, 500e18);
        vm.expectRevert(RiftAgentVault.NotOwner.selector);
        vault.withdraw(1e18);
        vm.expectRevert(RiftAgentVault.NotOwner.selector);
        vault.setLimits(_limits());
        vm.stopPrank();
    }

    function test_agentCannotWithdrawOrChangeLimits() public {
        vm.startPrank(agent);
        vm.expectRevert(RiftAgentVault.NotOwner.selector);
        vault.withdraw(1e18);
        vm.expectRevert(RiftAgentVault.NotOwner.selector);
        vault.setAgent(agent);
        vm.stopPrank();
    }

    function test_pauseStopsAgentNotOwner() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.startPrank(agent);
        vm.expectRevert(RiftAgentVault.IsPaused.selector);
        vault.deposit(100e18);
        vm.expectRevert(RiftAgentVault.IsPaused.selector);
        vault.chargeFee(1e18, "x");
        vm.stopPrank();
        vm.prank(owner);
        vault.deposit(100e18); // the owner still can
    }

    function test_revokeAgent() public {
        vm.prank(owner);
        vault.revokeAgent();
        vm.prank(agent);
        vm.expectRevert(RiftAgentVault.NotOperator.selector);
        vault.deposit(100e18);
    }

    function test_setAgentRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(RiftAgentVault.ZeroAddress.selector);
        vault.setAgent(address(0));
    }

    function test_ownerBypassesAgentLimits() public {
        vm.prank(owner);
        vault.openPosition(true, 9_000e18, 1_000e18); // 9x and over maxNotional: the limits bind the agent only
        (uint256 spend,) = vault.remainingToday();
        assertEq(spend, 1_000e18, "owner spend doesn't use the agent's cap");
    }

    function test_withdrawOnlyToOwner() public {
        uint256 bal = usd.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(bal);
        assertEq(usd.balanceOf(owner), bal);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function test_loweringCapClampsToday() public {
        vm.prank(agent);
        vault.deposit(800e18);
        RiftAgentVault.Limits memory l = _limits();
        l.maxSpendPerDay = 500e18;
        vm.prank(owner);
        vault.setLimits(l);
        (uint256 spend,) = vault.remainingToday();
        assertEq(spend, 0);
    }

    // ---------------------------------------------------------------- fuzz: the cap holds over any sequence

    function testFuzz_spendNeverExceedsCap(uint96[6] memory amounts) public {
        uint256 spent;
        for (uint256 i; i < amounts.length; i++) {
            uint256 a = bound(uint256(amounts[i]), 1e18, 600e18);
            vm.prank(agent);
            try vault.deposit(a) {
                spent += a;
            } catch {}
        }
        assertLe(spent, 1_000e18);
        (uint256 left,) = vault.remainingToday();
        assertEq(left, 1_000e18 - spent);
    }
}
