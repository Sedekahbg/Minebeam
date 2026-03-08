// src/index.js
import "dotenv/config";
import { ethers } from "ethers";
import EventSource from "eventsource";

import { CONFIG, ADDRESSES, SSE_URL } from "./config.js";
import { GRID_MINING_ABI } from "./abis.js";
import { sendTelegram } from "./telegram.js";
import { getCurrentRound, getPrice, getUserRewards } from "./api.js";
import { pickBlocks } from "./strategy.js";
import { calcEV } from "./ev.js";

// ─── Setup provider & contracts ─────────────────────────────
const provider  = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
const wallet    = new ethers.Wallet(CONFIG.privateKey, provider);
const gridMining = new ethers.Contract(ADDRESSES.GridMining, GRID_MINING_ABI, wallet);

// ─── State ──────────────────────────────────────────────────
let roundsCompleted  = 0;
let deployedThisRound = false;
let currentRoundId   = null;
let sessionStartTime = Date.now();
let totalEthSpent    = 0n;
let totalEthClaimed  = 0n;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function shortTx(hash) {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function elapsed() {
  const s = Math.floor((Date.now() - sessionStartTime) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

// ─── Deploy logic ────────────────────────────────────────────
async function deployNow(roundId) {
  if (deployedThisRound) {
    log(`Round ${roundId}: already deployed this round, skipping.`);
    return;
  }

  // Fetch grid state
  let round;
  try {
    round = await getCurrentRound(wallet.address);
  } catch (err) {
    log(`Failed to fetch round data: ${err.message}`);
    return;
  }

  // EV check
  if (CONFIG.evCheckEnabled) {
    let priceNative = 0;
    try {
      const priceData = await getPrice();
      priceNative = parseFloat(priceData.bean.priceNative);
    } catch { /* price API down, skip EV check */ }

    if (priceNative > 0) {
      const ev = calcEV({
        ethPerRound: CONFIG.ethPerRound,
        priceNative,
        beanpotPoolFormatted: round.beanpotPoolFormatted,
      });

      if (ev.netEV < CONFIG.evMinThreshold) {
        log(`Round ${roundId}: EV negative (${ev.netEV.toFixed(8)} ETH). Skipping deploy.`);
        await sendTelegram(
          `⚠️ <b>Round ${roundId} — Skipped (EV Negatif)</b>\n` +
          `Net EV: <code>${ev.netEV.toFixed(8)} ETH</code>\n` +
          `BEAN value: <code>${ev.beanValue.toFixed(8)} ETH</code>`
        );
        return;
      }
    }
  }

  // Pick blocks
  const chosenBlocks = pickBlocks(round.blocks, CONFIG.blocksPerDeploy);
  const ethValue     = ethers.parseEther(CONFIG.ethPerRound);
  const ethPerBlock  = parseFloat(CONFIG.ethPerRound) / CONFIG.blocksPerDeploy;

  log(`Round ${roundId}: deploying to blocks [${chosenBlocks.join(", ")}] — ${CONFIG.ethPerRound} ETH total`);

  await sendTelegram(
    `🎯 <b>Round ${roundId}/${CONFIG.totalRounds} — Deploying...</b>\n` +
    `Blocks: <code>[${chosenBlocks.join(", ")}]</code>\n` +
    `ETH: <code>${CONFIG.ethPerRound} ETH</code> (${ethPerBlock.toFixed(6)} each)\n` +
    `Strategy: <code>${CONFIG.blockStrategy}</code>`
  );

  try {
    const tx = await gridMining.deploy(chosenBlocks, { value: ethValue });
    log(`Round ${roundId}: tx sent ${tx.hash}`);
    deployedThisRound = true;
    totalEthSpent += ethValue;

    const receipt = await tx.wait();
    log(`Round ${roundId}: confirmed block ${receipt.blockNumber}`);

    await sendTelegram(
      `✅ <b>Round ${roundId}/${CONFIG.totalRounds} — Deployed!</b>\n\n` +
      `Blocks: <code>[${chosenBlocks.join(", ")}]</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>\n` +
      `⏳ Waiting for next round (~60s)...`
    );

  } catch (err) {
    log(`Round ${roundId}: deploy failed — ${err.message}`);
    deployedThisRound = false; // allow retry if round still open

    await sendTelegram(
      `❌ <b>Round ${roundId} — Deploy Failed</b>\n` +
      `<code>${err.message.slice(0, 200)}</code>`
    );
  }
}

// ─── Claim ETH rewards ───────────────────────────────────────
async function tryClaimETH() {
  try {
    const [pendingWei] = await gridMining.getTotalPendingRewards(wallet.address);
    const pending = parseFloat(ethers.formatEther(pendingWei));

    log(`Pending ETH rewards: ${pending.toFixed(6)} ETH`);
    if (pending < CONFIG.claimEthMin) {
      log(`Below threshold (${CONFIG.claimEthMin} ETH), skipping claim.`);
      return;
    }

    const tx = await gridMining.claimETH();
    log(`claimETH tx: ${tx.hash}`);
    await tx.wait();
    totalEthClaimed += pendingWei;

    await sendTelegram(
      `💰 <b>ETH Claimed!</b>\n` +
      `Amount: <code>${pending.toFixed(6)} ETH</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (err) {
    log(`claimETH failed: ${err.message}`);
  }
}

// ─── Status report ───────────────────────────────────────────
async function sendStatusReport() {
  const balance = await provider.getBalance(wallet.address);
  const spent   = parseFloat(ethers.formatEther(totalEthSpent));
  const claimed = parseFloat(ethers.formatEther(totalEthClaimed));
  const pnl     = claimed - spent;

  let beanLine = "";
  try {
    const rewards = await getUserRewards(wallet.address);
    beanLine = `\nBEAN pending: <code>${rewards.pendingBEAN.netFormatted} BEAN</code>`;
  } catch { /* ignore */ }

  await sendTelegram(
    `📊 <b>Status Report</b>\n\n` +
    `⏱ Session: <code>${elapsed()}</code>\n` +
    `🔄 Rounds: <code>${roundsCompleted}/${CONFIG.totalRounds}</code>\n` +
    `💸 ETH spent: <code>${spent.toFixed(6)} ETH</code>\n` +
    `💰 ETH claimed: <code>${claimed.toFixed(6)} ETH</code>\n` +
    `📈 Net PnL: <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH</code>` +
    beanLine + `\n` +
    `👛 Wallet: <code>${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH</code>`
  );
}

// ─── Handle round transition event ──────────────────────────
async function onRoundTransition(data) {
  const { settled, newRound } = data;

  // Count the completed round
  if (deployedThisRound) {
    roundsCompleted++;
    log(`Round completed. Total: ${roundsCompleted}/${CONFIG.totalRounds}`);
  }

  // Log settlement result
  if (settled) {
    const didWin = settled.topMiner?.toLowerCase() === wallet.address.toLowerCase();
    const beanpotHit = settled.beanpotAmount && settled.beanpotAmount !== "0";

    log(
      `Settled round ${settled.roundId} — winBlock: ${settled.winningBlock}` +
      (didWin ? " 🏆 YOU WON!" : "") +
      (beanpotHit ? " 🎰 BEANPOT!" : "")
    );

    if (beanpotHit) {
      await sendTelegram(
        `🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\n` +
        `Winning block: <code>${settled.winningBlock}</code>\n` +
        `Jackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`
      );
    }
  }

  // Reset for new round
  deployedThisRound = false;
  currentRoundId    = newRound ? Number(newRound.roundId) : null;

  // Check if we've hit our target
  if (roundsCompleted >= CONFIG.totalRounds) {
    log(`✅ All ${CONFIG.totalRounds} rounds completed!`);
    await tryClaimETH();
    await sendStatusReport();
    await sendTelegram(
      `🏁 <b>AUTO-MINER SELESAI!</b>\n` +
      `Total rounds: <code>${roundsCompleted}</code>\n` +
      `Session duration: <code>${elapsed()}</code>\n\n` +
      `BEAN rewards tersimpan di wallet — klaim manual kapanpun kamu mau! 🫘`
    );
    process.exit(0);
  }

  // Periodic ETH claim
  if (roundsCompleted > 0 && roundsCompleted % CONFIG.claimEveryNRounds === 0) {
    log(`Claim check after ${roundsCompleted} rounds...`);
    await tryClaimETH();
    await sendStatusReport();
  }

  // Deploy on the new round (timed entry)
  if (newRound) {
    const roundId   = Number(newRound.roundId);
    const endTime   = Number(newRound.endTime) * 1000; // ms
    const deployAt  = endTime - (CONFIG.deployAtSecondsLeft * 1000);
    const msUntil   = deployAt - Date.now();

    log(`New round ${roundId}. Deploying in ${Math.round(msUntil / 1000)}s (${CONFIG.deployAtSecondsLeft}s before end)`);

    if (msUntil > 0) {
      setTimeout(() => deployNow(roundId), msUntil);
    } else {
      // Already past deploy time, deploy immediately
      await deployNow(roundId);
    }
  }
}

// ─── SSE connection with auto-reconnect ─────────────────────
function connectSSE() {
  log("Connecting to SSE stream...");
  let reconnectDelay = 5000;
  let es;

  function connect() {
    es = new EventSource(SSE_URL);

    es.onopen = () => {
      log("SSE connected ✓");
      reconnectDelay = 5000;
    };

    es.onmessage = async (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        if (type === "roundTransition") {
          await onRoundTransition(data).catch((err) =>
            log(`onRoundTransition error: ${err.message}`)
          );
        } else if (type === "heartbeat") {
          log("SSE heartbeat ✓");
        }
      } catch (err) {
        log(`SSE parse error: ${err.message}`);
      }
    };

    es.onerror = () => {
      log(`SSE error. Reconnecting in ${reconnectDelay / 1000}s...`);
      es.close();
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
        connect();
      }, reconnectDelay);
    };
  }

  connect();
}

// ─── Main startup ─────────────────────────────────────────────
async function main() {
  log("=== MineBean Manual Bot Starting ===");
  log(`Wallet:   ${wallet.address}`);
  log(`Rounds:   ${CONFIG.totalRounds}`);
  log(`Blocks:   ${CONFIG.blocksPerDeploy} per round`);
  log(`ETH/rnd:  ${CONFIG.ethPerRound} ETH`);
  log(`Strategy: ${CONFIG.blockStrategy}`);
  log(`Deploy at: ${CONFIG.deployAtSecondsLeft}s before round end`);

  // Network check
  const network = await provider.getNetwork();
  if (network.chainId !== 8453n) {
    throw new Error(`Wrong network: chainId ${network.chainId} (expected Base = 8453)`);
  }

  const balance = await provider.getBalance(wallet.address);
  const balEth  = parseFloat(ethers.formatEther(balance));
  const needed  = parseFloat(CONFIG.ethPerRound) * CONFIG.totalRounds;

  log(`Balance: ${balEth.toFixed(6)} ETH  (need ~${needed.toFixed(6)} ETH for ${CONFIG.totalRounds} rounds)`);

  if (balEth < needed * 1.05) {
    log("⚠️  WARNING: Balance might be insufficient (< 105% of required ETH)");
  }

  // EV info at startup
  let evLine = "";
  try {
    const [priceData, roundData] = await Promise.all([getPrice(), getCurrentRound()]);
    const ev = calcEV({
      ethPerRound: CONFIG.ethPerRound,
      priceNative: parseFloat(priceData.bean.priceNative),
      beanpotPoolFormatted: roundData.beanpotPoolFormatted,
    });
    evLine = `\nNet EV/round: <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH</code> ${ev.netEV >= 0 ? "✅" : "❌"}`;
    currentRoundId = Number(roundData.roundId);
  } catch (err) {
    log(`Startup EV check failed: ${err.message}`);
  }

  await sendTelegram(
    `🤖 <b>AUTO-MINER STARTED! (${CONFIG.totalRounds} rounds)</b>\n\n` +
    `Session: <code>${wallet.address.slice(0, 8)}...</code>\n\n` +
    `Auto-miner akan:\n` +
    `• Deploy tiap 60 detik (1 round)\n` +
    `• ${CONFIG.blocksPerDeploy} blocks per deploy\n` +
    `• Strategi: ${CONFIG.blockStrategy}\n` +
    `• Total ${CONFIG.totalRounds} rounds = ~${CONFIG.totalRounds} menit` +
    evLine
  );

  // Deploy immediately on current round if time allows
  try {
    const round = await getCurrentRound(wallet.address);
    const timeLeft = Number(round.timeRemaining);
    if (timeLeft > CONFIG.deployAtSecondsLeft + 5) {
      log(`Current round ${round.roundId} has ${timeLeft}s left. Scheduling deploy...`);
      const msUntil = (timeLeft - CONFIG.deployAtSecondsLeft) * 1000;
      setTimeout(() => deployNow(Number(round.roundId)), msUntil);
    } else {
      log(`Not enough time left in current round (${timeLeft}s). Waiting for next.`);
    }
    currentRoundId = Number(round.roundId);
  } catch (err) {
    log(`Could not fetch initial round: ${err.message}`);
  }

  connectSSE();
}

main().catch(async (err) => {
  console.error("Fatal:", err.message);
  await sendTelegram(`💥 <b>Bot Crashed</b>\n<code>${err.message.slice(0, 300)}</code>`);
  process.exit(1);
});

process.on("SIGINT", async () => {
  log("Shutting down (SIGINT)...");
  await sendTelegram(`🛑 <b>Bot Dihentikan Manual</b>\n${roundsCompleted}/${CONFIG.totalRounds} rounds selesai.`);
  process.exit(0);
});
