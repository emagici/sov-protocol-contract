/**
 * Copyright 2017-2020, bZeroX, LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 */

pragma solidity 0.5.17;
pragma experimental ABIEncoderV2;

import "../interfaces/ILoanPool.sol";
import "./LoanClosingsShared.sol";

/**
 * @title LoanClosingsWith contract.
 * @notice Close a loan w/deposit, close w/swap. There are 2 functions for ending a loan on the
 *   protocol contract: closeWithSwap and closeWithDeposit. Margin trade
 *   positions are always closed with a swap.
 *
 * Loans are liquidated if the position goes below margin maintenance.
 * */
contract LoanClosingsWith is LoanClosingsShared {
	constructor() public {}

	function() external {
		revert("fallback not allowed");
	}

	function initialize(address target) external onlyOwner {
		address prevModuleContractAddress = logicTargets[this.closeWithDeposit.selector];
		_setTarget(this.closeWithDeposit.selector, target);
		_setTarget(this.closeWithSwap.selector, target);
		emit ProtocolModuleContractReplaced(prevModuleContractAddress, target, "LoanClosingsWith");
	}

	/**
	 * @notice Closes a loan by doing a deposit.
	 *
	 * @dev Public wrapper for _closeWithDeposit internal function.
	 *
	 * @param loanId The id of the loan.
	 * @param receiver The receiver of the remainder.
	 * @param depositAmount Defines how much of the position should be closed.
	 *   It is denominated in loan tokens. (e.g. rBTC on a iSUSD contract).
	 *     If depositAmount > principal, the complete loan will be closed
	 *     else deposit amount (partial closure).
	 *
	 * @return loanCloseAmount The amount of the collateral token of the loan.
	 * @return withdrawAmount The withdraw amount in the collateral token.
	 * @return withdrawToken The loan token address.
	 * */
	function closeWithDeposit(
		bytes32 loanId,
		address receiver,
		uint256 depositAmount /// Denominated in loanToken.
	)
		public
		payable
		nonReentrant
		whenNotPaused
		returns (
			uint256 loanCloseAmount,
			uint256 withdrawAmount,
			address withdrawToken
		)
	{
		return _closeWithDeposit(loanId, receiver, depositAmount);
	}

	/**
	 * @notice Close a position by swapping the collateral back to loan tokens
	 * paying the lender and withdrawing the remainder.
	 *
	 * @dev Public wrapper for _closeWithSwap internal function.
	 *
	 * @param loanId The id of the loan.
	 * @param receiver The receiver of the remainder (unused collateral + profit).
	 * @param swapAmount Defines how much of the position should be closed and
	 *   is denominated in collateral tokens.
	 *      If swapAmount >= collateral, the complete position will be closed.
	 *      Else if returnTokenIsCollateral, (swapAmount/collateral) * principal will be swapped (partial closure).
	 *      Else coveredPrincipal
	 * @param returnTokenIsCollateral Defines if the remainder should be paid out
	 *   in collateral tokens or underlying loan tokens.
	 *
	 * @return loanCloseAmount The amount of the collateral token of the loan.
	 * @return withdrawAmount The withdraw amount in the collateral token.
	 * @return withdrawToken The loan token address.
	 * */
	function closeWithSwap(
		bytes32 loanId,
		address receiver,
		uint256 swapAmount, // denominated in collateralToken
		bool returnTokenIsCollateral, // true: withdraws collateralToken, false: withdraws loanToken
		bytes memory // for future use /*loanDataBytes*/
	)
		public
		nonReentrant
		whenNotPaused
		returns (
			uint256 loanCloseAmount,
			uint256 withdrawAmount,
			address withdrawToken
		)
	{
		return
			_closeWithSwap(
				loanId,
				receiver,
				swapAmount,
				returnTokenIsCollateral,
				"" /// loanDataBytes
			);
	}

	/**
	 * @notice Internal function for closing a loan by doing a deposit.
	 *
	 * @param loanId The id of the loan.
	 * @param receiver The receiver of the remainder.
	 * @param depositAmount Defines how much of the position should be closed.
	 *   It is denominated in loan tokens.
	 *     If depositAmount > principal, the complete loan will be closed
	 *     else deposit amount (partial closure).
	 *
	 * @return loanCloseAmount The amount of the collateral token of the loan.
	 * @return withdrawAmount The withdraw amount in the collateral token.
	 * @return withdrawToken The loan token address.
	 * */
	function _closeWithDeposit(
		bytes32 loanId,
		address receiver,
		uint256 depositAmount /// Denominated in loanToken.
	)
		internal
		returns (
			uint256 loanCloseAmount,
			uint256 withdrawAmount,
			address withdrawToken
		)
	{
		require(depositAmount != 0, "depositAmount == 0");

		Loan storage loanLocal = loans[loanId];
		LoanParams storage loanParamsLocal = loanParams[loanLocal.loanParamsId];
		//TODO should we skip this check if invoked from rollover ?
		_checkAuthorized(loanLocal, loanParamsLocal);

		/// Can't close more than the full principal.
		loanCloseAmount = depositAmount > loanLocal.principal ? loanLocal.principal : depositAmount;

		//close whole loan if tiny position will remain
		uint256 remainingAmount = loanLocal.principal - loanCloseAmount;
		if (remainingAmount > 0) {
			remainingAmount = _getAmountInRbtc(loanParamsLocal.loanToken, remainingAmount);
			if (remainingAmount <= TINY_AMOUNT) {
				loanCloseAmount = loanLocal.principal;
			}
		}

		uint256 loanCloseAmountLessInterest = _settleInterestToPrincipal(loanLocal, loanParamsLocal, loanCloseAmount, receiver);

		if (loanCloseAmountLessInterest != 0) {
			_returnPrincipalWithDeposit(loanParamsLocal.loanToken, loanLocal.lender, loanCloseAmountLessInterest);
		}

		if (loanCloseAmount == loanLocal.principal) {
			withdrawAmount = loanLocal.collateral;
		} else {
			withdrawAmount = loanLocal.collateral.mul(loanCloseAmount).div(loanLocal.principal);
		}

		withdrawToken = loanParamsLocal.collateralToken;

		if (withdrawAmount != 0) {
			loanLocal.collateral = loanLocal.collateral.sub(withdrawAmount);
			_withdrawAsset(withdrawToken, receiver, withdrawAmount);
		}

		_finalizeClose(
			loanLocal,
			loanParamsLocal,
			loanCloseAmount,
			withdrawAmount, /// collateralCloseAmount
			0, /// collateralToLoanSwapRate
			CloseTypes.Deposit
		);
	}
}
