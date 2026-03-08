// src/config.js
import "dotenv/config";

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`❌ Missing required env var: ${key}`);
  return val;
}

function opt(key, fallback) {
  return process.env[key] ?? fallback;
}

export const CONFIG = {
  privateKey:              required("PRIVATE_KEY"),
  rpcUrl:                  opt("BASE_RPC_URL", "https://mainnet.base.org"),

  telegramToken:           opt("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId:          opt("TELEGRAM_CHAT_ID", ""),

  totalRounds:             parseInt(opt("TOTAL_ROUNDS", "10")),
  blocksPerDeploy:         parseInt(opt("BLOCKS_PER_DEPLOY", "5")),
  ethPerRound:             opt("ETH_PER_ROUND", "0.001"),
  blockStrategy:           opt("BLOCK_STRATEGY", "least_crowded"),  // "random" | "least_crowded"
  deployAtSecondsLeft:     parseInt(opt("DEPLOY_AT_SECONDS_REMAINING", "15")),

  evCheckEnabled:          opt("EV_CHECK_ENABLED", "true") === "true",
  evMinThreshold:          parseFloat(opt("EV_MIN_THRESHOLD", "0")),

  claimEveryNRounds:       parseInt(opt("CLAIM_EVERY_N_ROUNDS", "5")),
  claimEthMin:             parseFloat(opt("CLAIM_ETH_MIN", "0.0005")),
};

export const ADDRESSES = {
  GridMining: "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0",
  Bean:       "0x5c72992b83E74c4D5200A8E8920fB946214a5A5D",
  Staking:    "0xfe177128Df8d336cAf99F787b72183D1E68Ff9c2",
};

export const API_BASE = "https://api.minebean.com";
export const SSE_URL  = `${API_BASE}/api/events/rounds`;
