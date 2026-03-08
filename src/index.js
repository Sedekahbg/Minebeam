// ============================================================
//  MineBean Auto Deploy Bot v3
//  Chain: Base Mainnet (8453)
// ============================================================
import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";
import EventSource from "eventsource";

// ── Config ───────────────────────────────────────────────────
const CFG = {
  privateKey:      process.env.PRIVATE_KEY        || (() => { throw new Error("PRIVATE_KEY wajib diisi!") })(),
  rpcUrl:          process.env.BASE_RPC_URL        || "https://mainnet.base.org",
  tgToken:         process.env.TELEGRAM_BOT_TOKEN  || "",
  tgChat:          process.env.TELEGRAM_CHAT_ID    || "",
  totalRounds:     parseInt(process.env.TOTAL_ROUNDS)           || 10,
  blocksPerDeploy: parseInt(process.env.BLOCKS_PER_DEPLOY)      || 5,
  ethPerRound:     process.env.ETH_PER_ROUND                    || "0.0000125",
  strategy:        process.env.BLOCK_STRATEGY                   || "least_crowded",
  deploySecsLeft:  parseInt(process.env.DEPLOY_AT_SECONDS_LEFT) || 15,
  claimEvery:      parseInt(process.env.CLAIM_EVERY_N_ROUNDS)   || 5,
  claimEthMin:     parseFloat(process.env.CLAIM_ETH_MIN)        || 0.0005,
};

// Auto-fix minimum ETH
const MIN_PER_BLOCK = 0.0000025;
const minNeeded = MIN_PER_BLOCK * CFG.blocksPerDeploy;
if (parseFloat(CFG.ethPerRound) < minNeeded) {
  console.warn(`⚠️  ETH_PER_ROUND terlalu kecil, pakai minimum: ${minNeeded}`);
  CFG.ethPerRound = minNeeded.toFixed(10);
}

// ── Contracts ────────────────────────────────────────────────
const GRID_ADDR = "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0";
const GRID_ABI  = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function getTotalPendingRewards(address user) view returns (uint256 pendingETH, uint256 unroastedBEAN, uint256 roastedBEAN, uint64 uncheckpointedRound)",
  "function getPendingBEAN(address user) view returns (uint256 gross, uint256 fee, uint256 net)",
];

const API_BASE = "https://api.minebean.com";

// ── Provider & wallet ────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
const wallet   = new ethers.Wallet(CFG.privateKey, provider);
const contract = new ethers.Contract(GRID_ADDR, GRID_ABI, wallet);

// ── State ────────────────────────────────────────────────────
let roundsDone      = 0;
let deployedThisRnd = false;
let totalSpentWei   = 0n;
let totalClaimedWei = 0n;
let sessionStart    = Date.now();
let deployTimer     = null;
let currentRoundId  = null;

// ── Helpers ──────────────────────────────────────────────────
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const shortTx = (h) => `${h.slice(0, 10)}...${h.slice(-6)}`;
const elapsed = () => {
  const s = Math.floor((Date.now() - sessionStart) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

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

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// FIX UTAMA: Hitung sisa waktu dari endTime (unix detik), bukan pakai timeRemaining
// timeRemaining di API response bisa null/undefined/0 — tidak bisa diandalkan
function getSecsLeft(endTime) {
  const end = Number(endTime);
  if (!end || isNaN(end)) return 0;
  return Math.max(0, Math.floor((end * 1000 - Date.now()) / 1000));
}

// ── Pilih blok ───────────────────────────────────────────────
function pickBlocks(blocks) {
  const n = CFG.blocksPerDeploy;

  if (!blocks || blocks.length === 0) {
    // Fallback random kalau tidak ada data
    const all = Array.from({ length: 25 }, (_, i) => i);
    for (let i = 24; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, n).sort((a, b) => a - b);
  }

  if (CFG.strategy === "least_crowded") {
    return [...blocks]
      .sort((a, b) => parseFloat(a.deployedFormatted || "0") - parseFloat(b.deployedFormatted || "0"))
      .slice(0, n)
      .map(b => b.id)
      .sort((a, b) => a - b);
  }

  const all = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).sort((a, b) => a - b);
}

// ── Deploy ───────────────────────────────────────────────────
async function doDeploy(roundId) {
  if (deployedThisRnd) {
    log(`Round ${roundId}: sudah deploy, skip.`);
    return;
  }

  log(`Round ${roundId}: mulai deploy...`);

  // Fetch grid
  let round;
  try {
    round = await apiGet(`/api/round/current?user=${wallet.address}`);
    log(`Grid OK: roundId=${round.roundId}, pool=${round.totalDeployedFormatted} ETH, sisa=${getSecsLeft(round.endTime)}s`);
  } catch (e) {
    log(`Gagal fetch grid: ${e.message} — pakai random`);
    round = { blocks: [], totalDeployedFormatted: "?", beanpotPoolFormatted: "?" };
  }

  // Cek round tidak sudah berganti
  if (round.roundId && Number(round.roundId) !== Number(roundId)) {
    log(`Round ${roundId} sudah kedaluwarsa (now: ${round.roundId}), skip.`);
    return;
  }

  // Cek waktu masih ada
  const secsLeft = getSecsLeft(round.endTime);
  if (secsLeft < 5) {
    log(`Round ${roundId}: tinggal ${secsLeft}s, terlalu mepet, skip.`);
    return;
  }

  const blocks   = pickBlocks(round.blocks);
  const ethValue = ethers.parseEther(CFG.ethPerRound);
  const perBlock = (parseFloat(CFG.ethPerRound) / CFG.blocksPerDeploy).toFixed(8);

  log(`Blok: [${blocks.join(", ")}] | ${CFG.ethPerRound} ETH | ${secsLeft}s sisa`);

  await tg(
    `🎯 <b>AUTO-MINER RUNNING</b>\n\n` +
    `📍 Round <b>${roundId}/${CFG.totalRounds}</b>\n` +
    `Blocks: <code>[${blocks.join(", ")}]</code>\n` +
    `ETH: <code>${CFG.ethPerRound} ETH</code> (${perBlock}/blok)\n` +
    `Pool: <code>${round.totalDeployedFormatted} ETH</code> | Beanpot: <code>${round.beanpotPoolFormatted} BEAN</code>`
  );

  try {
    const tx = await contract.deploy(blocks, { value: ethValue });
    deployedThisRnd = true;
    totalSpentWei  += ethValue;
    log(`TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`TX confirmed: block ${receipt.blockNumber}`);

    await tg(
      `✅ <b>Round ${roundId}/${CFG.totalRounds} completed</b>\n\n` +
      `Deployed: Blocks <code>[${blocks.join(", ")}]</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>\n` +
      `⏳ Waiting for next round (~60s)...`
    );

  } catch (e) {
    log(`Deploy error: ${e.message}`);
    if (e.message.includes("AlreadyDeployedThisRound")) {
      deployedThisRnd = true;
      log("AlreadyDeployedThisRound — dianggap sudah deploy.");
      return;
    }
    deployedThisRnd = false;
    await tg(`❌ <b>Deploy Gagal Round ${roundId}</b>\n<code>${e.message.slice(0, 200)}</code>`);
  }
}

// ── Schedule deploy ───────────────────────────────────────────
function scheduleDeployForRound(roundId, endTime) {
  if (deployTimer) { clearTimeout(deployTimer); deployTimer = null; }

  const secsLeft = getSecsLeft(endTime);
  const waitSecs = secsLeft - CFG.deploySecsLeft;

  if (waitSecs <= 0) {
    log(`Round ${roundId}: langsung deploy (sisa ${secsLeft}s)`);
    doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
  } else {
    log(`Round ${roundId}: deploy dalam ${waitSecs}s (sisa ${secsLeft}s - ${CFG.deploySecsLeft}s buffer)`);
    deployTimer = setTimeout(() => {
      doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
    }, waitSecs * 1000);
  }
}

// ── Claim ETH ─────────────────────────────────────────────────
async function tryClaimETH(label) {
  try {
    const [pendingWei] = await contract.getTotalPendingRewards(wallet.address);
    const pending = parseFloat(ethers.formatEther(pendingWei));
    log(`Pending ETH: ${pending.toFixed(6)} ETH`);
    if (pending < CFG.claimEthMin) { log(`Skip claim (< ${CFG.claimEthMin})`); return; }

    const tx = await contract.claimETH();
    await tx.wait();
    totalClaimedWei += pendingWei;
    await tg(
      `💰 <b>ETH Claimed${label ? ` — ${label}` : ""}!</b>\n` +
      `Amount: <code>${pending.toFixed(6)} ETH</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (e) { log(`claimETH error: ${e.message}`); }
}

// ── Status ────────────────────────────────────────────────────
async function sendStatus() {
  try {
    const balance = await provider.getBalance(wallet.address);
    const spent   = parseFloat(ethers.formatEther(totalSpentWei));
    const claimed = parseFloat(ethers.formatEther(totalClaimedWei));
    const pnl     = claimed - spent;
    let beanLine  = "";
    try {
      const b = await contract.getPendingBEAN(wallet.address);
      beanLine = `\n🫘 BEAN pending: <code>${parseFloat(ethers.formatEther(b.net)).toFixed(4)} BEAN</code>`;
    } catch {}
    await tg(
      `📊 <b>Status Report</b>\n\n` +
      `⏱ Durasi: <code>${elapsed()}</code>\n` +
      `🔄 Progress: <code>${roundsDone}/${CFG.totalRounds} rounds</code>\n` +
      `💸 ETH dipakai: <code>${spent.toFixed(6)} ETH</code>\n` +
      `💰 ETH kembali: <code>${claimed.toFixed(6)} ETH</code>\n` +
      `📈 Net PnL: <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH</code>` +
      beanLine + `\n` +
      `👛 Saldo: <code>${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH</code>`
    );
  } catch (e) { log(`sendStatus error: ${e.message}`); }
}

// ── Round transition handler ──────────────────────────────────
async function onRoundTransition(data) {
  const { settled, newRound } = data;

  if (deployedThisRnd) { roundsDone++; log(`Round selesai. Total: ${roundsDone}/${CFG.totalRounds}`); }
  deployedThisRnd = false;

  if (settled) {
    const bpHit = settled.beanpotAmount && settled.beanpotAmount !== "0";
    log(`Settled ${settled.roundId} — winBlock: ${settled.winningBlock}${bpHit ? " 🎰 BEANPOT!" : ""}`);
    if (bpHit) {
      await tg(`🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\nWinning block: <code>${settled.winningBlock}</code>\nJackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`);
    }
  }

  if (roundsDone >= CFG.totalRounds) {
    if (deployTimer) clearTimeout(deployTimer);
    await tryClaimETH("Final");
    await sendStatus();
    await tg(`🏁 <b>AUTO-MINER SELESAI! (${CFG.totalRounds} rounds)</b>\n\n⏱ Total: <code>${elapsed()}</code>\n🫘 BEAN ada di wallet, klaim di <a href="https://minebean.com">minebean.com</a>`);
    process.exit(0);
  }

  if (roundsDone > 0 && roundsDone % CFG.claimEvery === 0) {
    await tryClaimETH(`Round ${roundsDone}`);
    await sendStatus();
  }

  if (newRound) {
    const rId = Number(newRound.roundId);
    currentRoundId = rId;
    log(`New round: ${rId} | endTime: ${newRound.endTime}`);
    scheduleDeployForRound(rId, newRound.endTime);
  }
}

// ── SSE ──────────────────────────────────────────────────────
function connectSSE() {
  let backoff = 3000;
  function connect() {
    log("Connecting SSE...");
    const es = new EventSource(`${API_BASE}/api/events/rounds`);
    es.onopen = () => { log("SSE connected ✓"); backoff = 3000; };
    es.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        if (type === "heartbeat") { log("SSE heartbeat ✓"); }
        else if (type === "roundTransition") {
          log("roundTransition diterima");
          onRoundTransition(data).catch(e => log(`onRoundTransition err: ${e.message}`));
        }
      } catch (e) { log(`SSE parse err: ${e.message}`); }
    };
    es.onerror = () => {
      log(`SSE error. Reconnect ${backoff / 1000}s...`);
      es.close();
      setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connect(); }, backoff);
    };
  }
  connect();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log("=== MineBean Bot v3 ===");
  log(`Wallet  : ${wallet.address}`);
  log(`Rounds  : ${CFG.totalRounds} | Blok: ${CFG.blocksPerDeploy} | ETH: ${CFG.ethPerRound}`);
  log(`Strategi: ${CFG.strategy} | Deploy: ${CFG.deploySecsLeft}s sebelum habis`);

  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Chain salah: ${net.chainId}`);
  log("✅ Base Mainnet OK");

  const balance = await provider.getBalance(wallet.address);
  const balEth  = parseFloat(ethers.formatEther(balance));
  log(`Saldo   : ${balEth.toFixed(6)} ETH`);

  // EV
  let evLine = "";
  try {
    const [p, r] = await Promise.all([apiGet("/api/price"), apiGet("/api/round/current")]);
    const price  = parseFloat(p.bean.priceNative);
    const bpPool = parseFloat(r.beanpotPoolFormatted || "0");
    const net    = (1.0 * price) + (bpPool * price / 777) - parseFloat(CFG.ethPerRound) * 0.11;
    evLine = `\n\n📊 <b>EV/round:</b> <code>${net >= 0 ? "+" : ""}${net.toFixed(8)} ETH</code> ${net >= 0 ? "✅" : "⚠️"}`;
    log(`EV: ${net >= 0 ? "+" : ""}${net.toFixed(8)} ETH`);
  } catch (e) { log(`EV skip: ${e.message}`); }

  await tg(
    `🤖 <b>AUTO-MINER STARTED! (${CFG.totalRounds} rounds)</b>\n\n` +
    `Session: <code>${wallet.address.slice(0, 10)}...</code> | PID: <code>${process.pid}</code>\n\n` +
    `Auto-miner akan:\n` +
    `• Deploy tiap 60 detik (1 round)\n` +
    `• ${CFG.blocksPerDeploy} blocks per deploy (${CFG.strategy})\n` +
    `• Modal: <code>${CFG.ethPerRound} ETH/round</code>\n` +
    `• Total ${CFG.totalRounds} rounds = ~${CFG.totalRounds} menit` +
    evLine
  );

  // Fetch round sekarang dan schedule deploy
  try {
    const round    = await apiGet(`/api/round/current?user=${wallet.address}`);
    const rId      = Number(round.roundId);
    const secsLeft = getSecsLeft(round.endTime);  // FIX: pakai endTime bukan timeRemaining
    currentRoundId = rId;

    log(`Round sekarang: ${rId} | endTime: ${round.endTime} | Sisa: ${secsLeft}s`);

    if (secsLeft > CFG.deploySecsLeft + 5) {
      log(`Ada waktu! Schedule deploy round ${rId} dalam ${secsLeft - CFG.deploySecsLeft}s`);
      scheduleDeployForRound(rId, round.endTime);
    } else {
      log(`Mepet (${secsLeft}s sisa). Tunggu round berikutnya via SSE.`);
    }
  } catch (e) {
    log(`Fetch round awal gagal: ${e.message}. Tunggu SSE.`);
  }

  connectSSE();
  log("Bot berjalan ✓");
}

process.on("SIGINT", async () => {
  if (deployTimer) clearTimeout(deployTimer);
  await tg(`🛑 <b>Bot Dihentikan</b>\n${roundsDone}/${CFG.totalRounds} rounds.\n🫘 BEAN di wallet, klaim di minebean.com`);
  process.exit(0);
});
process.on("SIGTERM", () => { if (deployTimer) clearTimeout(deployTimer); process.exit(0); });
process.on("unhandledRejection", (r) => log(`[unhandledRejection] ${r}`));

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await tg(`💥 <b>Bot Crash!</b>\n<code>${e.message.slice(0, 300)}</code>`);
  process.exit(1);
});
