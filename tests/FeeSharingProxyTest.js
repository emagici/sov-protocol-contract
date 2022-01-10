/** Speed optimized on branch hardhatTestRefactor, 2021-09-15
 * Greatest bottlenecks found at:
 * 	- Recurrent deployments on beforeEach
 * Total time elapsed: 20s
 * After optimization: 12s
 *
 * Other minor optimizations:
 *  - removed unused lines of code
 *  - reformatted code comments
 *
 * Notes:
 *   Deployment on beforeEach has been sensibly improved by using a Waffle mixture
 *   that snapshots the repeating scenarios.
 *   Tried to:
 *     Update to use the initializer.js functions for sovryn deployment.
 *       It didn't work.
 *     Update to use initializer.js SUSD.
 *       It works Ok.
 *     Update to use WRBTC as collateral token, instead of custom testWrbtc.
 *       It works Ok.
 *     Update to use initializer.js SOV.
 *       It didn't work.
 */

const { expect } = require("chai");
const { waffle } = require("hardhat");
const { loadFixture } = waffle;
const { expectRevert, expectEvent, constants, BN } = require("@openzeppelin/test-helpers");

const { ZERO_ADDRESS } = constants;

const { etherMantissa, mineBlock, increaseTime } = require("./Utils/Ethereum");

const TestToken = artifacts.require("TestToken");

const StakingLogic = artifacts.require("StakingMockup");
const StakingProxy = artifacts.require("StakingProxy");
const VestingLogic = artifacts.require("VestingLogicMockup");
const Vesting = artifacts.require("TeamVesting");

const ISovryn = artifacts.require("ISovryn");
const Affiliates = artifacts.require("Affiliates");

const Protocol = artifacts.require("sovrynProtocol");
const ProtocolSettings = artifacts.require("ProtocolSettingsMockup");
const LoanMaintenance = artifacts.require("LoanMaintenance");
const LoanSettings = artifacts.require("LoanSettings");
const LoanClosingsBase = artifacts.require("LoanClosingsBase");
const LoanClosingsWith = artifacts.require("LoanClosingsWith");

const ILoanTokenLogicProxy = artifacts.require("ILoanTokenLogicProxy");
const ILoanTokenModules = artifacts.require("ILoanTokenModules");
const LoanTokenLogicWrbtc = artifacts.require("LoanTokenLogicWrbtc");
const LoanToken = artifacts.require("LoanToken");
const LockedSOV = artifacts.require("LockedSOV");

const FeeSharingLogic = artifacts.require("FeeSharingLogic");
const FeeSharingProxy = artifacts.require("FeeSharingProxy");
const FeeSharingProxyMockup = artifacts.require("FeeSharingProxyMockup");

const PriceFeedsLocal = artifacts.require("PriceFeedsLocal");

const VestingFactory = artifacts.require("VestingFactory");
const VestingRegistry = artifacts.require("VestingRegistry3");

const LiquidityPoolV1Converter = artifacts.require("LiquidityPoolV1ConverterMockup");

const SwapsImplSovrynSwap = artifacts.require("SwapsImplSovrynSwap");
const TestSovrynSwap = artifacts.require("TestSovrynSwap");
const SwapsExternal = artifacts.require("SwapsExternal");

const TOTAL_SUPPLY = etherMantissa(1000000000);

const MAX_DURATION = new BN(24 * 60 * 60).mul(new BN(1092));
const TWO_WEEKS = 1209600;

const MAX_VOTING_WEIGHT = 10;

const FEE_WITHDRAWAL_INTERVAL = 86400;

const MOCK_PRIOR_WEIGHTED_STAKE = false;

const wei = web3.utils.toWei;

const { lend_btc_before_cashout } = require("./loan-token/helpers");

let cliff = 1; // This is in 4 weeks. i.e. 1 * 4 weeks.
let duration = 11; // This is in 4 weeks. i.e. 11 * 4 weeks.

const {
	getSUSD,
	getRBTC,
	getWRBTC,
	getBZRX,
	getLoanTokenLogic,
	getLoanToken,
	getLoanTokenLogicWrbtc,
	getLoanTokenWRBTC,
	loan_pool_setup,
	set_demand_curve,
	getPriceFeeds,
	getSovryn,
	decodeLogs,
	getSOV,
} = require("./Utils/initializer.js");

contract("FeeSharingProxy:", (accounts) => {
	const name = "Test SOVToken";
	const symbol = "TST";

	let root, account1, account2, account3, account4;
	let SOVToken, SUSD, WRBTC, sovryn, staking;
	let loanTokenSettings, loanTokenLogic, loanToken;
	let feeSharingProxyObj;
	let feeSharingProxy;
	let feeSharingLogic;
	let loanTokenWrbtc;
	let tradingFeePercent;
	let mockPrice;
	let liquidityPoolV1Converter;

	before(async () => {
		[root, account1, account2, account3, account4, ...accounts] = accounts;
	});

	async function protocolDeploymentFixture(_wallets, _provider) {
		// Token
		SOVToken = await TestToken.new(name, symbol, 18, TOTAL_SUPPLY);

		// Staking
		let stakingLogic = await StakingLogic.new(SOVToken.address);
		staking = await StakingProxy.new(SOVToken.address);
		await staking.setImplementation(stakingLogic.address);
		staking = await StakingLogic.at(staking.address);

		SUSD = await getSUSD();
		RBTC = await getRBTC();
		WRBTC = await getWRBTC();
		BZRX = await getBZRX();
		priceFeeds = await getPriceFeeds(WRBTC, SUSD, RBTC, BZRX);

		// Deploying sovrynProtocol w/ generic function from initializer.js
		/// @dev Tried but no success so far. When using the getSovryn function
		///   , contracts revert w/ "target not active" error.
		///   The weird thing is that deployment code below is exactly the same as
		///   the code from getSovryn function at initializer.js.
		///   Inline code works ok, but when calling the function it does not.
		// sovryn = await getSovryn(WRBTC, SUSD, RBTC, priceFeeds);
		// await sovryn.setSovrynProtocolAddress(sovryn.address);

		const sovrynproxy = await Protocol.new();
		sovryn = await ISovryn.at(sovrynproxy.address);

		await sovryn.replaceContract((await ProtocolSettings.new()).address);
		await sovryn.replaceContract((await LoanSettings.new()).address);
		await sovryn.replaceContract((await LoanMaintenance.new()).address);
		await sovryn.replaceContract((await SwapsExternal.new()).address);

		await sovryn.setWrbtcToken(WRBTC.address);

		await sovryn.replaceContract((await LoanClosingsWith.new()).address);
		await sovryn.replaceContract((await LoanClosingsBase.new()).address);

		await sovryn.replaceContract((await Affiliates.new()).address);

		sovryn = await ProtocolSettings.at(sovryn.address);

		// Loan token
		const initLoanTokenLogic = await getLoanTokenLogic(); // function will return [LoanTokenLogicProxy, LoanTokenLogicBeacon]
		loanTokenLogic = initLoanTokenLogic[0];
		loanTokenLogicBeacon = initLoanTokenLogic[1];

		loanToken = await LoanToken.new(root, loanTokenLogic.address, sovryn.address, WRBTC.address);
		await loanToken.initialize(SUSD.address, "iSUSD", "iSUSD");

		/** Initialize the loan token logic proxy */
		loanToken = await ILoanTokenLogicProxy.at(loanToken.address);
		await loanToken.setBeaconAddress(loanTokenLogicBeacon.address);

		/** Use interface of LoanTokenModules */
		loanToken = await ILoanTokenModules.at(loanToken.address);

		await loanToken.setAdmin(root);
		await sovryn.setLoanPool([loanToken.address], [SUSD.address]);

		// FeeSharingProxy
		feeSharingLogic = await FeeSharingLogic.new();
		feeSharingProxyObj = await FeeSharingProxy.new(sovryn.address, staking.address);
		await feeSharingProxyObj.setImplementation(feeSharingLogic.address);
		feeSharingProxy = await FeeSharingLogic.at(feeSharingProxyObj.address);
		await sovryn.setFeesController(feeSharingProxy.address);

		// Set loan pool for wRBTC -- because our fee sharing proxy required the loanPool of wRBTC
		loanTokenLogicWrbtc = await LoanTokenLogicWrbtc.new();
		loanTokenWrbtc = await LoanToken.new(root, loanTokenLogicWrbtc.address, sovryn.address, WRBTC.address);
		await loanTokenWrbtc.initialize(WRBTC.address, "iWRBTC", "iWRBTC");

		loanTokenWrbtc = await LoanTokenLogicWrbtc.at(loanTokenWrbtc.address);
		const loanTokenAddressWrbtc = await loanTokenWrbtc.loanTokenAddress();
		await sovryn.setLoanPool([loanTokenWrbtc.address], [loanTokenAddressWrbtc]);

		await WRBTC.mint(sovryn.address, wei("500", "ether"));

		await sovryn.setWrbtcToken(WRBTC.address);
		await sovryn.setSOVTokenAddress(SOVToken.address);
		await sovryn.setSovrynProtocolAddress(sovryn.address);

		// Creating the Vesting Instance.
		vestingLogic = await VestingLogic.new();
		vestingFactory = await VestingFactory.new(vestingLogic.address);
		vestingRegistry = await VestingRegistry.new(
			vestingFactory.address,
			SOVToken.address,
			staking.address,
			feeSharingProxy.address,
			root // This should be Governance Timelock Contract.
		);
		vestingFactory.transferOwnership(vestingRegistry.address);

		await sovryn.setLockedSOVAddress((await LockedSOV.new(SOVToken.address, vestingRegistry.address, cliff, duration, [root])).address);

		// Set PriceFeeds
		feeds = await PriceFeedsLocal.new(WRBTC.address, sovryn.address);
		mockPrice = "1";
		await feeds.setRates(SUSD.address, WRBTC.address, wei(mockPrice, "ether"));
		const swaps = await SwapsImplSovrynSwap.new();
		const sovrynSwapSimulator = await TestSovrynSwap.new(feeds.address);
		await sovryn.setSovrynSwapContractRegistryAddress(sovrynSwapSimulator.address);
		await sovryn.setSupportedTokens([SUSD.address, WRBTC.address], [true, true]);
		await sovryn.setPriceFeedContract(
			feeds.address // priceFeeds
		);
		await sovryn.setSwapsImplContract(
			swaps.address // swapsImpl
		);

		tradingFeePercent = await sovryn.tradingFeePercent();
		await lend_btc_before_cashout(loanTokenWrbtc, new BN(wei("10", "ether")), root);

		const maxDisagreement = new BN(wei("5", "ether"));
		await sovryn.setMaxDisagreement(maxDisagreement);

		return sovryn;
	}

	beforeEach(async () => {
		await loadFixture(protocolDeploymentFixture);
	});

	describe("FeeSharingProxy", () => {
		it("Check owner & implementation", async () => {
			const proxyOwner = await feeSharingProxyObj.getProxyOwner();
			const implementation = await feeSharingProxyObj.getImplementation();

			expect(implementation).to.be.equal(feeSharingLogic.address);
			expect(proxyOwner).to.be.equal(root);
		});

		it("Set new implementation", async () => {
			const newFeeSharingLogic = await FeeSharingLogic.new();
			await feeSharingProxyObj.setImplementation(newFeeSharingLogic.address);
			const newImplementation = await feeSharingProxyObj.getImplementation();

			expect(newImplementation).to.be.equal(newFeeSharingLogic.address);
		});
	});

	describe("withdrawFees", () => {
		it("Shouldn't be able to use zero token address", async () => {
			await protocolDeploymentFixture();
			await expectRevert(feeSharingProxy.withdrawFees([ZERO_ADDRESS]), "FeeSharingProxy::withdrawFees: token is not a contract");
		});

		it("Shouldn't be able to withdraw if wRBTC loan pool does not exist", async () => {
			await protocolDeploymentFixture();
			// Unset the loanPool for wRBTC
			await sovryn.setLoanPool([loanTokenWrbtc.address], [ZERO_ADDRESS]);

			//mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld, true);

			await expectRevert(feeSharingProxy.withdrawFees([WRBTC.address]), "FeeSharingProxy::withdrawFees: loan wRBTC not found");
		});

		it("Shouldn't be able to withdraw zero amount", async () => {
			await protocolDeploymentFixture();
			const tx = await feeSharingProxy.withdrawFees([SUSD.address]);
			expectEvent(tx, "FeeWithdrawn", {
				sender: root,
				token: loanTokenWrbtc.address,
				amount: new BN(0),
			});
		});

		it("ProtocolSettings.withdrawFees", async () => {
			/// @dev This test requires redeploying the protocol
			const protocol = await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			// mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);

			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			let previousProtocolWrbtcBalance = await WRBTC.balanceOf(protocol.address);
			// let feeAmount = await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			await protocol.setFeesController(root);
			let tx = await protocol.withdrawFees([SUSD.address], root);
			let latestProtocolWrbtcBalance = await WRBTC.balanceOf(protocol.address);

			await checkWithdrawFee();

			//check wrbtc balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let userBalance = await WRBTC.balanceOf.call(root);
			expect(userBalance.toString()).to.be.equal(feeAmount.toString());

			// wrbtc balance should remain the same
			expect(previousProtocolWrbtcBalance.toString()).to.equal(latestProtocolWrbtcBalance.toString());

			expectEvent(tx, "WithdrawFees", {
				sender: root,
				token: SUSD.address,
				receiver: root,
				lendingAmount: lendingFeeTokensHeld,
				tradingAmount: tradingFeeTokensHeld,
				borrowingAmount: borrowingFeeTokensHeld,
				// amountConvertedToWRBTC
			});
		});

		it("ProtocolSettings.withdrawFees (WRBTC token)", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);

			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld, true);
			// let feeAmount = await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			await sovryn.setFeesController(root);
			let tx = await sovryn.withdrawFees([WRBTC.address], account1);

			await checkWithdrawFee(true, true, false);

			//check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let userBalance = await WRBTC.balanceOf.call(account1);
			expect(userBalance.toString()).to.be.equal(feeAmount.toString());

			expectEvent(tx, "WithdrawFees", {
				sender: root,
				token: WRBTC.address,
				receiver: account1,
				lendingAmount: lendingFeeTokensHeld,
				tradingAmount: tradingFeeTokensHeld,
				borrowingAmount: borrowingFeeTokensHeld,
				wRBTCConverted: new BN(feeAmount),
			});
		});

		/// @dev Test coverage
		it("ProtocolSettings.withdrawFees: Revert withdrawing by no feesController", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			// mock data
			let feeAmount = await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));

			await sovryn.setFeesController(root);

			await expectRevert(sovryn.withdrawFees([SUSD.address], account1, { from: account1 }), "unauthorized");
		});

		it("Should be able to withdraw fees", async () => {
			/// @dev This test requires redeploying the protocol
			const protocol = await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			// mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			let previousProtocolWrbtcBalance = await WRBTC.balanceOf(protocol.address);

			tx = await feeSharingProxy.withdrawFees([SUSD.address]);

			await checkWithdrawFee();

			//check irbtc balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			// wrbtc balance should remain the same
			let latestProtocolWrbtcBalance = await WRBTC.balanceOf(protocol.address);
			expect(previousProtocolWrbtcBalance.toString()).to.equal(latestProtocolWrbtcBalance.toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			// check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "FeeWithdrawn", {
				sender: root,
				token: loanTokenWrbtc.address,
				amount: feeAmount,
			});
		});

		it("Should be able to withdraw fees (WRBTC token)", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld, true);

			tx = await feeSharingProxy.withdrawFees([WRBTC.address]);

			await checkWithdrawFee();

			//check irbtc balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			//check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "FeeWithdrawn", {
				sender: root,
				token: loanTokenWrbtc.address,
				amount: feeAmount,
			});
		});

		it("Should be able to withdraw fees (sov token)", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld, false, true);
			tx = await feeSharingProxy.withdrawFees([SOVToken.address]);

			await checkWithdrawFee(false, false, true);

			//check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await SOVToken.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(SOVToken.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(SOVToken.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			//check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(SOVToken.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "TokensTransferred", {
				sender: sovryn.address,
				token: SOVToken.address,
				amount: feeAmount,
			});
		});

		it("Should be able to withdraw fees 3 times", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(1000, root);

			// [FIRST]
			// mock data
			let mockAmountLendingFeeTokensHeld = 0;
			let mockAmountTradingFeeTokensHeld = 1;
			let mockAmountBorrowingFeeTokensHeld = 2;
			let totalMockAmount1 = mockAmountLendingFeeTokensHeld + mockAmountTradingFeeTokensHeld + mockAmountBorrowingFeeTokensHeld;
			let lendingFeeTokensHeld = new BN(mockAmountLendingFeeTokensHeld);
			let tradingFeeTokensHeld = new BN(wei(mockAmountTradingFeeTokensHeld.toString(), "ether"));
			let borrowingFeeTokensHeld = new BN(wei(mockAmountBorrowingFeeTokensHeld.toString(), "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			let totalFeeAmount = feeAmount;

			let tx = await feeSharingProxy.withdrawFees([SUSD.address]);

			await checkWithdrawFee();

			// check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			// check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			// [SECOND]
			// mock data
			let mockAmountLendingFeeTokensHeld2 = 1;
			let mockAmountTradingFeeTokensHeld2 = 0;
			let mockAmountBorrowingFeeTokensHeld2 = 0;
			let totalMockAmount2 = mockAmountTradingFeeTokensHeld2 + mockAmountBorrowingFeeTokensHeld2 + mockAmountLendingFeeTokensHeld2;
			lendingFeeTokensHeld = new BN(wei(mockAmountLendingFeeTokensHeld2.toString(), "ether"));
			tradingFeeTokensHeld = new BN(mockAmountTradingFeeTokensHeld2);
			borrowingFeeTokensHeld = new BN(mockAmountBorrowingFeeTokensHeld2);
			totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			let unprocessedAmount = feeAmount;
			totalFeeAmount = totalFeeAmount.add(feeAmount);

			tx = await feeSharingProxy.withdrawFees([SUSD.address]);

			// Need to checkwithdrawfee manually
			await checkWithdrawFee();

			// check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(totalFeeAmount.toString());

			// [THIRD]
			// mock data
			let mockAmountLendingFeeTokensHeld3 = 0;
			let mockAmountTradingFeeTokensHeld3 = 0.5;
			let mockAmountBorrowingFeeTokensHeld3 = 0.5;
			let totalMockAmount3 = mockAmountTradingFeeTokensHeld3 + mockAmountBorrowingFeeTokensHeld3 + mockAmountLendingFeeTokensHeld3;
			lendingFeeTokensHeld = new BN(mockAmountLendingFeeTokensHeld3);
			tradingFeeTokensHeld = new BN(wei(mockAmountTradingFeeTokensHeld3.toString(), "ether"));
			borrowingFeeTokensHeld = new BN(wei(mockAmountBorrowingFeeTokensHeld3.toString(), "ether"));
			totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			totalFeeAmount = totalFeeAmount.add(feeAmount);

			await increaseTime(FEE_WITHDRAWAL_INTERVAL);
			tx = await feeSharingProxy.withdrawFees([SUSD.address]);
			// In this state the price of SUSD/WRBTC already adjusted because of previous swap, so we need to consider this in the next swapFee calculation
			await checkWithdrawFee();

			// check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(totalFeeAmount.toString());

			// checkpoints
			numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(2);
			checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 1);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.add(unprocessedAmount).toString());

			// check lastFeeWithdrawalTime
			lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());
		});
	});

	describe("transferTokens", () => {
		it("Shouldn't be able to use zero token address", async () => {
			await protocolDeploymentFixture();
			await expectRevert(feeSharingProxy.transferTokens(ZERO_ADDRESS, 1000), "FeeSharingProxy::transferTokens: invalid address");
		});

		it("Shouldn't be able to transfer zero amount", async () => {
			await protocolDeploymentFixture();
			await expectRevert(feeSharingProxy.transferTokens(SOVToken.address, 0), "FeeSharingProxy::transferTokens: invalid amount");
		});

		it("Shouldn't be able to withdraw zero amount", async () => {
			await protocolDeploymentFixture();
			await expectRevert(feeSharingProxy.transferTokens(SOVToken.address, 1000), "invalid transfer");
		});

		it("Should be able to transfer tokens", async () => {
			await protocolDeploymentFixture();
			// stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			let amount = 1000;
			await SOVToken.approve(feeSharingProxy.address, amount * 7);

			let tx = await feeSharingProxy.transferTokens(SOVToken.address, amount);

			expect(await feeSharingProxy.unprocessedAmount.call(SOVToken.address)).to.be.bignumber.equal(new BN(0));

			expectEvent(tx, "TokensTransferred", {
				sender: root,
				token: SOVToken.address,
				amount: new BN(amount),
			});

			// checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(SOVToken.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(SOVToken.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(amount.toString());

			// check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(SOVToken.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "CheckpointAdded", {
				sender: root,
				token: SOVToken.address,
				amount: new BN(amount),
			});

			// second time
			tx = await feeSharingProxy.transferTokens(SOVToken.address, amount * 2);

			expect(await feeSharingProxy.unprocessedAmount.call(SOVToken.address)).to.be.bignumber.equal(new BN(amount * 2));

			expectEvent(tx, "TokensTransferred", {
				sender: root,
				token: SOVToken.address,
				amount: new BN(amount * 2),
			});

			await increaseTime(FEE_WITHDRAWAL_INTERVAL);
			// third time
			tx = await feeSharingProxy.transferTokens(SOVToken.address, amount * 4);

			expect(await feeSharingProxy.unprocessedAmount.call(SOVToken.address)).to.be.bignumber.equal(new BN(0));

			// checkpoints
			numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(SOVToken.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(2);
			checkpoint = await feeSharingProxy.tokenCheckpoints.call(SOVToken.address, 1);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toNumber()).to.be.equal(amount * 6);

			// check lastFeeWithdrawalTime
			lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(SOVToken.address);
			block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());
		});
	});

	describe("withdraw", () => {
		it("Shouldn't be able to withdraw without checkpoints (for token pool)", async () => {
			await protocolDeploymentFixture();
			await expectRevert(
				feeSharingProxy.withdraw(loanToken.address, 0, account2, { from: account1 }),
				"FeeSharingProxy::withdraw: _maxCheckpoints should be positive"
			);
		});

		it("Shouldn't be able to withdraw without checkpoints (for wRBTC pool)", async () => {
			await protocolDeploymentFixture();
			await expectRevert(
				feeSharingProxy.withdraw(loanTokenWrbtc.address, 0, account2, { from: account1 }),
				"FeeSharingProxy::withdraw: _maxCheckpoints should be positive"
			);
		});

		it("Shouldn't be able to withdraw zero amount (for token pool)", async () => {
			await protocolDeploymentFixture();
			let fees = await feeSharingProxy.getAccumulatedFees(account1, loanToken.address);
			expect(fees).to.be.bignumber.equal("0");

			await expectRevert(
				feeSharingProxy.withdraw(loanToken.address, 10, ZERO_ADDRESS, { from: account1 }),
				"FeeSharingProxy::withdrawFees: no tokens for a withdrawal"
			);
		});

		it("Shouldn't be able to withdraw zero amount (for wRBTC pool)", async () => {
			await protocolDeploymentFixture();
			let fees = await feeSharingProxy.getAccumulatedFees(account1, loanTokenWrbtc.address);
			expect(fees).to.be.bignumber.equal("0");

			await expectRevert(
				feeSharingProxy.withdraw(loanTokenWrbtc.address, 10, ZERO_ADDRESS, { from: account1 }),
				"FeeSharingProxy::withdrawFees: no tokens for a withdrawal"
			);
		});

		it("Should be able to withdraw to another account", async () => {
			await protocolDeploymentFixture();
			// stake - getPriorTotalVotingPower
			let rootStake = 700;
			await stake(rootStake, root);

			let userStake = 300;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// mock data
			let lendingFeeTokensHeld = new BN(wei("1", "ether"));
			let tradingFeeTokensHeld = new BN(wei("2", "ether"));
			let borrowingFeeTokensHeld = new BN(wei("3", "ether"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);

			await feeSharingProxy.withdrawFees([SUSD.address]);

			let fees = await feeSharingProxy.getAccumulatedFees(account1, loanTokenWrbtc.address);
			expect(fees).to.be.bignumber.equal(new BN(feeAmount).mul(new BN(3)).div(new BN(10)));

			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 1000, account2, { from: account1 });

			// processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(1);

			expectEvent(tx, "UserFeeWithdrawn", {
				sender: account1,
				receiver: account2,
				token: loanTokenWrbtc.address,
				amount: new BN(feeAmount).mul(new BN(3)).div(new BN(10)),
			});
		});

		it("Should be able to withdraw (token pool)", async () => {
			await protocolDeploymentFixture();
			// FeeSharingProxy
			feeSharingProxy = await FeeSharingProxyMockup.new(sovryn.address, staking.address);
			await sovryn.setFeesController(feeSharingProxy.address);

			// stake - getPriorTotalVotingPower
			let rootStake = 700;
			await stake(rootStake, root);

			let userStake = 300;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// Mock (transfer loanToken to FeeSharingProxy contract)
			const loanPoolTokenAddress = await sovryn.underlyingToLoanPool(SUSD.address);
			const amountLend = new BN(wei("500", "ether"));
			await SUSD.approve(loanPoolTokenAddress, amountLend);
			await loanToken.mint(feeSharingProxy.address, amountLend);

			// Check ISUSD Balance for feeSharingProxy
			const feeSharingProxyLoanBalanceToken = await loanToken.balanceOf(feeSharingProxy.address);
			expect(feeSharingProxyLoanBalanceToken.toString()).to.be.equal(amountLend.toString());

			// Withdraw ISUSD from feeSharingProxy
			// const initial
			await feeSharingProxy.addCheckPoint(loanPoolTokenAddress, amountLend.toString());
			let tx = await feeSharingProxy.trueWithdraw(loanToken.address, 10, ZERO_ADDRESS, { from: account1 });
			const updatedFeeSharingProxyLoanBalanceToken = await loanToken.balanceOf(feeSharingProxy.address);
			const updatedAccount1LoanBalanceToken = await loanToken.balanceOf(account1);
			console.log("\nwithdraw(checkpoints = 1).gasUsed: " + tx.receipt.gasUsed);

			expect(updatedFeeSharingProxyLoanBalanceToken.toString()).to.be.equal(((amountLend * 7) / 10).toString());
			expect(updatedAccount1LoanBalanceToken.toString()).to.be.equal(((amountLend * 3) / 10).toString());

			expectEvent(tx, "UserFeeWithdrawn", {
				sender: account1,
				receiver: account1,
				token: loanToken.address,
				amount: amountLend.mul(new BN(3)).div(new BN(10)),
			});
		});

		it("Should be able to withdraw (WRBTC pool)", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let rootStake = 700;
			await stake(rootStake, root);

			let userStake = 300;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// mock data
			let lendingFeeTokensHeld = new BN(wei("1", "gwei"));
			let tradingFeeTokensHeld = new BN(wei("2", "gwei"));
			let borrowingFeeTokensHeld = new BN(wei("3", "gwei"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);

			await feeSharingProxy.withdrawFees([SUSD.address]);

			let fees = await feeSharingProxy.getAccumulatedFees(account1, loanTokenWrbtc.address);
			expect(fees).to.be.bignumber.equal(feeAmount.mul(new BN(3)).div(new BN(10)));

			let userInitialBtcBalance = new BN(await web3.eth.getBalance(account1));
			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 10, ZERO_ADDRESS, { from: account1 });

			/// @dev To anticipate gas consumption it is required to split hardhat
			///   behaviour into two different scenarios: coverage and regular testing.
			///   On coverage gasPrice = 1, on regular tests gasPrice = 8000000000
			//
			// On coverage:
			// Fees:                 1800000000
			// Balance: 10000000000000000000000
			// Balance: 10000000000001799398877
			// withdraw().gasUsed:       601123
			// txFee:                    601123
			//
			// On regular test:
			// Fees:                 1800000000
			// Balance: 10000000000000000000000
			// Balance:  9999996433281800000000
			// withdraw().gasUsed:       445840
			// txFee:          3566720000000000
			let userLatestBTCBalance = new BN(await web3.eth.getBalance(account1));
			let gasPrice;
			/// @dev A balance decrease (negative difference) corresponds to regular test case
			if (userLatestBTCBalance.sub(userInitialBtcBalance).toString()[0] == "-") {
				gasPrice = new BN(8000000000);
			} // regular test
			else {
				gasPrice = new BN(1);
			} // coverage

			console.log("\nwithdraw(checkpoints = 1).gasUsed: " + tx.receipt.gasUsed);
			let txFee = new BN(tx.receipt.gasUsed).mul(gasPrice);

			userInitialBtcBalance = userInitialBtcBalance.sub(new BN(txFee));
			// processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(1);

			// check balances
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toNumber()).to.be.equal((feeAmount * 7) / 10);
			let userLoanTokenBalance = await loanTokenWrbtc.balanceOf.call(account1);
			expect(userLoanTokenBalance.toNumber()).to.be.equal(0);
			let userExpectedBtcBalance = userInitialBtcBalance.add(feeAmount.mul(new BN(3)).div(new BN(10)));
			expect(userLatestBTCBalance.toString()).to.be.equal(userExpectedBtcBalance.toString());

			expectEvent(tx, "UserFeeWithdrawn", {
				sender: account1,
				receiver: account1,
				token: loanTokenWrbtc.address,
				amount: feeAmount.mul(new BN(3)).div(new BN(10)),
			});
		});

		it("Should be able to withdraw (sov pool)", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let rootStake = 700;
			await stake(rootStake, root);

			let userStake = 300;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			//mock data
			let lendingFeeTokensHeld = new BN(wei("1", "gwei"));
			let tradingFeeTokensHeld = new BN(wei("2", "gwei"));
			let borrowingFeeTokensHeld = new BN(wei("3", "gwei"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld, false, true);

			await feeSharingProxy.withdrawFees([SOVToken.address]);

			let fees = await feeSharingProxy.getAccumulatedFees(account1, SOVToken.address);
			expect(fees).to.be.bignumber.equal(feeAmount.mul(new BN(3)).div(new BN(10)));

			let userInitialISOVBalance = await SOVToken.balanceOf(account1);
			let tx = await feeSharingProxy.withdraw(SOVToken.address, 10, ZERO_ADDRESS, { from: account1 });

			//processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, SOVToken.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(1);

			//check balances
			let feeSharingProxyBalance = await SOVToken.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toNumber()).to.be.equal((feeAmount * 7) / 10);
			let userBalance = await SOVToken.balanceOf.call(account1);
			expect(userBalance.sub(userInitialISOVBalance).toNumber()).to.be.equal((feeAmount * 3) / 10);

			expectEvent(tx, "UserFeeWithdrawn", {
				sender: account1,
				receiver: account1,
				token: SOVToken.address,
				amount: new BN(feeAmount).mul(new BN(3)).div(new BN(10)),
			});
		});

		it("Should be able to withdraw using 3 checkpoints", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let rootStake = 900;
			await stake(rootStake, root);

			let userStake = 100;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// [FIRST]
			// mock data
			let lendingFeeTokensHeld = new BN(wei("1", "gwei"));
			let tradingFeeTokensHeld = new BN(wei("2", "gwei"));
			let borrowingFeeTokensHeld = new BN(wei("3", "gwei"));
			let totalFeeTokensHeld = lendingFeeTokensHeld.add(tradingFeeTokensHeld).add(borrowingFeeTokensHeld);
			let feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld, tradingFeeTokensHeld, borrowingFeeTokensHeld);
			let totalFeeAmount = feeAmount;
			await feeSharingProxy.withdrawFees([SUSD.address]);

			let userInitialBtcBalance = new BN(await web3.eth.getBalance(account1));
			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 1, ZERO_ADDRESS, { from: account1 });

			/// @dev Same as above gas consumption is different on regular tests than on coverge
			let userLatestBTCBalance = new BN(await web3.eth.getBalance(account1));
			let gasPrice;
			/// @dev A balance decrease (negative difference) corresponds to regular test case
			if (userLatestBTCBalance.sub(userInitialBtcBalance).toString()[0] == "-") {
				gasPrice = new BN(8000000000);
			} // regular test
			else {
				gasPrice = new BN(1);
			} // coverage

			console.log("\nwithdraw(checkpoints = 1).gasUsed: " + tx.receipt.gasUsed);
			let txFee = new BN(tx.receipt.gasUsed).mul(gasPrice);

			userInitialBtcBalance = userInitialBtcBalance.sub(new BN(txFee));
			// processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(1);

			// check balances
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toNumber()).to.be.equal((totalFeeAmount * 9) / 10);
			let userBalance = await loanTokenWrbtc.balanceOf.call(account1);
			expect(userBalance.toNumber()).to.be.equal(0);

			expect(userLatestBTCBalance.toString()).to.be.equal(
				userInitialBtcBalance.add(totalFeeAmount.mul(new BN(1)).div(new BN(10))).toString()
			);

			// [SECOND]
			// mock data
			let lendingFeeTokensHeld2 = new BN(wei("1", "gwei"));
			let tradingFeeTokensHeld2 = new BN(wei("2", "gwei"));
			let borrowingFeeTokensHeld2 = new BN(wei("3", "gwei"));
			totalFeeTokensHeld = lendingFeeTokensHeld2.add(tradingFeeTokensHeld2).add(borrowingFeeTokensHeld2);
			feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld2, tradingFeeTokensHeld2, borrowingFeeTokensHeld2);
			totalFeeAmount = totalFeeAmount.add(feeAmount);
			let totalLoanTokenWRBTCBalanceShouldBeAccount1 = feeAmount;
			await increaseTime(FEE_WITHDRAWAL_INTERVAL);
			await feeSharingProxy.withdrawFees([SUSD.address]);

			// [THIRD]
			// mock data
			let lendingFeeTokensHeld3 = new BN(wei("1", "gwei"));
			let tradingFeeTokensHeld3 = new BN(wei("2", "gwei"));
			let borrowingFeeTokensHeld3 = new BN(wei("3", "gwei"));
			totalFeeTokensHeld = lendingFeeTokensHeld3.add(tradingFeeTokensHeld3).add(borrowingFeeTokensHeld3);
			feeAmount = await setFeeTokensHeld(lendingFeeTokensHeld3, tradingFeeTokensHeld3, borrowingFeeTokensHeld3);
			totalFeeAmount = totalFeeAmount.add(feeAmount);
			totalLoanTokenWRBTCBalanceShouldBeAccount1 = totalLoanTokenWRBTCBalanceShouldBeAccount1.add(feeAmount);
			await increaseTime(FEE_WITHDRAWAL_INTERVAL);
			await feeSharingProxy.withdrawFees([SUSD.address]);

			// [SECOND] - [THIRD]
			userInitialBtcBalance = new BN(await web3.eth.getBalance(account1));
			tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 2, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 2).gasUsed: " + tx.receipt.gasUsed);
			txFee = new BN(tx.receipt.gasUsed).mul(gasPrice);

			userInitialBtcBalance = userInitialBtcBalance.sub(new BN(txFee));

			// processedCheckpoints
			processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(3);

			// check balances
			feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toNumber()).to.be.equal(parseInt((totalFeeAmount * 9) / 10));
			userBalance = await loanTokenWrbtc.balanceOf.call(account1);
			expect(userBalance.toNumber()).to.be.equal(0);

			userLatestBTCBalance = new BN(await web3.eth.getBalance(account1));

			expect(userLatestBTCBalance.toString()).to.be.equal(
				userInitialBtcBalance.add(totalLoanTokenWRBTCBalanceShouldBeAccount1.mul(new BN(1)).div(new BN(10))).toString()
			);
		});

		it("Should be able to process 10 checkpoints", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			await stake(900, root);
			let userStake = 100;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// mock data
			await createCheckpoints(10);

			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 1000, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 10).gasUsed: " + tx.receipt.gasUsed);
			// processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(10);
		});

		it("Should be able to process 10 checkpoints and 3 withdrawals", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			await stake(900, root);
			let userStake = 100;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			// mock data
			await createCheckpoints(10);

			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 5, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 5).gasUsed: " + tx.receipt.gasUsed);
			// processedCheckpoints
			let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(5);

			tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 3, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 3).gasUsed: " + tx.receipt.gasUsed);
			// processedCheckpoints
			processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(8);

			tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 1000, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 2).gasUsed: " + tx.receipt.gasUsed);
			// processedCheckpoints
			processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanTokenWrbtc.address);
			expect(processedCheckpoints.toNumber()).to.be.equal(10);
		});

		// // use for gas usage tests
		// it("Should be able to process 30 checkpoints", async () => {
		//     // stake - getPriorTotalVotingPower
		//     await stake(900, root);
		//     let userStake = 100;
		//     if (MOCK_PRIOR_WEIGHTED_STAKE) {
		//         await staking.MOCK_priorWeightedStake(userStake * 10);
		//     }
		//     await SOVToken.transfer(account1, userStake);
		//     await stake(userStake, account1);
		//
		//     // mock data
		//     await createCheckpoints(30);
		//
		//     let tx = await feeSharingProxy.withdraw(loanToken.address, 1000, ZERO_ADDRESS, {from: account1});
		//     console.log("\nwithdraw(checkpoints = 30).gasUsed: " + tx.receipt.gasUsed);
		//     // processedCheckpoints
		//     let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanToken.address);
		//     expect(processedCheckpoints.toNumber()).to.be.equal(30);
		// });
		//
		// // use for gas usage tests
		// it("Should be able to process 100 checkpoints", async () => {
		//     // stake - getPriorTotalVotingPower
		//     await stake(900, root);
		//     let userStake = 100;
		//     if (MOCK_PRIOR_WEIGHTED_STAKE) {
		//         await staking.MOCK_priorWeightedStake(userStake * 10);
		//     }
		//     await SOVToken.transfer(account1, userStake);
		//     await stake(userStake, account1);
		//
		//     // mock data
		//     await createCheckpoints(100);
		//
		//     let tx = await feeSharingProxy.withdraw(loanToken.address, 1000, ZERO_ADDRESS, {from: account1});
		//     console.log("\nwithdraw(checkpoints = 500).gasUsed: " + tx.receipt.gasUsed);
		//     // processedCheckpoints
		//     let processedCheckpoints = await feeSharingProxy.processedCheckpoints.call(account1, loanToken.address);
		//     expect(processedCheckpoints.toNumber()).to.be.equal(100);
		// });
		//
		// // use for gas usage tests
		// it("Should be able to withdraw when staking contains a lot of checkpoints", async () => {
		//     let checkpointCount = 1000;
		//     await stake(1000, root, checkpointCount);
		//     let afterBlock = await blockNumber();
		//     console.log(afterBlock);
		//
		//     let kickoffTS = await staking.kickoffTS.call();
		//     let stakingDate = kickoffTS.add(new BN(MAX_DURATION));
		//
		//     let numUserStakingCheckpoints = await staking.numUserStakingCheckpoints.call(root, stakingDate);
		//     let firstCheckpoint = await staking.userStakingCheckpoints.call(root, stakingDate, 0);
		//     let lastCheckpoint = await staking.userStakingCheckpoints.call(root, stakingDate, numUserStakingCheckpoints - 1);
		//     let block1 = firstCheckpoint.fromBlock.toNumber() + 1;
		//     let block2 = lastCheckpoint.fromBlock;
		//
		//     console.log("numUserStakingCheckpoints = " + numUserStakingCheckpoints.toString());
		//     console.log("first = " + firstCheckpoint.fromBlock.toString());
		//     console.log("last = " + lastCheckpoint.fromBlock.toString());
		//
		//     let tx = await staking.calculatePriorWeightedStake(root, block1, stakingDate);
		//     console.log("\ncalculatePriorWeightedStake(checkpoints = " + checkpointCount + ").gasUsed: " + tx.receipt.gasUsed);
		//     tx = await staking.calculatePriorWeightedStake(root, block2, stakingDate);
		//     console.log("\ncalculatePriorWeightedStake(checkpoints = " + checkpointCount + ").gasUsed: " + tx.receipt.gasUsed);
		// });

		it("Should be able to withdraw with staking for 78 dates", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// stake - getPriorTotalVotingPower
			let rootStake = 700;
			await stake(rootStake, root);

			let userStake = 300;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			let kickoffTS = await staking.kickoffTS.call();
			await SOVToken.approve(staking.address, userStake * 1000);
			for (let i = 0; i < 77; i++) {
				let stakingDate = kickoffTS.add(new BN(TWO_WEEKS * (i + 1)));
				await staking.stake(userStake, stakingDate, account1, account1);
			}

			// mock data
			await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));

			await feeSharingProxy.withdrawFees([SUSD.address]);

			let tx = await feeSharingProxy.withdraw(loanTokenWrbtc.address, 10, ZERO_ADDRESS, { from: account1 });
			console.log("\nwithdraw(checkpoints = 1).gasUsed: " + tx.receipt.gasUsed);
		});

		it("should compute the weighted stake and show gas usage", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			await stake(100, root);
			let kickoffTS = await staking.kickoffTS.call();
			let stakingDate = kickoffTS.add(new BN(MAX_DURATION));
			await SOVToken.approve(staking.address, 100);
			let result = await staking.stake("100", stakingDate, root, root);
			await mineBlock();

			let tx = await staking.calculatePriorWeightedStake(root, result.receipt.blockNumber, stakingDate);
			console.log("\ngasUsed: " + tx.receipt.gasUsed);
		});
	});

	describe("withdraw with or considering vesting contracts", () => {
		it("getAccumulatedFees should return 0 for vesting contracts", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			let { vestingInstance } = await createVestingContractWithSingleDate(new BN(MAX_DURATION), 1000, root);
			await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			let fees = await feeSharingProxy.getAccumulatedFees(vestingInstance.address, loanToken.address);
			expect(fees).to.be.bignumber.equal("0");
		});

		it("vesting contract should not be able to withdraw fees", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			let { vestingInstance } = await createVestingContractWithSingleDate(new BN(MAX_DURATION), 1000, root);
			await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			await expectRevert(
				vestingInstance.collectDividends(loanToken.address, 5, root),
				"FeeSharingProxy::withdrawFees: no tokens for a withdrawal"
			);
		});

		it("vested stakes should be deducted from total weighted stake on share distribution", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			// 50% vested 50% voluntary stakes
			await createVestingContractWithSingleDate(new BN(MAX_DURATION), 1000, root);
			let userStake = 1000;
			if (MOCK_PRIOR_WEIGHTED_STAKE) {
				await staking.MOCK_priorWeightedStake(userStake * 10);
			}
			await SOVToken.transfer(account1, userStake);
			await stake(userStake, account1);

			await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			let tx = await feeSharingProxy.withdrawFees([SUSD.address]);
			let feesWithdrawn = tx.logs[1].args.amount;
			let userFees = await feeSharingProxy.getAccumulatedFees(account1, loanTokenWrbtc.address);

			// 100% of the fees should go to the user -> vesting contract not considered
			expect(feesWithdrawn).to.be.bignumber.equal(userFees);
		});
	});

	describe("withdraw AMM Fees", async () => {
		it("Whitelist converter", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			await expectRevert(feeSharingProxy.addWhitelistedConverterAddress(account1), "Non contract address given");
			await expectRevert(feeSharingProxy.addWhitelistedConverterAddress(ZERO_ADDRESS), "Non contract address given");

			const liquidityPoolV1Converter = await LiquidityPoolV1Converter.new(SOVToken.address, SUSD.address);
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			let whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(1);
			expect(whitelistedConverterList[0]).to.equal(liquidityPoolV1Converter.address);
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(1);
			expect(whitelistedConverterList[0]).to.equal(liquidityPoolV1Converter.address);
		});

		it("Remove converter from whitelist", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			const liquidityPoolV1Converter = await LiquidityPoolV1Converter.new(SOVToken.address, SUSD.address);
			let whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(0);

			await feeSharingProxy.removeWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(0);

			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(1);
			expect(whitelistedConverterList[0]).to.equal(liquidityPoolV1Converter.address);

			await feeSharingProxy.removeWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			whitelistedConverterList = await feeSharingProxy.getWhitelistedConverterList();
			expect(whitelistedConverterList.length).to.equal(0);
		});

		it("should not be able to withdraw fees if converters address is not a contract address", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			await expectRevert(feeSharingProxy.withdrawFeesAMM([accounts[0]]), "Invalid Converter");
		});

		it("Should not be able to withdraw AMM Fees after whitelist removal", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			// AMM Converter
			liquidityPoolV1Converter = await LiquidityPoolV1Converter.new(SOVToken.address, SUSD.address);
			const feeAmount = new BN(wei("1", "ether"));
			await liquidityPoolV1Converter.setTotalFeeMockupValue(feeAmount.toString());

			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "Invalid Converter");
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			await feeSharingProxy.removeWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "Invalid Converter");
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);

			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "unauthorized");
			await liquidityPoolV1Converter.setFeesController(feeSharingProxy.address);
			await liquidityPoolV1Converter.setWrbtcToken(WRBTC.address);
			await WRBTC.mint(liquidityPoolV1Converter.address, wei("2", "ether"));

			tx = await feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]);

			//check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			//check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "FeeAMMWithdrawn", {
				sender: root,
				converter: liquidityPoolV1Converter.address,
				amount: feeAmount,
			});
		});

		it("Should be able to withdraw AMM Fees", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			// AMM Converter
			liquidityPoolV1Converter = await LiquidityPoolV1Converter.new(SOVToken.address, SUSD.address);
			const feeAmount = new BN(wei("1", "ether"));
			await liquidityPoolV1Converter.setTotalFeeMockupValue(feeAmount.toString());

			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "Invalid Converter");
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "unauthorized");
			await liquidityPoolV1Converter.setFeesController(feeSharingProxy.address);
			await liquidityPoolV1Converter.setWrbtcToken(WRBTC.address);
			await WRBTC.mint(liquidityPoolV1Converter.address, wei("2", "ether"));

			tx = await feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]);

			//check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(1);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(tx.receipt.blockNumber);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(totalStake * MAX_VOTING_WEIGHT);
			expect(checkpoint.numTokens.toString()).to.be.equal(feeAmount.toString());

			//check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			let block = await web3.eth.getBlock(tx.receipt.blockNumber);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal(block.timestamp.toString());

			expectEvent(tx, "FeeAMMWithdrawn", {
				sender: root,
				converter: liquidityPoolV1Converter.address,
				amount: feeAmount,
			});
		});

		it("Should be able to withdraw with 0 AMM Fees", async () => {
			/// @dev This test requires redeploying the protocol
			await protocolDeploymentFixture();

			//stake - getPriorTotalVotingPower
			let totalStake = 1000;
			await stake(totalStake, root);

			//mock data
			// AMM Converter
			liquidityPoolV1Converter = await LiquidityPoolV1Converter.new(SOVToken.address, SUSD.address);
			const feeAmount = new BN(wei("0", "ether"));
			await liquidityPoolV1Converter.setTotalFeeMockupValue(feeAmount.toString());
			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "Invalid Converter");
			await feeSharingProxy.addWhitelistedConverterAddress(liquidityPoolV1Converter.address);
			await expectRevert(feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]), "unauthorized");
			await liquidityPoolV1Converter.setFeesController(feeSharingProxy.address);
			await liquidityPoolV1Converter.setWrbtcToken(WRBTC.address);
			await WRBTC.mint(liquidityPoolV1Converter.address, wei("2", "ether"));

			tx = await feeSharingProxy.withdrawFeesAMM([liquidityPoolV1Converter.address]);

			//check WRBTC balance (wrbt balance = (totalFeeTokensHeld * mockPrice) - swapFee)
			let feeSharingProxyBalance = await loanTokenWrbtc.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyBalance.toString()).to.be.equal(feeAmount.toString());

			// make sure wrbtc balance is 0 after withdrawal
			let feeSharingProxyWRBTCBalance = await WRBTC.balanceOf.call(feeSharingProxy.address);
			expect(feeSharingProxyWRBTCBalance.toString()).to.be.equal(new BN(0).toString());

			//checkpoints
			let numTokenCheckpoints = await feeSharingProxy.numTokenCheckpoints.call(loanTokenWrbtc.address);
			expect(numTokenCheckpoints.toNumber()).to.be.equal(0);
			let checkpoint = await feeSharingProxy.tokenCheckpoints.call(loanTokenWrbtc.address, 0);
			expect(checkpoint.blockNumber.toNumber()).to.be.equal(0);
			expect(checkpoint.totalWeightedStake.toNumber()).to.be.equal(0);
			expect(checkpoint.numTokens.toString()).to.be.equal("0");

			//check lastFeeWithdrawalTime
			let lastFeeWithdrawalTime = await feeSharingProxy.lastFeeWithdrawalTime.call(loanTokenWrbtc.address);
			expect(lastFeeWithdrawalTime.toString()).to.be.equal("0");
		});
	});

	describe("withdraw wrbtc", async () => {
		it("Withdraw wrbtc from non owner should revert", async () => {
			await protocolDeploymentFixture();
			const receiver = accounts[1];
			const previousBalanceReceiver = await WRBTC.balanceOf(receiver);
			await expectRevert(feeSharingProxy.withdrawWRBTC(receiver, 0, { from: accounts[1] }), "unauthorized");
		});

		it("Withdraw 0 wrbtc", async () => {
			await protocolDeploymentFixture();
			const receiver = accounts[1];
			const previousBalanceReceiver = await WRBTC.balanceOf(receiver);
			await feeSharingProxy.withdrawWRBTC(receiver, 0);
			const latestBalanceReceiver = await WRBTC.balanceOf(receiver);
			const latestBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);

			expect(new BN(latestBalanceReceiver).sub(new BN(previousBalanceReceiver)).toString()).to.equal("0");
			expect(latestBalanceFeeSharingProxy.toString()).to.equal("0");
		});

		it("Withdraw wrbtc more than the balance of feeSharingProxy should revert", async () => {
			await protocolDeploymentFixture();
			await WRBTC.mint(root, wei("500", "ether"));
			await WRBTC.transfer(feeSharingProxy.address, wei("1", "ether"));

			const receiver = accounts[1];
			const previousBalanceReceiver = await WRBTC.balanceOf(receiver);
			const feeSharingProxyBalance = await WRBTC.balanceOf(feeSharingProxy.address);
			const amount = feeSharingProxyBalance.add(new BN(100));
			const previousBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);

			await expectRevert(feeSharingProxy.withdrawWRBTC(receiver, amount.toString()), "Insufficient balance");

			const latestBalanceReceiver = await WRBTC.balanceOf(receiver);
			const latestBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);

			expect(new BN(latestBalanceReceiver).sub(new BN(previousBalanceReceiver)).toString()).to.equal("0");
			expect(latestBalanceFeeSharingProxy.toString()).to.equal(previousBalanceFeeSharingProxy.toString());
		});

		it("Fully Withdraw wrbtc", async () => {
			await protocolDeploymentFixture();
			await WRBTC.mint(root, wei("500", "ether"));
			await WRBTC.transfer(feeSharingProxy.address, wei("1", "ether"));

			const receiver = accounts[1];
			const previousBalanceReceiver = await WRBTC.balanceOf(receiver);
			const feeSharingProxyBalance = await WRBTC.balanceOf(feeSharingProxy.address);

			const tx = await feeSharingProxy.withdrawWRBTC(receiver, feeSharingProxyBalance.toString());
			await expectEvent.inTransaction(tx.receipt.rawLogs[0].transactionHash, WRBTC, "Transfer", {
				src: feeSharingProxy.address,
				dst: receiver,
				wad: feeSharingProxyBalance.toString(),
			});

			const latestBalanceReceiver = await WRBTC.balanceOf(receiver);
			const latestBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);

			expect(new BN(latestBalanceReceiver).sub(new BN(previousBalanceReceiver)).toString()).to.equal(
				feeSharingProxyBalance.toString()
			);
			expect(latestBalanceFeeSharingProxy.toString()).to.equal("0");
		});

		it("Partially Withdraw wrbtc", async () => {
			await protocolDeploymentFixture();
			await WRBTC.mint(root, wei("500", "ether"));
			await WRBTC.transfer(feeSharingProxy.address, wei("1", "ether"));

			const receiver = accounts[1];
			const restAmount = new BN("100"); // 100 wei
			const previousBalanceReceiver = await WRBTC.balanceOf(receiver);
			const feeSharingProxyBalance = await WRBTC.balanceOf(feeSharingProxy.address);
			const amount = feeSharingProxyBalance.sub(restAmount);
			const previousBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);
			expect(previousBalanceFeeSharingProxy.toString()).to.equal(wei("1", "ether"));

			const tx = await feeSharingProxy.withdrawWRBTC(receiver, amount.toString());
			await expectEvent.inTransaction(tx.receipt.rawLogs[0].transactionHash, WRBTC, "Transfer", {
				src: feeSharingProxy.address,
				dst: receiver,
				wad: amount,
			});

			const latestBalanceReceiver = await WRBTC.balanceOf(receiver);
			const latestBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);

			expect(new BN(latestBalanceReceiver).sub(new BN(previousBalanceReceiver)).toString()).to.equal(amount.toString());
			expect(latestBalanceFeeSharingProxy.toString()).to.equal(restAmount.toString());

			// try to withdraw the rest
			const tx2 = await feeSharingProxy.withdrawWRBTC(receiver, latestBalanceFeeSharingProxy.toString());
			const finalBalanceFeeSharingProxy = await WRBTC.balanceOf(feeSharingProxy.address);
			const finalBalanceReceiver = await WRBTC.balanceOf(receiver);
			expect(new BN(finalBalanceReceiver).toString()).to.equal(previousBalanceFeeSharingProxy.toString());
			expect(finalBalanceFeeSharingProxy.toString()).to.equal("0");

			await expectEvent.inTransaction(tx2.receipt.rawLogs[0].transactionHash, WRBTC, "Transfer", {
				src: feeSharingProxy.address,
				dst: receiver,
				wad: latestBalanceFeeSharingProxy.toString(),
			});
		});
	});

	async function stake(amount, user, checkpointCount) {
		await SOVToken.approve(staking.address, amount);
		let kickoffTS = await staking.kickoffTS.call();
		let stakingDate = kickoffTS.add(new BN(MAX_DURATION));
		let tx = await staking.stake(amount, stakingDate, user, user);
		await mineBlock();

		if (checkpointCount > 0) {
			await increaseStake(amount, user, stakingDate, checkpointCount - 1);
		}

		return tx;
	}

	async function increaseStake(amount, user, stakingDate, checkpointCount) {
		for (let i = 0; i < checkpointCount; i++) {
			await SOVToken.approve(staking.address, amount);
			await staking.increaseStake(amount, user, stakingDate);
		}
	}

	async function setFeeTokensHeld(lendingFee, tradingFee, borrowingFee, wrbtcTokenFee = false, sovTokenFee = false) {
		let totalFeeAmount = lendingFee.add(tradingFee).add(borrowingFee);
		let tokenFee;
		if (wrbtcTokenFee) {
			tokenFee = WRBTC;
		} else {
			tokenFee = SUSD;
			await tokenFee.transfer(sovryn.address, totalFeeAmount);
		}
		await sovryn.setLendingFeeTokensHeld(tokenFee.address, lendingFee);
		await sovryn.setTradingFeeTokensHeld(tokenFee.address, tradingFee);
		await sovryn.setBorrowingFeeTokensHeld(tokenFee.address, borrowingFee);

		if (sovTokenFee) {
			await SOVToken.transfer(sovryn.address, totalFeeAmount);
			await sovryn.setLendingFeeTokensHeld(SOVToken.address, lendingFee);
			await sovryn.setTradingFeeTokensHeld(SOVToken.address, tradingFee);
			await sovryn.setBorrowingFeeTokensHeld(SOVToken.address, borrowingFee);
		}
		return totalFeeAmount;
	}

	async function checkWithdrawFee(checkSUSD = true, checkWRBTC = false, checkSOV = false) {
		if (checkSUSD) {
			let protocolBalance = await SUSD.balanceOf(sovryn.address);
			expect(protocolBalance.toString()).to.be.equal(new BN(0).toString());
			let lendingFeeTokensHeld = await sovryn.lendingFeeTokensHeld.call(SUSD.address);
			expect(lendingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			let tradingFeeTokensHeld = await sovryn.tradingFeeTokensHeld.call(SUSD.address);
			expect(tradingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			let borrowingFeeTokensHeld = await sovryn.borrowingFeeTokensHeld.call(SUSD.address);
			expect(borrowingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
		}

		if (checkWRBTC) {
			lendingFeeTokensHeld = await sovryn.lendingFeeTokensHeld.call(WRBTC.address);
			expect(lendingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			tradingFeeTokensHeld = await sovryn.tradingFeeTokensHeld.call(WRBTC.address);
			expect(tradingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			borrowingFeeTokensHeld = await sovryn.borrowingFeeTokensHeld.call(WRBTC.address);
			expect(borrowingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
		}

		if (checkSOV) {
			protocolBalance = await SOVToken.balanceOf(sovryn.address);
			expect(protocolBalance.toString()).to.be.equal(new BN(0).toString());
			lendingFeeTokensHeld = await sovryn.lendingFeeTokensHeld.call(SOVToken.address);
			expect(lendingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			tradingFeeTokensHeld = await sovryn.tradingFeeTokensHeld.call(SOVToken.address);
			expect(tradingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
			borrowingFeeTokensHeld = await sovryn.borrowingFeeTokensHeld.call(SOVToken.address);
			expect(borrowingFeeTokensHeld.toString()).to.be.equal(new BN(0).toString());
		}
	}

	async function createCheckpoints(number) {
		for (let i = 0; i < number; i++) {
			await setFeeTokensHeld(new BN(100), new BN(200), new BN(300));
			await increaseTime(FEE_WITHDRAWAL_INTERVAL);
			await feeSharingProxy.withdrawFees([SUSD.address]);
		}
	}

	async function createVestingContractWithSingleDate(cliff, amount, tokenOwner) {
		vestingLogic = await VestingLogic.new();
		let vestingInstance = await Vesting.new(
			vestingLogic.address,
			SOVToken.address,
			staking.address,
			tokenOwner,
			cliff,
			cliff,
			feeSharingProxy.address
		);
		vestingInstance = await VestingLogic.at(vestingInstance.address);
		// important, so it's recognized as vesting contract
		await staking.addContractCodeHash(vestingInstance.address);

		await SOVToken.approve(vestingInstance.address, amount);
		let result = await vestingInstance.stakeTokens(amount);
		return { vestingInstance: vestingInstance, blockNumber: result.receipt.blockNumber };
	}
});
