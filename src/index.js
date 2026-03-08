// ============================================================
//  MineBean Auto Deploy Bot
//  Chain: Base Mainnet (8453)
//  Docs: https://www.minebean.com/skill.md
// ============================================================
import "dotenv/config";
import { ethers } from "ethers";
import EventSource from "eventsource";
import fetch from "node-fetch";

// ── Config dari env ─────────────────────────────────────────
const CFG = {
  privateKey:          process.env.PRIVATE_KEY             || (() => { throw new Error("PRIVATE_KEY wajib diisi!") })(),
  rpcUrl:              process.env.BASE_RPC_URL             || "https://mainnet.base.org",
  tgToken:             process.env.TELEGRAM_BOT_TOKEN       || "",
  tgChat:              process.env.TELEGRAM_CHAT_ID         || "",
  totalRounds:         parseInt(process.env.TOTAL_ROUNDS)   || 10,
  blocksPerDeploy:     parseInt(process.env.BLOCKS_PER_DEPLOY) || 5,
  ethPerRound:         process.env.ETH_PER_ROUND            || "0.0000125",
  strategy:            process.env.BLOCK_STRATEGY           || "least_crowded",
  deploySecsLeft:      parseInt(process.env.DEPLOY_AT_SECONDS_LEFT) || 15,
  claimEvery:          parseInt(process.env.CLAIM_EVERY_N_ROUNDS)   || 5,
  claimEthMin:         parseFloat(process.env.CLAIM_ETH_MIN)        || 0.0005,
};

// Validasi minimum deploy
const MIN_ETH_PER_BLOCK = 0.0000025;
const minRequired = MIN_ETH_PER_BLOCK * CFG.blocksPerDeploy;
if (parseFloat(CFG.ethPerRound) < minRequired) {
  console.warn(`⚠️  ETH_PER_ROUND terlalu kecil! Minimum untuk ${CFG.blocksPerDeploy} blok = ${minRequired} ETH`);
  console.warn(`    Otomatis dinaikkan ke ${minRequired} ETH`);
  CFG.ethPerRound = minRequired.toFixed(10);
}

// ── Contracts ───────────────────────────────────────────────
const ADDR = {
  GridMining: "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0",
  Bean:       "0x5c72992b83E74c4D5200A8E8920fB946214a5A5D",
};

const ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function getTotalPendingRewards(address user) view returns (uint256 pendingETH, uint256 unroastedBEAN, uint256 roastedBEAN, uint64 uncheckpointedRound)",
  "function getPendingBEAN(address user) view returns (uint256 gross, uint256 fee, uint256 net)",
  "function beanpotPool() view returns (uint256)",
  "function currentRoundId() view returns (uint64)",
];

const API = "https://api.minebean.com";
const SSE = `${API}/api/events/rounds`;

// ── Setup provider ───────────────────────────────────────────
const provider   = new ethers.JsonRpcProvider(CFG.rpcUrl);
const wallet     = new ethers.Wallet(CFG.privateKey, provider);
const contract   = new ethers.Contract(ADDR.GridMining, ABI, wallet);

// ── State ────────────────────────────────────────────────────
let roundsDone       = 0;
let deployedThisRnd  = false;
let totalSpentWei    = 0n;
let totalClaimedWei  = 0n;
let sessionStart     = Date.now();
let lastHeartbeat    = Date.now();

// ── Helpers ──────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function shortTx(hash) {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function elapsed() {
  const s = Math.floor((Date.now() - sessionStart) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function tg(text) {
  if (!CFG.tgToken || !CFG.tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.tgChat, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    log(`[TG] Gagal kirim: ${e.message}`);
  }
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// ── EV Calculator ────────────────────────────────────────────
// Net EV = BEAN_value + Beanpot_EV − (ETH_deployed × 11%)
// Tujuan: main dengan modal kecil tapi dapat BEAN yang nilainya bisa besar
async function calcEV() {
  try {
    const [priceData, roundData] = await Promise.all([
      apiGet("/api/price"),
      apiGet("/api/round/current"),
    ]);
    const priceNative   = parseFloat(priceData.bean.priceNative);  // BEAN dalam ETH
    const beanpotPool   = parseFloat(roundData.beanpotPoolFormatted || "0");
    const ethDeployed   = parseFloat(CFG.ethPerRound);

    const beanValue     = 1.0 * priceNative;           // 1 BEAN per round
    const beanpotEV     = (1 / 777) * beanpotPool * priceNative;
    const houseCost     = ethDeployed * 0.11;           // ~1% admin + ~10% vault dari losers
    const netEV         = beanValue + beanpotEV - houseCost;

    return { netEV, beanValue, beanpotEV, houseCost, priceNative, beanpotPool, ok: true };
  } catch {
    return { ok: false };
  }
}

// ── Pilih blok ───────────────────────────────────────────────
function pickBlocks(blocks) {
  const n = CFG.blocksPerDeploy;
  if (CFG.strategy === "least_crowded") {
    // Pilih blok paling sedikit ETH-nya = share lebih besar kalau menang
    return [...blocks]
      .sort((a, b) => parseFloat(a.deployedFormatted) - parseFloat(b.deployedFormatted))
      .slice(0, n)
      .map(b => b.id)
      .sort((a, b) => a - b);
  }
  // Random
  const all = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).sort((a, b) => a - b);
}

// ── Deploy ───────────────────────────────────────────────────
async function doDeploy(roundId) {
  if (deployedThisRnd) return;

  // Fetch grid
  let round;
  try { round = await apiGet(`/api/round/current?user=${wallet.address}`); }
  catch (e) { log(`Gagal fetch round: ${e.message}`); return; }

  // Pilih blok
  const blocks   = pickBlocks(round.blocks);
  const ethValue = ethers.parseEther(CFG.ethPerRound);
  const perBlock = (parseFloat(CFG.ethPerRound) / CFG.blocksPerDeploy).toFixed(8);

  log(`Round ${roundId}: deploy blok [${blocks.join(",")}] — ${CFG.ethPerRound} ETH`);

  // Notif sebelum deploy
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
    log(`Tx sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`Confirmed block ${receipt.blockNumber}`);

    await tg(
      `✅ <b>Round ${roundId}/${CFG.totalRounds} completed</b>\n\n` +
      `Deployed: Blocks <code>[${blocks.join(", ")}]</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>\n` +
      `⏳ Waiting for next round (~60s)...`
    );

  } catch (e) {
    deployedThisRnd = false;
    log(`Deploy gagal: ${e.message}`);
    await tg(`❌ <b>Deploy Failed Round ${roundId}</b>\n<code>${e.message.slice(0, 150)}</code>`);
  }
}

// ── Claim ETH ────────────────────────────────────────────────
async function tryClaimETH(label = "") {
  try {
    const [pendingWei] = await contract.getTotalPendingRewards(wallet.address);
    const pending = parseFloat(ethers.formatEther(pendingWei));
    log(`Pending ETH: ${pending.toFixed(6)} ETH`);

    if (pending < CFG.claimEthMin) {
      log(`Di bawah threshold (${CFG.claimEthMin} ETH), skip claim.`);
      return;
    }

    const tx = await contract.claimETH();
    await tx.wait();
    totalClaimedWei += pendingWei;
    log(`Claimed ${pending.toFixed(6)} ETH`);

    await tg(
      `💰 <b>ETH Claimed${label ? " — " + label : ""}!</b>\n` +
      `Amount: <code>${pending.toFixed(6)} ETH</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (e) {
    log(`claimETH gagal: ${e.message}`);
  }
}

// ── Status report ────────────────────────────────────────────
async function sendStatus() {
  try {
    const balance    = await provider.getBalance(wallet.address);
    const beanInfo   = await contract.getPendingBEAN(wallet.address).catch(() => null);
    const spent      = parseFloat(ethers.formatEther(totalSpentWei));
    const claimed    = parseFloat(ethers.formatEther(totalClaimedWei));
    const pnl        = claimed - spent;
    const beanNet    = beanInfo ? parseFloat(ethers.formatEther(beanInfo.net)).toFixed(4) : "?";

    await tg(
      `📊 <b>Status Report</b>\n\n` +
      `⏱ Durasi: <code>${elapsed()}</code>\n` +
      `🔄 Progress: <code>${roundsDone}/${CFG.totalRounds} rounds</code>\n` +
      `💸 ETH dipakai: <code>${spent.toFixed(6)} ETH</code>\n` +
      `💰 ETH kembali: <code>${claimed.toFixed(6)} ETH</code>\n` +
      `📈 Net PnL: <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH</code>\n` +
      `🫘 BEAN pending: <code>${beanNet} BEAN</code> (belum di-claim)\n` +
      `👛 Saldo wallet: <code>${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH</code>`
    );
  } catch (e) {
    log(`sendStatus error: ${e.message}`);
  }
}

// ── Handle round transition ───────────────────────────────────
async function onRoundTransition({ settled, newRound }) {
  // Hitung round selesai
  if (deployedThisRnd) roundsDone++;
  deployedThisRnd = false;

  // Log hasil round sebelumnya
  if (settled) {
    const hit = settled.beanpotAmount && settled.beanpotAmount !== "0";
    log(`Round ${settled.roundId} settled — winBlock: ${settled.winningBlock}${hit ? " 🎰 BEANPOT!" : ""}`);
    if (hit) {
      await tg(
        `🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\n` +
        `Winning block: <code>${settled.winningBlock}</code>\n` +
        `Jackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`
      );
    }
  }

  // Selesai?
  if (roundsDone >= CFG.totalRounds) {
    log(`✅ Semua ${CFG.totalRounds} round selesai!`);
    await tryClaimETH("Final");
    await sendStatus();
    await tg(
      `🏁 <b>AUTO-MINER SELESAI! (${CFG.totalRounds} rounds)</b>\n\n` +
      `⏱ Total waktu: <code>${elapsed()}</code>\n\n` +
      `🫘 BEAN rewards ada di wallet kamu!\n` +
      `Klaim manual di <a href="https://minebean.com">minebean.com</a> kapanpun kamu mau.`
    );
    process.exit(0);
  }

  // Periodic claim + status
  if (roundsDone > 0 && roundsDone % CFG.claimEvery === 0) {
    await tryClaimETH(`Round ${roundsDone}`);
    await sendStatus();
  }

  // Schedule deploy untuk round baru
  if (newRound) {
    const rId     = Number(newRound.roundId);
    const endMs   = Number(newRound.endTime) * 1000;
    const deployAt = endMs - (CFG.deploySecsLeft * 1000);
    const wait    = deployAt - Date.now();

    log(`Round ${rId} baru. Deploy dalam ${Math.max(0, Math.round(wait / 1000))}s`);

    if (wait > 500) {
      setTimeout(() => doDeploy(rId), wait);
    } else {
      await doDeploy(rId); // langsung kalau sudah mepet
    }
  }
}

// ── SSE ──────────────────────────────────────────────────────
function connectSSE() {
  let backoff = 5000;
  function connect() {
    log("Connecting SSE...");
    const es = new EventSource(SSE);

    es.onopen    = () => { log("SSE connected ✓"); backoff = 5000; };
    es.onerror   = () => {
      log(`SSE error, reconnect in ${backoff / 1000}s`);
      es.close();
      setTimeout(() => { backoff = Math.min(backoff * 2, 60000); connect(); }, backoff);
    };
    es.onmessage = async ({ data }) => {
      try {
        lastHeartbeat = Date.now();
        const { type, data: d } = JSON.parse(data);
        if (type === "roundTransition") await onRoundTransition(d).catch(e => log(`onRound err: ${e.message}`));
        if (type === "heartbeat")       log("SSE heartbeat ✓");
      } catch (e) { log(`SSE parse err: ${e.message}`); }
    };
  }
  connect();

  // Watchdog: kalau SSE tidak ada sinyal 3 menit, reconnect paksa
  setInterval(() => {
    if (Date.now() - lastHeartbeat > 180000) {
      log("SSE watchdog: tidak ada sinyal 3 menit, reconnect...");
      connect();
    }
  }, 60000);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log("=== MineBean Bot Starting ===");
  log(`Wallet : ${wallet.address}`);
  log(`Rounds : ${CFG.totalRounds}`);
  log(`Blok   : ${CFG.blocksPerDeploy} per round`);
  log(`ETH/rnd: ${CFG.ethPerRound} ETH`);
  log(`Strategi: ${CFG.strategy}`);
  log(`Deploy  : ${CFG.deploySecsLeft}s sebelum round habis`);

  // Cek network
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Chain salah! Got ${net.chainId}, expected 8453 (Base)`);
  log("✅ Base Mainnet (8453)");

  // Cek saldo
  const balance  = await provider.getBalance(wallet.address);
  const balEth   = parseFloat(ethers.formatEther(balance));
  const needed   = parseFloat(CFG.ethPerRound) * CFG.totalRounds;
  log(`Saldo  : ${balEth.toFixed(6)} ETH | Dibutuhkan ~${needed.toFixed(6)} ETH`);
  if (balEth < needed * 1.1) log("⚠️  Saldo mepet! Pastikan ada cukup ETH untuk gas juga.");

  // EV info
  const ev = await calcEV();
  let evLine = "";
  if (ev.ok) {
    evLine =
      `\n\n📊 <b>EV Per Round:</b>\n` +
      `BEAN value : <code>${ev.beanValue.toFixed(8)} ETH</code>\n` +
      `Beanpot EV : <code>${ev.beanpotEV.toFixed(8)} ETH</code>\n` +
      `House cost : <code>${ev.houseCost.toFixed(8)} ETH</code>\n` +
      `<b>Net EV    : <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH ${ev.netEV >= 0 ? "✅" : "⚠️"}</code></b>`;
    log(`EV: ${ev.netEV.toFixed(8)} ETH (${ev.netEV >= 0 ? "POSITIF ✅" : "NEGATIF ⚠️"})`);
  }

  // Notif start
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

  // Deploy ke round yang sedang berjalan kalau masih ada waktu
  try {
    const round    = await apiGet(`/api/round/current?user=${wallet.address}`);
    const timeLeft = Number(round.timeRemaining);
    if (timeLeft > CFG.deploySecsLeft + 5) {
      const wait = (timeLeft - CFG.deploySecsLeft) * 1000;
      log(`Round ${round.roundId} sedang jalan, sisa ${timeLeft}s. Deploy dalam ${Math.round(wait / 1000)}s`);
      setTimeout(() => doDeploy(Number(round.roundId)), wait);
    } else {
      log(`Sisa waktu round terlalu mepet (${timeLeft}s), tunggu round berikutnya.`);
    }
  } catch (e) {
    log(`Tidak bisa fetch round awal: ${e.message}`);
  }

  // Start SSE
  connectSSE();
  log("Bot berjalan. Menunggu round events...");
}

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await tg(`💥 <b>Bot Crash!</b>\n<code>${e.message.slice(0, 300)}</code>`);
  process.exit(1);
});

process.on("SIGINT", async () => {
  log("Shutdown (SIGINT)...");
  await tg(`🛑 <b>Bot Dihentikan Manual</b>\n${roundsDone}/${CFG.totalRounds} rounds selesai.\n🫘 BEAN masih di wallet, klaim kapanpun di minebean.com`);
  process.exit(0);
});

process.on("unhandledRejection", (r) => log(`[unhandledRejection] ${r}`));
