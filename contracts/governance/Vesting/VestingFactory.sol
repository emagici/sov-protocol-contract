pragma solidity ^0.5.17;

import "../../openzeppelin/Ownable.sol";
import "../../interfaces/IERC20.sol";
import "../Staking/IStaking.sol";
import "../IFeeSharingProxy.sol";
import "./Vesting.sol";
import "./TeamVesting.sol";
import "./DevelopmentVesting.sol";

contract VestingFactory is Ownable {
	///@notice constant used for computing the vesting dates
	uint256 constant FOUR_WEEKS = 4 weeks;

	uint256 constant CSOV_VESTING_CLIFF = FOUR_WEEKS;
	uint256 constant CSOV_VESTING_DURATION = 10 * FOUR_WEEKS;

	uint256 constant TEAM_VESTING_CLIFF = 6 * FOUR_WEEKS;
	uint256 constant TEAM_VESTING_DURATION = 36 * FOUR_WEEKS;

	///@notice the SOV token contract
	address public SOV;
	///@notice the CSOV token contracts
	address[] public CSOVtokens;

	///@notice the staking contract address
	address public staking;
	//@notice fee sharing proxy
	address public feeSharing;
	//@notice the governance timelock address
	address public governanceTimelock;

	//TODO can user have more than one vesting contract of some type ?
	//user => vesting type => vesting contract
	mapping(address => mapping(uint256 => address)) public vestingContracts;

	enum VestingType {
		MultisigVesting, //TeamVesting
		TokenHolderVesting, //Vesting
		DevelopmentVesting, //Development fund
		AdoptionVesting //Adoption fund
	}

	event CSOVTokensExchanged(address indexed caller, uint256 amount);

	//TODO events

	constructor(
		address _SOV,
		address[] memory _CSOVtokens,
		address _staking,
		address _feeSharing,
		address _governanceTimelock
	) public {
		require(_SOV != address(0), "SOV address invalid");
		for (uint256 i = 0; i < _CSOVtokens.length; i++) {
			require(_CSOVtokens[i] != address(0), "CSOV address invalid");
		}
		require(_staking != address(0), "staking address invalid");
		require(_feeSharing != address(0), "feeSharing address invalid");
		require(_governanceTimelock != address(0), "governanceTimelock address invalid");

		SOV = _SOV;
		CSOVtokens = _CSOVtokens;
		staking = _staking;
		feeSharing = _feeSharing;
		governanceTimelock = _governanceTimelock;
	}

	function transferSOV(address _receiver, uint256 _amount) public onlyOwner {
		IERC20(SOV).transfer(_receiver, _amount);
	}

	//TODO exchangeAllCSOV or exchangeCSOV ?
	function exchangeAllCSOV() public {
		uint256 amount = 0;
		for (uint256 i = 0; i < CSOVtokens.length; i++) {
			address CSOV = CSOVtokens[i];
			uint256 balance = IERC20(SOV).balanceOf(msg.sender);
			if (balance == 0) {
				continue;
			}
			bool success = IERC20(CSOV).transferFrom(msg.sender, address(this), balance);
			require(success, "transfer failed");
			amount += balance;
		}

		require(amount > 0, "amount invalid");
		_createVestingForCSOV(amount);
	}

	function exchangeCSOV(address _CSOV, uint256 _amount) public {
		_validateCSOV(_CSOV);
		require(_amount > 0, "amount invalid");

		//TODO transfer or mark as already converted if non-transferable
		//TODO do we need a blacklist?
		bool success = IERC20(_CSOV).transferFrom(msg.sender, address(this), _amount);
		require(success, "transfer failed");

		_createVestingForCSOV(_amount);
	}

	function _createVestingForCSOV(uint256 _amount) internal {
		address vesting = _getOrCreateVesting(msg.sender, CSOV_VESTING_CLIFF, CSOV_VESTING_DURATION);

		//TODO how tokens will be transferred to VestingFactory ?
		IERC20(SOV).approve(vesting, _amount);
		IVesting(vesting).stakeTokens(_amount);

		emit CSOVTokensExchanged(msg.sender, _amount);
	}

	function _validateCSOV(address _CSOV) internal {
		bool isValid = false;
		for (uint256 i = 0; i < CSOVtokens.length; i++) {
			if (_CSOV == CSOVtokens[i]) {
				isValid = true;
				break;
			}
		}
		require(isValid, "wrong CSOV address");
	}

	//TODO cliff - FOUR_WEEKS ?
	function createVesting(
		address _tokenOwner,
		uint256 _amount,
		uint256 _duration
	) public onlyOwner {
		address vesting = _getOrCreateVesting(_tokenOwner, FOUR_WEEKS, _duration);
		IERC20(SOV).approve(vesting, _amount);
		IVesting(vesting).stakeTokens(_amount);
	}

	function createTeamVesting(address _tokenOwner, uint256 _amount) public onlyOwner {
		address vesting = _getOrCreateTeamVesting(_tokenOwner, TEAM_VESTING_CLIFF, TEAM_VESTING_DURATION);
		IERC20(SOV).approve(vesting, _amount);
		IVesting(vesting).stakeTokens(_amount);
	}

	function createDevelopmentVesting(
		address _tokenOwner,
		uint256 _amount,
		uint256 _cliff,
		uint256 _duration,
		uint256 _frequency
	) public onlyOwner {
		address vesting = _getOrCreateDevelopmentVesting(_tokenOwner, _cliff, _duration, _frequency);
		IERC20(SOV).approve(vesting, _amount);
		//        IDevelopmentVesting(vesting).depositTokens(_amount);
	}

	function createAdoptionVesting(
		address _tokenOwner,
		uint256 _amount,
		uint256 _cliff,
		uint256 _duration,
		uint256 _frequency
	) public onlyOwner {
		address vesting = _getOrCreateAdoptionVesting(_tokenOwner, _cliff, _duration, _frequency);
		IERC20(SOV).approve(vesting, _amount);
		//        IDevelopmentVesting(vesting).depositTokens(_amount);
	}

	function getVesting(address _tokenOwner) public view returns (address) {
		return vestingContracts[_tokenOwner][uint256(VestingType.TokenHolderVesting)];
	}

	function getTeamVesting(address _tokenOwner) public view returns (address) {
		return vestingContracts[_tokenOwner][uint256(VestingType.MultisigVesting)];
	}

	function getDevelopmentVesting(address _tokenOwner) public view returns (address) {
		return vestingContracts[_tokenOwner][uint256(VestingType.DevelopmentVesting)];
	}

	function getAdoptionVesting(address _tokenOwner) public view returns (address) {
		return vestingContracts[_tokenOwner][uint256(VestingType.AdoptionVesting)];
	}

	function _getOrCreateVesting(
		address _tokenOwner,
		uint256 _cliff,
		uint256 _duration
	) internal returns (address) {
		uint256 type_ = uint256(VestingType.TokenHolderVesting);
		if (vestingContracts[_tokenOwner][type_] == address(0)) {
			address vesting = address(new Vesting(SOV, staking, _tokenOwner, _cliff, _duration, feeSharing));
			vestingContracts[_tokenOwner][type_] = vesting;
			Ownable(vesting).transferOwnership(governanceTimelock);
		}
		return vestingContracts[_tokenOwner][type_];
	}

	function _getOrCreateTeamVesting(
		address _tokenOwner,
		uint256 _cliff,
		uint256 _duration
	) internal returns (address) {
		uint256 type_ = uint256(VestingType.MultisigVesting);
		if (vestingContracts[_tokenOwner][type_] == address(0)) {
			address vesting = address(new TeamVesting(SOV, staking, _tokenOwner, _cliff, _duration, feeSharing));
			vestingContracts[_tokenOwner][type_] = vesting;
			Ownable(vesting).transferOwnership(governanceTimelock);
		}
		return vestingContracts[_tokenOwner][type_];
	}

	function _getOrCreateDevelopmentVesting(
		address _tokenOwner,
		uint256 _cliff,
		uint256 _duration,
		uint256 _frequency
	) internal returns (address) {
		uint256 type_ = uint256(VestingType.DevelopmentVesting);
		return _getOrCreateAdoptionOrDevelopmentVesting(type_, _tokenOwner, _cliff, _duration, _frequency);
	}

	function _getOrCreateAdoptionVesting(
		address _tokenOwner,
		uint256 _cliff,
		uint256 _duration,
		uint256 _frequency
	) internal returns (address) {
		uint256 type_ = uint256(VestingType.AdoptionVesting);
		return _getOrCreateAdoptionOrDevelopmentVesting(type_, _tokenOwner, _cliff, _duration, _frequency);
	}

	function _getOrCreateAdoptionOrDevelopmentVesting(
		uint256 _type,
		address _tokenOwner,
		uint256 _cliff,
		uint256 _duration,
		uint256 _frequency
	) internal returns (address) {
		if (vestingContracts[_tokenOwner][_type] == address(0)) {
			address vesting = address(new DevelopmentVesting(SOV, _tokenOwner, _cliff, _duration, _frequency));
			vestingContracts[_tokenOwner][_type] = vesting;
			Ownable(vesting).transferOwnership(governanceTimelock);
		}
		return vestingContracts[_tokenOwner][_type];
	}
}
