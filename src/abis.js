// src/abis.js
export const GRID_MINING_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function claimBEAN()",
  "function getCurrentRoundInfo() view returns (uint64 roundId, uint256 startTime, uint256 endTime, uint256 totalDeployed, uint256 timeRemaining, bool isActive)",
  "function getTotalPendingRewards(address user) view returns (uint256 pendingETH, uint256 unroastedBEAN, uint256 roastedBEAN, uint64 uncheckpointedRound)",
  "function getPendingBEAN(address user) view returns (uint256 gross, uint256 fee, uint256 net)",
  "function beanpotPool() view returns (uint256)",
  "function currentRoundId() view returns (uint64)",
];
