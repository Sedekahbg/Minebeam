// ============================================================
//  MineBean Auto Deploy Bot v5 — Interactive Telegram Bot
//  Chain: Base Mainnet (8453)
//  Based on official skill doc: https://minebean.com/skill.md
//  Features: Auto-mine, win tracking, Telegram commands
// ============================================================
import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";
import EventSource from "eventsource";

// ── Config ───────────────────────────────────────────────────
const CFG = {
  privateKey: process.env.PRIVATE_KEY || (() => { throw new Error("PRIVATE_KEY wajib diisi!") })(),
  rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  tgToken: process.env.TELEGRAM_BOT_TOKEN || "",
  tgChat: process.env.TELEGRAM_CHAT_ID || "",
  totalRounds: parseInt(process.env.TOTAL_ROUNDS) || 0,       // 0 = unlimited (24/7)
  blocksPerDeploy: parseInt(process.env.BLOCKS_PER_DEPLOY) || 5,
  ethPerRound: process.env.ETH_PER_ROUND || "0.0000125",
  strategy: process.env.BLOCK_STRATEGY || "least_crowded",
  deploySecsLeft: parseInt(process.env.DEPLOY_AT_SECONDS_LEFT) || 15,
  claimEvery: parseInt(process.env.CLAIM_EVERY_N_ROUNDS) || 5,
  claimEthMin: parseFloat(process.env.CLAIM_ETH_MIN) || 0.0005,
  claimBeanMin: parseFloat(process.env.CLAIM_BEAN_MIN) || 1.0,
  holdBean: process.env.HOLD_BEAN === "true",
  minBalance: process.env.MIN_BALANCE_ETH || "0.00005",
};

// Auto-fix minimum ETH
const MIN_PER_BLOCK = 0.0000025;
const minNeeded = MIN_PER_BLOCK * CFG.blocksPerDeploy;
if (parseFloat(CFG.ethPerRound) < minNeeded) {
  console.warn(`⚠️  ETH_PER_ROUND terlalu kecil, pakai minimum: ${minNeeded}`);
  CFG.ethPerRound = minNeeded.toFixed(10);
}

// ── Contracts (from skill doc) ───────────────────────────────
const GRID_ADDR = "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0";
const BEAN_ADDR = "0x5c72992b83E74c4D5200A8E8920fB946214a5A5D";
const STAKING_ADDR = "0xfe177128Df8d336cAf99F787b72183D1E68Ff9c2";

const GRID_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function claimBEAN()",
  "function getTotalPendingRewards(address user) view returns (uint256 pendingETH, uint256 unroastedBEAN, uint256 roastedBEAN, uint64 uncheckpointedRound)",
  "function getPendingBEAN(address user) view returns (uint256 gross, uint256 fee, uint256 net)",
  "function getCurrentRoundInfo() view returns (uint64 roundId, uint256 startTime, uint256 endTime, uint256 totalDeployed, uint256 timeRemaining, bool isActive)",
  "function beanpotPool() view returns (uint256)",
  "function currentRoundId() view returns (uint64)",
];

const BEAN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const API_BASE = "https://api.minebean.com";

// ── Provider & wallet ────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
const wallet = new ethers.Wallet(CFG.privateKey, provider);
const gridContract = new ethers.Contract(GRID_ADDR, GRID_ABI, wallet);
const beanContract = new ethers.Contract(BEAN_ADDR, BEAN_ABI, wallet);

// ── State ────────────────────────────────────────────────────
let roundsDone = 0;
let deployedThisRnd = false;
let deploying = false;
let totalSpentWei = 0n;
let totalClaimedWei = 0n;
let totalBeanClaimed = 0n;
let sessionStart = Date.now();
let deployTimer = null;
let currentRoundId = null;
let sseInstance = null;
let lastGridData = null;
let botRunning = true;
let tgPollOffset = 0;
let tgPollTimer = null;

// ── Win/Loss Tracking ────────────────────────────────────────
let wins = 0;
let losses = 0;
let lastDeployedBlocks = [];  // blocks deployed in current round
let roundResults = [];     // [{roundId, won, winBlock, blocks, ethDeployed}]

// ── Helpers ──────────────────────────────────────────────────
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const shortTx = (h) => `${h.slice(0, 10)}...${h.slice(-6)}`;
const elapsed = () => {
  const s = Math.floor((Date.now() - sessionStart) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Telegram Send Message ────────────────────────────────────
async function tg(text) {
  if (!CFG.tgToken || !CFG.tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.tgChat, text, parse_mode: "HTML" }),
    });
  } catch (e) { log(`[TG] ${e.message}`); }
}

// ── Telegram Bot Polling (Commands) ──────────────────────────
async function startTelegramPolling() {
  if (!CFG.tgToken) return;
  log("Telegram bot polling started ✓");

  async function poll() {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${CFG.tgToken}/getUpdates?offset=${tgPollOffset}&timeout=30&allowed_updates=["message"]`
      );
      const data = await res.json();

      if (data.ok && data.result) {
        for (const update of data.result) {
          tgPollOffset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;
          if (String(msg.chat.id) !== String(CFG.tgChat)) continue;

          const cmd = msg.text.trim().toLowerCase();
          await handleCommand(cmd);
        }
      }
    } catch (e) {
      log(`TG poll error: ${e.message}`);
    }

    if (botRunning) {
      tgPollTimer = setTimeout(poll, 1000);
    }
  }

  poll();
}

// ── Command Handler ──────────────────────────────────────────
async function handleCommand(cmd) {
  log(`Telegram command: ${cmd}`);

  if (cmd === "/start" || cmd === "/help") {
    await tg(
      `🤖 <b>MineBean Bot v5</b>\n\n` +
      `📋 <b>Commands:</b>\n` +
      `/status — Cek status bot & PnL\n` +
      `/rewards — Cek pending rewards\n` +
      `/claim — Claim ETH & BEAN\n` +
      `/balance — Cek saldo wallet\n` +
      `/ev — Hitung EV per round\n` +
      `/stats — Win/loss statistics\n` +
      `/stop — Stop bot\n` +
      `/start — Tampilkan menu ini`
    );
  }
  else if (cmd === "/status") {
    await cmdStatus();
  }
  else if (cmd === "/rewards") {
    await cmdRewards();
  }
  else if (cmd === "/claim") {
    await cmdClaim();
  }
  else if (cmd === "/balance") {
    await cmdBalance();
  }
  else if (cmd === "/ev") {
    await cmdEV();
  }
  else if (cmd === "/stats") {
    await cmdStats();
  }
  else if (cmd === "/stop") {
    await cmdStop();
  }
}

// ── /status ──────────────────────────────────────────────────
async function cmdStatus() {
  try {
    const balance = await provider.getBalance(wallet.address);
    const spent = parseFloat(ethers.formatEther(totalSpentWei));
    const claimed = parseFloat(ethers.formatEther(totalClaimedWei));
    const pnl = claimed - spent;
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : "0.0";
    const roundsText = CFG.totalRounds ? `${roundsDone}/${CFG.totalRounds}` : `${roundsDone}`;

    await tg(
      `📊 <b>Status Bot</b>\n\n` +
      `⏱ Runtime: <code>${elapsed()}</code>\n` +
      `🔄 Rounds: <code>${roundsText}</code>\n` +
      `🏆 Menang: <code>${wins}</code> | Kalah: <code>${losses}</code>\n` +
      `📈 Win rate: <code>${winRate}%</code>\n` +
      `💸 ETH deployed: <code>${spent.toFixed(6)} ETH</code>\n` +
      `💰 ETH claimed: <code>${claimed.toFixed(6)} ETH</code>\n` +
      `📈 PnL: <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH</code>\n` +
      `👛 Balance: <code>${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH</code>`
    );
  } catch (e) {
    await tg(`❌ Status error: ${e.message}`);
  }
}

// ── /rewards ─────────────────────────────────────────────────
async function cmdRewards() {
  try {
    let ethPending, beanMined, beanRoasted, beanFee, beanNet;

    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      ethPending = rewards.pendingETHFormatted || "0";
      beanMined = rewards.pendingBEAN?.unroastedFormatted || "0.0";
      beanRoasted = rewards.pendingBEAN?.roastedFormatted || "0.0";
      beanFee = rewards.pendingBEAN?.feeFormatted || "0.0";
      beanNet = rewards.pendingBEAN?.netFormatted || "0.0";
    } catch {
      const [pendingWei, unroasted, roasted] = await gridContract.getTotalPendingRewards(wallet.address);
      ethPending = ethers.formatEther(pendingWei);
      const bean = await gridContract.getPendingBEAN(wallet.address);
      beanMined = parseFloat(ethers.formatEther(unroasted)).toFixed(4);
      beanRoasted = parseFloat(ethers.formatEther(roasted)).toFixed(4);
      beanFee = parseFloat(ethers.formatEther(bean.fee)).toFixed(4);
      beanNet = parseFloat(ethers.formatEther(bean.net)).toFixed(4);
    }

    await tg(
      `💰 <b>Pending Rewards</b>\n\n` +
      `• ETH: <code>${ethPending} ETH</code>\n` +
      `• BEAN (mined): <code>${beanMined}</code>\n` +
      `• BEAN (roasted): <code>${beanRoasted}</code>\n` +
      `• BEAN (net after fee): <code>${beanNet}</code>\n\n` +
      `Gunakan /claim untuk ambil rewards!`
    );
  } catch (e) {
    await tg(`❌ Rewards error: ${e.message}`);
  }
}

// ── /claim ───────────────────────────────────────────────────
async function cmdClaim() {
  await tg(`⏳ Mengambil rewards...`);

  // Claim ETH
  try {
    let pending;
    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      pending = parseFloat(rewards.pendingETHFormatted || "0");
    } catch {
      const [pendingWei] = await gridContract.getTotalPendingRewards(wallet.address);
      pending = parseFloat(ethers.formatEther(pendingWei));
    }

    if (pending > 0.000001) {
      const tx = await gridContract.claimETH();
      await tx.wait();
      totalClaimedWei += ethers.parseEther(pending.toString());
      await tg(`✅ ETH Claimed: <code>${pending.toFixed(8)} ETH</code>\nTX: <code>${shortTx(tx.hash)}</code>`);
    } else {
      await tg(`ℹ️ ETH pending terlalu kecil: ${pending.toFixed(8)} ETH`);
    }
  } catch (e) {
    await tg(`❌ Claim ETH error: ${e.message.slice(0, 150)}`);
  }

  // Claim BEAN
  if (!CFG.holdBean) {
    try {
      const bean = await gridContract.getPendingBEAN(wallet.address);
      const net = parseFloat(ethers.formatEther(bean.net));

      if (net > 0.01) {
        const tx = await gridContract.claimBEAN();
        await tx.wait();
        totalBeanClaimed += bean.net;
        await tg(`✅ BEAN Claimed: <code>${net.toFixed(4)} BEAN</code>\nTX: <code>${shortTx(tx.hash)}</code>`);
      } else {
        await tg(`ℹ️ BEAN pending kecil: ${net.toFixed(4)} BEAN`);
      }
    } catch (e) {
      await tg(`❌ Claim BEAN error: ${e.message.slice(0, 150)}`);
    }
  }

  await tg(`✅ <b>Claim selesai!</b>`);
}

// ── /balance ─────────────────────────────────────────────────
async function cmdBalance() {
  try {
    const ethBal = await provider.getBalance(wallet.address);
    const beanBal = await beanContract.balanceOf(wallet.address);

    await tg(
      `👛 <b>Wallet Balance</b>\n\n` +
      `• ETH: <code>${parseFloat(ethers.formatEther(ethBal)).toFixed(6)} ETH</code>\n` +
      `• BEAN: <code>${parseFloat(ethers.formatEther(beanBal)).toFixed(4)} BEAN</code>\n` +
      `• Address: <code>${wallet.address}</code>`
    );
  } catch (e) {
    await tg(`❌ Balance error: ${e.message}`);
  }
}

// ── /ev ──────────────────────────────────────────────────────
async function cmdEV() {
  const ev = await calculateEV();
  if (ev) {
    await tg(
      `📊 <b>Expected Value (EV)</b>\n\n` +
      `• BEAN reward: <code>${ev.beanValue.toFixed(8)} ETH</code>\n` +
      `• Beanpot EV: <code>${ev.beanpotEV.toFixed(8)} ETH</code>\n` +
      `• House cost: <code>${ev.houseCost.toFixed(8)} ETH</code>\n` +
      `• <b>Net EV: <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH</code></b> ${ev.netEV >= 0 ? "✅" : "⚠️"}\n\n` +
      `• BEAN price: <code>${ev.priceNative} ETH</code>\n` +
      `• Beanpot pool: <code>${ev.beanpotPool} BEAN</code>`
    );
  } else {
    await tg(`❌ Gagal hitung EV`);
  }
}

// ── /stats ───────────────────────────────────────────────────
async function cmdStats() {
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
  const spent = parseFloat(ethers.formatEther(totalSpentWei));
  const claimed = parseFloat(ethers.formatEther(totalClaimedWei));

  let recentText = "";
  const recent = roundResults.slice(-5);
  if (recent.length > 0) {
    recentText = "\n\n📜 <b>Recent Rounds:</b>\n" +
      recent.map(r => {
        const icon = r.won ? "🏆" : "❌";
        return `${icon} #${r.roundId} — Block ${r.winBlock} | Blokmu: [${r.blocks.join(",")}]`;
      }).join("\n");
  }

  await tg(
    `📈 <b>Statistics</b>\n\n` +
    `• Rounds: <code>${total}</code>\n` +
    `• Menang: <code>${wins}</code> 🏆\n` +
    `• Kalah: <code>${losses}</code> 😔\n` +
    `• Win rate: <code>${winRate}%</code>\n` +
    `• Total ETH deployed: <code>${spent.toFixed(6)} ETH</code>\n` +
    `• Total ETH claimed: <code>${claimed.toFixed(6)} ETH</code>` +
    recentText
  );
}

// ── /stop ────────────────────────────────────────────────────
async function cmdStop() {
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
  const spent = parseFloat(ethers.formatEther(totalSpentWei));

  await tg(
    `🛑 <b>Bot Dihentikan!</b>\n\n` +
    `📊 Summary:\n` +
    `• Rounds: ${roundsDone}\n` +
    `• Menang: ${wins} 🏆\n` +
    `• Kalah: ${losses} 😔\n` +
    `• Win rate: ${winRate}%\n` +
    `• Total ETH deployed: ${spent.toFixed(6)} ETH\n\n` +
    `Gunakan Railway dashboard untuk restart.`
  );

  botRunning = false;
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  if (tgPollTimer) clearTimeout(tgPollTimer);
  process.exit(0);
}

// ── API Helper ───────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

function getSecsLeft(endTime) {
  const end = Number(endTime);
  if (!end || isNaN(end)) return 0;
  return Math.max(0, Math.floor((end * 1000 - Date.now()) / 1000));
}

// ── EV Calculation ───────────────────────────────────────────
async function calculateEV() {
  try {
    const [priceData, roundData] = await Promise.all([
      apiGet("/api/price"),
      apiGet("/api/round/current"),
    ]);
    const priceNative = parseFloat(priceData.bean.priceNative);
    const beanpotPool = parseFloat(roundData.beanpotPoolFormatted || "0");
    const ethDeployed = parseFloat(CFG.ethPerRound);

    const beanValue = 1.0 * priceNative;
    const beanpotEV = (1 / 777) * beanpotPool * priceNative;
    const houseCost = ethDeployed * 0.11;
    const netEV = beanValue + beanpotEV - houseCost;

    return { netEV, beanValue, beanpotEV, houseCost, priceNative, beanpotPool };
  } catch (e) {
    log(`EV calc error: ${e.message}`);
    return null;
  }
}

// ── Block Selection (Hybrid: least_crowded + random) ─────────
function pickBlocks(blocks) {
  const n = CFG.blocksPerDeploy;

  // Helper: shuffle array
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  if (!blocks || blocks.length === 0) {
    return shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, n).sort((a, b) => a - b);
  }

  if (CFG.strategy === "least_crowded") {
    // Hybrid: ~60% least crowded, ~40% random for diversification
    const lcCount = Math.ceil(n * 0.6);   // e.g. 3 out of 5
    const rndCount = n - lcCount;           // e.g. 2 out of 5

    // Sort by least crowded
    const sorted = [...blocks].sort((a, b) => {
      const aMiners = a.minerCount || 0;
      const bMiners = b.minerCount || 0;
      const aDeployed = parseFloat(a.deployedFormatted || "0");
      const bDeployed = parseFloat(b.deployedFormatted || "0");
      if (aMiners === 0 && bMiners !== 0) return -1;
      if (bMiners === 0 && aMiners !== 0) return 1;
      if (aMiners !== bMiners) return aMiners - bMiners;
      return aDeployed - bDeployed;
    });

    // Pick top least crowded
    const lcBlocks = sorted.slice(0, lcCount).map(b => b.id);

    // Pick random blocks from remaining
    const remaining = sorted.slice(lcCount).map(b => b.id);
    const rndBlocks = shuffle(remaining).slice(0, rndCount);

    return [...lcBlocks, ...rndBlocks].sort((a, b) => a - b);
  }

  // Pure random
  return shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, n).sort((a, b) => a - b);
}

// ── Balance Check ────────────────────────────────────────────
async function checkBalance() {
  const balance = await provider.getBalance(wallet.address);
  const balEth = parseFloat(ethers.formatEther(balance));
  const needed = parseFloat(CFG.ethPerRound) + 0.00002;

  if (balEth < needed) {
    log(`⚠️ Saldo kurang: ${balEth.toFixed(6)} ETH < ${needed.toFixed(6)} ETH`);
    return false;
  }
  return true;
}

// ── Deploy ───────────────────────────────────────────────────
async function doDeploy(roundId) {
  if (deployedThisRnd) {
    log(`Round ${roundId}: sudah deploy, skip.`);
    return;
  }
  if (deploying) {
    log(`Round ${roundId}: deploy sedang berjalan, skip duplicate.`);
    return;
  }
  deploying = true;

  log(`Round ${roundId}: mulai deploy...`);

  // Balance check
  const hasBalance = await checkBalance();
  if (!hasBalance) {
    deploying = false;
    await tg(`⚠️ <b>Skip Round ${roundId}</b>\nSaldo ETH tidak cukup.`);
    return;
  }

  // Fetch grid
  let round;
  try {
    round = await apiGet(`/api/round/current?user=${wallet.address}`);
    lastGridData = round.blocks;
    log(`Grid OK: roundId=${round.roundId}, pool=${round.totalDeployedFormatted} ETH, sisa=${getSecsLeft(round.endTime)}s`);
  } catch (e) {
    log(`Gagal fetch grid: ${e.message} — pakai cache/random`);
    round = { blocks: lastGridData || [], totalDeployedFormatted: "?", beanpotPoolFormatted: "?" };
  }

  // Check round is still current
  if (round.roundId && Number(round.roundId) !== Number(roundId)) {
    log(`Round ${roundId} sudah kedaluwarsa (now: ${round.roundId}), skip.`);
    deploying = false;
    return;
  }

  // Check time
  const secsLeft = getSecsLeft(round.endTime);
  if (secsLeft < 3) {
    log(`Round ${roundId}: tinggal ${secsLeft}s, terlalu mepet, skip.`);
    deploying = false;
    return;
  }

  const blocks = pickBlocks(round.blocks);
  const ethValue = ethers.parseEther(CFG.ethPerRound);
  const perBlock = (parseFloat(CFG.ethPerRound) / CFG.blocksPerDeploy).toFixed(8);

  log(`Blok: [${blocks.join(", ")}] | ${CFG.ethPerRound} ETH | ${secsLeft}s sisa`);

  try {
    const tx = await gridContract.deploy(blocks, { value: ethValue });
    deployedThisRnd = true;
    lastDeployedBlocks = blocks;
    totalSpentWei += ethValue;
    log(`TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`TX confirmed: block ${receipt.blockNumber}, gas: ${receipt.gasUsed.toString()}`);

    const progressText = CFG.totalRounds
      ? `${roundsDone + 1}/${CFG.totalRounds}`
      : `${roundsDone + 1}`;

    await tg(
      `⛏ <b>Round ${roundId} — Deployed!</b>\n\n` +
      `Blocks: <code>[${blocks.join(", ")}]</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>\n` +
      `🏗 Waiting for result...`
    );

  } catch (e) {
    log(`Deploy error: ${e.message}`);
    if (e.message.includes("AlreadyDeployedThisRound")) {
      deployedThisRnd = true;
      deploying = false;
      log("AlreadyDeployedThisRound — dianggap sudah deploy.");
      return;
    }
    deployedThisRnd = false;
    await tg(`❌ <b>Deploy Gagal Round ${roundId}</b>\n<code>${e.message.slice(0, 200)}</code>`);
  } finally {
    deploying = false;
  }
}

// ── Schedule Deploy ──────────────────────────────────────────
function scheduleDeployForRound(roundId, endTime) {
  if (deployTimer) { clearTimeout(deployTimer); deployTimer = null; }

  const secsLeft = getSecsLeft(endTime);
  const waitSecs = secsLeft - CFG.deploySecsLeft;

  if (waitSecs <= 0) {
    log(`Round ${roundId}: langsung deploy (sisa ${secsLeft}s)`);
    doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
  } else {
    log(`Round ${roundId}: deploy dalam ${waitSecs}s (sisa ${secsLeft}s)`);
    deployTimer = setTimeout(() => {
      doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
    }, waitSecs * 1000);
  }
}

// ── Round Transition + Win Detection ─────────────────────────
async function onRoundTransition(data) {
  const { settled, newRound } = data;

  // ── Win/Loss Detection ──
  if (settled && deployedThisRnd && lastDeployedBlocks.length > 0) {
    roundsDone++;
    const winBlock = Number(settled.winningBlock);
    const didWin = lastDeployedBlocks.includes(winBlock);

    // Track result
    const result = {
      roundId: settled.roundId,
      won: didWin,
      winBlock,
      blocks: [...lastDeployedBlocks],
      ethDeployed: CFG.ethPerRound,
    };
    roundResults.push(result);

    if (didWin) {
      wins++;
      log(`🏆 MENANG! Round ${settled.roundId} — winBlock: ${winBlock}`);

      const totalPool = settled.totalWinnings
        ? ethers.formatEther(settled.totalWinnings)
        : "?";

      await tg(
        `🏆 <b>MENANG! Round #${settled.roundId}</b>\n\n` +
        `• Winning block: <code>#${winBlock}</code>\n` +
        `• Blokmu: <code>${lastDeployedBlocks.join(", ")}</code>\n` +
        `• Total pool: <code>${totalPool} ETH</code>\n\n` +
        `Gunakan /rewards untuk cek hasilmu!`
      );
    } else {
      losses++;
      log(`❌ Kalah Round ${settled.roundId} — winBlock: ${winBlock}, blocks: [${lastDeployedBlocks}]`);
    }

    log(`Score: ${wins}W/${losses}L (${((wins / (wins + losses)) * 100).toFixed(1)}%)`);

  } else if (deployedThisRnd) {
    roundsDone++;
  }

  // Reset for new round
  deployedThisRnd = false;
  lastDeployedBlocks = [];
  lastGridData = null;

  // Beanpot check
  if (settled) {
    const bpHit = settled.beanpotAmount && settled.beanpotAmount !== "0";
    if (bpHit) {
      await tg(
        `🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\n` +
        `Jackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`
      );
    }
  }

  // Check if done (only if totalRounds > 0)
  if (CFG.totalRounds > 0 && roundsDone >= CFG.totalRounds) {
    if (deployTimer) clearTimeout(deployTimer);

    const total = wins + losses;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
    const spent = parseFloat(ethers.formatEther(totalSpentWei));

    await tg(
      `✅ <b>AUTO-MINER FINISHED!</b>\n\n` +
      `📊 Summary:\n` +
      `• Rounds: <code>${roundsDone}/${CFG.totalRounds}</code>\n` +
      `• Menang: <code>${wins}</code> 🏆\n` +
      `• Kalah: <code>${losses}</code> 😔\n` +
      `• Win rate: <code>${winRate}%</code>\n` +
      `• Total ETH deployed: <code>${spent.toFixed(6)} ETH</code>\n\n` +
      `Gunakan /rewards untuk cek hasilmu!`
    );

    // Auto-claim
    await tryClaimETH("Final");
    if (!CFG.holdBean) await tryClaimBEAN("Final");
    process.exit(0);
  }

  // Periodic claim
  if (roundsDone > 0 && roundsDone % CFG.claimEvery === 0) {
    await tryClaimETH(`Round ${roundsDone}`);
    if (!CFG.holdBean) await tryClaimBEAN(`Round ${roundsDone}`);
  }

  // Schedule next round
  if (newRound) {
    const rId = Number(newRound.roundId);
    currentRoundId = rId;
    log(`New round: ${rId} | endTime: ${newRound.endTime} | beanpot: ${newRound.beanpotPoolFormatted || "?"}`);
    scheduleDeployForRound(rId, newRound.endTime);
  }
}

// ── Claim ETH (internal) ─────────────────────────────────────
async function tryClaimETH(label) {
  try {
    let pending;
    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      pending = parseFloat(rewards.pendingETHFormatted || "0");
    } catch {
      const [pendingWei] = await gridContract.getTotalPendingRewards(wallet.address);
      pending = parseFloat(ethers.formatEther(pendingWei));
    }

    if (pending < CFG.claimEthMin) { log(`Skip ETH claim (${pending.toFixed(6)} < ${CFG.claimEthMin})`); return; }

    const tx = await gridContract.claimETH();
    await tx.wait();
    totalClaimedWei += ethers.parseEther(pending.toString());
    log(`ETH claimed: ${pending.toFixed(6)} ETH`);
    await tg(`💰 <b>ETH Claimed — ${label}</b>\nAmount: <code>${pending.toFixed(6)} ETH</code>`);
  } catch (e) { log(`claimETH error: ${e.message}`); }
}

// ── Claim BEAN (internal) ────────────────────────────────────
async function tryClaimBEAN(label) {
  if (CFG.holdBean) return;
  try {
    const bean = await gridContract.getPendingBEAN(wallet.address);
    const net = parseFloat(ethers.formatEther(bean.net));
    if (net < CFG.claimBeanMin) { log(`Skip BEAN claim (${net.toFixed(4)} < ${CFG.claimBeanMin})`); return; }

    const tx = await gridContract.claimBEAN();
    await tx.wait();
    totalBeanClaimed += bean.net;
    log(`BEAN claimed: ${net.toFixed(4)} BEAN`);
    await tg(`🫘 <b>BEAN Claimed — ${label}</b>\nAmount: <code>${net.toFixed(4)} BEAN</code>`);
  } catch (e) { log(`claimBEAN error: ${e.message}`); }
}

// ── SSE Connection ───────────────────────────────────────────
function connectSSE() {
  let backoff = 3000;

  function connect() {
    log("Connecting SSE...");
    const es = new EventSource(`${API_BASE}/api/events/rounds`);
    sseInstance = es;

    es.onopen = () => {
      log("SSE connected ✓");
      backoff = 3000;
    };

    // Named event handlers
    es.addEventListener("heartbeat", () => {
      log("SSE heartbeat ✓");
    });

    es.addEventListener("deployed", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.blocks) lastGridData = data.blocks;
      } catch (e) { log(`SSE deployed parse err: ${e.message}`); }
    });

    es.addEventListener("roundTransition", (event) => {
      try {
        const data = JSON.parse(event.data);
        log("roundTransition diterima ✓");
        onRoundTransition(data).catch(e => log(`onRoundTransition err: ${e.message}`));
      } catch (e) { log(`SSE roundTransition parse err: ${e.message}`); }
    });

    // Fallback for JSON-wrapped events
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const type = parsed.type;
        const data = parsed.data || parsed;

        if (type === "heartbeat") log("SSE heartbeat ✓");
        else if (type === "deployed" && data?.blocks) lastGridData = data.blocks;
        else if (type === "roundTransition") {
          log("roundTransition diterima ✓");
          onRoundTransition(data).catch(e => log(`onRoundTransition err: ${e.message}`));
        }
      } catch (e) { log(`SSE parse err: ${e.message}`); }
    };

    es.onerror = () => {
      log(`SSE error. Reconnect ${backoff / 1000}s...`);
      es.close();
      sseInstance = null;

      setTimeout(async () => {
        backoff = Math.min(backoff * 2, 30000);
        try {
          const round = await apiGet(`/api/round/current?user=${wallet.address}`);
          const rId = Number(round.roundId);
          const secsLeft = getSecsLeft(round.endTime);
          currentRoundId = rId;
          lastGridData = round.blocks;
          log(`SSE recovery: round ${rId}, ${secsLeft}s left`);
          if (!deployedThisRnd && secsLeft > CFG.deploySecsLeft + 2) {
            scheduleDeployForRound(rId, round.endTime);
          }
        } catch (e) { log(`SSE recovery fail: ${e.message}`); }
        connect();
      }, backoff);
    };
  }

  connect();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log("=== MineBean Bot v5 ===");
  log(`Wallet  : ${wallet.address}`);
  log(`Rounds  : ${CFG.totalRounds || "unlimited (24/7)"} | Blok: ${CFG.blocksPerDeploy} | ETH: ${CFG.ethPerRound}`);
  log(`Strategi: ${CFG.strategy} | Deploy: ${CFG.deploySecsLeft}s sebelum habis`);

  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Chain salah: ${net.chainId}`);
  log("✅ Base Mainnet OK");

  const balance = await provider.getBalance(wallet.address);
  const balEth = parseFloat(ethers.formatEther(balance));
  log(`Saldo   : ${balEth.toFixed(6)} ETH`);

  if (balEth < parseFloat(CFG.minBalance)) {
    log(`⚠️ Saldo rendah: ${balEth.toFixed(6)} ETH — tetap jalan`);
  }

  try {
    const beanBal = await beanContract.balanceOf(wallet.address);
    log(`BEAN    : ${parseFloat(ethers.formatEther(beanBal)).toFixed(4)} BEAN`);
  } catch { }

  // EV
  const ev = await calculateEV();
  let evLine = "";
  if (ev) {
    evLine = `\n\n📊 <b>EV/round:</b> <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH</code> ${ev.netEV >= 0 ? "✅" : "⚠️"}` +
      `\n   BEAN: ${ev.beanValue.toFixed(8)} | Beanpot: ${ev.beanpotEV.toFixed(8)} | Cost: ${ev.houseCost.toFixed(8)}`;
    log(`EV: ${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH`);
  }

  const roundsText = CFG.totalRounds ? `${CFG.totalRounds} rounds` : "unlimited (24/7)";

  await tg(
    `🤖 <b>AUTO-MINER v5 STARTED!</b> (${roundsText})\n\n` +
    `Session: <code>${wallet.address.slice(0, 10)}...</code> | PID: <code>${process.pid}</code>\n\n` +
    `⚙️ Config:\n` +
    `• ${CFG.blocksPerDeploy} blocks per deploy (${CFG.strategy})\n` +
    `• Modal: <code>${CFG.ethPerRound} ETH/round</code>\n` +
    `• Deploy: ${CFG.deploySecsLeft}s sebelum round habis\n` +
    `• Claim ETH: setiap ${CFG.claimEvery} rounds\n` +
    `• BEAN: ${CFG.holdBean ? "HOLD (roasting bonus)" : `claim setiap ${CFG.claimEvery} rounds`}\n` +
    `• Duration: ${roundsText}` +
    evLine +
    `\n\n📋 Commands: /rewards /claim /status /stats /ev /balance /stop`
  );

  // Fetch current round
  try {
    const round = await apiGet(`/api/round/current?user=${wallet.address}`);
    const rId = Number(round.roundId);
    const secsLeft = getSecsLeft(round.endTime);
    currentRoundId = rId;
    lastGridData = round.blocks;

    log(`Round sekarang: ${rId} | Sisa: ${secsLeft}s`);

    if (secsLeft > CFG.deploySecsLeft + 2) {
      scheduleDeployForRound(rId, round.endTime);
    } else {
      log(`Mepet (${secsLeft}s sisa). Tunggu round berikutnya.`);
    }
  } catch (e) {
    log(`Fetch round awal gagal: ${e.message}. Tunggu SSE.`);
  }

  connectSSE();
  startTelegramPolling();

  // Periodic status (every 30 min)
  setInterval(() => {
    cmdStatus().catch(e => log(`periodic status err: ${e.message}`));
  }, 30 * 60 * 1000);

  log("Bot berjalan ✓");
}

// ── Shutdown ─────────────────────────────────────────────────
process.on("SIGINT", async () => {
  log("SIGINT received");
  botRunning = false;
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  if (tgPollTimer) clearTimeout(tgPollTimer);
  await tryClaimETH("Shutdown");

  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";

  await tg(
    `🛑 <b>Bot Dihentikan</b>\n` +
    `Rounds: ${roundsDone} | Win: ${wins} | Loss: ${losses} | Rate: ${winRate}%\n` +
    `🫘 BEAN di wallet, klaim di minebean.com`
  );
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("SIGTERM received");
  botRunning = false;
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  if (tgPollTimer) clearTimeout(tgPollTimer);
  await tryClaimETH("SIGTERM");
  await tg(`🛑 <b>Bot SIGTERM</b> — ${roundsDone} rounds, ${wins}W/${losses}L`);
  process.exit(0);
});

process.on("unhandledRejection", (r) => log(`[unhandledRejection] ${r}`));

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await tg(`💥 <b>Bot Crash!</b>\n<code>${e.message.slice(0, 300)}</code>`);
  process.exit(1);
});
