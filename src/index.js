// ============================================================
//  MineBean Auto Deploy Bot v2
//  Chain: Base Mainnet (8453)
// ============================================================
import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";

// ── Config ───────────────────────────────────────────────────
const CFG = {
  privateKey:      process.env.PRIVATE_KEY        || (() => { throw new Error("PRIVATE_KEY wajib diisi!") })(),
  rpcUrl:          process.env.BASE_RPC_URL        || "https://mainnet.base.org",
  tgToken:         process.env.TELEGRAM_BOT_TOKEN  || "",
  tgChat:          process.env.TELEGRAM_CHAT_ID    || "",
  totalRounds:     parseInt(process.env.TOTAL_ROUNDS)         || 10,
  blocksPerDeploy: parseInt(process.env.BLOCKS_PER_DEPLOY)    || 5,
  ethPerRound:     process.env.ETH_PER_ROUND                  || "0.0000125",
  strategy:        process.env.BLOCK_STRATEGY                 || "least_crowded",
  deploySecsLeft:  parseInt(process.env.DEPLOY_AT_SECONDS_LEFT) || 15,
  claimEvery:      parseInt(process.env.CLAIM_EVERY_N_ROUNDS)  || 5,
  claimEthMin:     parseFloat(process.env.CLAIM_ETH_MIN)       || 0.0005,
};

// Validasi & auto-fix minimum ETH
const MIN_PER_BLOCK = 0.0000025;
const minNeeded = MIN_PER_BLOCK * CFG.blocksPerDeploy;
if (parseFloat(CFG.ethPerRound) < minNeeded) {
  console.warn(`⚠️  ETH_PER_ROUND terlalu kecil, otomatis pakai minimum: ${minNeeded}`);
  CFG.ethPerRound = minNeeded.toFixed(10);
}

// ── Contracts ────────────────────────────────────────────────
const GRID_ADDR = "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0";
const GRID_ABI  = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function getTotalPendingRewards(address user) view returns (uint256 pendingETH, uint256 unroastedBEAN, uint256 roastedBEAN, uint64 uncheckpointedRound)",
  "function getPendingBEAN(address user) view returns (uint256 gross, uint256 fee, uint256 net)",
  "function beanpotPool() view returns (uint256)",
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
let sseInstance     = null;

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
  } catch (e) {
    log(`[TG] ${e.message}`);
  }
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// ── Pilih blok ───────────────────────────────────────────────
function pickBlocks(blocks) {
  const n = CFG.blocksPerDeploy;
  if (CFG.strategy === "least_crowded") {
    return [...blocks]
      .sort((a, b) => parseFloat(a.deployedFormatted) - parseFloat(b.deployedFormatted))
      .slice(0, n)
      .map(b => b.id)
      .sort((a, b) => a - b);
  }
  // random
  const all = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).sort((a, b) => a - b);
}

// ── EV check ─────────────────────────────────────────────────
async function getEVLine() {
  try {
    const [p, r] = await Promise.all([apiGet("/api/price"), apiGet("/api/round/current")]);
    const price  = parseFloat(p.bean.priceNative);
    const bpPool = parseFloat(r.beanpotPoolFormatted || "0");
    const cost   = parseFloat(CFG.ethPerRound) * 0.11;
    const bVal   = 1.0 * price;
    const bpEV   = (1 / 777) * bpPool * price;
    const net    = bVal + bpEV - cost;
    return `\n\n📊 <b>EV/round:</b> <code>${net >= 0 ? "+" : ""}${net.toFixed(8)} ETH</code> ${net >= 0 ? "✅" : "⚠️"}`;
  } catch {
    return "";
  }
}

// ── Deploy ───────────────────────────────────────────────────
async function doDeploy(roundId) {
  if (deployedThisRnd) {
    log(`Round ${roundId}: sudah deploy, skip.`);
    return;
  }

  log(`Round ${roundId}: mulai deploy...`);

  // Fetch grid untuk pilih blok
  let round;
  try {
    round = await apiGet(`/api/round/current?user=${wallet.address}`);
  } catch (e) {
    log(`Gagal fetch grid: ${e.message} — pakai random blocks`);
    round = { blocks: Array.from({ length: 25 }, (_, i) => ({ id: i, deployedFormatted: "0" })), totalDeployedFormatted: "?", beanpotPoolFormatted: "?" };
  }

  // Cek apakah round masih aktif
  if (round.settled) {
    log(`Round ${roundId}: sudah settled, skip.`);
    return;
  }

  const blocks   = pickBlocks(round.blocks);
  const ethValue = ethers.parseEther(CFG.ethPerRound);
  const perBlock = (parseFloat(CFG.ethPerRound) / CFG.blocksPerDeploy).toFixed(8);

  log(`Blok dipilih: [${blocks.join(", ")}] | ${CFG.ethPerRound} ETH total`);

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
    deployedThisRnd = false;
    log(`Deploy error: ${e.message}`);

    // Kalau AlreadyDeployedThisRound, anggap sudah deploy
    if (e.message.includes("AlreadyDeployedThisRound")) {
      deployedThisRnd = true;
      log("AlreadyDeployedThisRound — dianggap sudah deploy round ini.");
      return;
    }

    await tg(`❌ <b>Deploy Gagal Round ${roundId}</b>\n<code>${e.message.slice(0, 200)}</code>`);
  }
}

// ── Claim ETH ────────────────────────────────────────────────
async function tryClaimETH(label) {
  try {
    const [pendingWei] = await contract.getTotalPendingRewards(wallet.address);
    const pending = parseFloat(ethers.formatEther(pendingWei));
    log(`Pending ETH: ${pending.toFixed(6)} ETH`);

    if (pending < CFG.claimEthMin) {
      log(`Di bawah threshold ${CFG.claimEthMin} ETH, skip claim.`);
      return;
    }

    const tx = await contract.claimETH();
    await tx.wait();
    totalClaimedWei += pendingWei;
    log(`Claimed: ${pending.toFixed(6)} ETH`);

    await tg(
      `💰 <b>ETH Claimed${label ? ` — ${label}` : ""}!</b>\n` +
      `Amount: <code>${pending.toFixed(6)} ETH</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (e) {
    log(`claimETH error: ${e.message}`);
  }
}

// ── Status report ─────────────────────────────────────────────
async function sendStatus() {
  try {
    const balance = await provider.getBalance(wallet.address);
    const spent   = parseFloat(ethers.formatEther(totalSpentWei));
    const claimed = parseFloat(ethers.formatEther(totalClaimedWei));
    const pnl     = claimed - spent;

    let beanLine = "";
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
  } catch (e) {
    log(`sendStatus error: ${e.message}`);
  }
}

// ── Schedule deploy untuk round baru ──────────────────────────
function scheduleDeployForRound(roundId, endTime) {
  // Batalkan timer sebelumnya kalau ada
  if (deployTimer) {
    clearTimeout(deployTimer);
    deployTimer = null;
  }

  const deployAt = (endTime * 1000) - (CFG.deploySecsLeft * 1000);
  const msUntil  = deployAt - Date.now();

  if (msUntil <= 0) {
    // Langsung deploy kalau sudah mepet
    log(`Round ${roundId}: waktu mepet, langsung deploy.`);
    doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
  } else {
    log(`Round ${roundId}: deploy dijadwalkan dalam ${Math.round(msUntil / 1000)}s`);
    deployTimer = setTimeout(() => {
      doDeploy(roundId).catch(e => log(`doDeploy error: ${e.message}`));
    }, msUntil);
  }
}

// ── Handle round transition ───────────────────────────────────
async function onRoundTransition(data) {
  const { settled, newRound } = data;

  // Hitung round yang baru selesai
  if (deployedThisRnd) {
    roundsDone++;
    log(`Round selesai. Total: ${roundsDone}/${CFG.totalRounds}`);
  }
  deployedThisRnd = false;

  // Log hasil
  if (settled) {
    const bpHit = settled.beanpotAmount && settled.beanpotAmount !== "0";
    log(`Settled round ${settled.roundId} — winBlock: ${settled.winningBlock}${bpHit ? " 🎰 BEANPOT!" : ""}`);
    if (bpHit) {
      await tg(
        `🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\n` +
        `Winning block: <code>${settled.winningBlock}</code>\n` +
        `Jackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`
      );
    }
  }

  // Selesai semua round?
  if (roundsDone >= CFG.totalRounds) {
    log(`✅ Semua ${CFG.totalRounds} round selesai!`);
    if (deployTimer) clearTimeout(deployTimer);
    await tryClaimETH("Final");
    await sendStatus();
    await tg(
      `🏁 <b>AUTO-MINER SELESAI! (${CFG.totalRounds} rounds)</b>\n\n` +
      `⏱ Total waktu: <code>${elapsed()}</code>\n\n` +
      `🫘 BEAN ada di wallet kamu!\n` +
      `Klaim di <a href="https://minebean.com">minebean.com</a> kapanpun.`
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
    const rId  = Number(newRound.roundId);
    const end  = Number(newRound.endTime);
    log(`New round ${rId} | endTime: ${end}`);
    scheduleDeployForRound(rId, end);
  }
}

// ── SSE — connect dengan pure HTTP (lebih stabil) ────────────
function connectSSE() {
  // Pakai eventsource library
  import("eventsource").then(({ default: EventSource }) => {
    let reconnectDelay = 3000;

    function connect() {
      log("Connecting SSE...");
      const es = new EventSource(`${API_BASE}/api/events/rounds`);

      es.onopen = () => {
        log("SSE connected ✓");
        reconnectDelay = 3000;
      };

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          const { type, data } = parsed;

          if (type === "heartbeat") {
            log("SSE heartbeat ✓");
            return;
          }

          if (type === "roundTransition") {
            log("SSE roundTransition diterima");
            onRoundTransition(data).catch(e => log(`onRoundTransition error: ${e.message}`));
            return;
          }

          if (type === "deployed") {
            // Opsional: update grid info tapi tidak perlu action
            return;
          }

        } catch (e) {
          log(`SSE parse error: ${e.message}`);
        }
      };

      es.onerror = (err) => {
        log(`SSE error. Reconnect dalam ${reconnectDelay / 1000}s...`);
        es.close();
        setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };

      sseInstance = es;
    }

    connect();

  }).catch(e => {
    log(`Import EventSource gagal: ${e.message}`);
    // Fallback: polling setiap 70 detik
    log("Fallback ke polling mode...");
    startPolling();
  });
}

// ── Fallback polling (kalau SSE tidak bisa) ──────────────────
let lastPollRoundId = null;
async function startPolling() {
  log("Polling mode aktif (check tiap 70 detik)");
  await tg("⚠️ <b>Polling Mode</b>\nSSE tidak tersedia, pakai polling tiap 70 detik.");

  async function poll() {
    try {
      const round = await apiGet("/api/round/current");
      const rId   = Number(round.roundId);

      if (rId !== lastPollRoundId) {
        log(`[Poll] Round baru: ${rId}`);
        lastPollRoundId = rId;

        // Simulasi roundTransition
        await onRoundTransition({
          settled: null,
          newRound: {
            roundId: String(rId),
            endTime: round.endTime,
          }
        });
      }
    } catch (e) {
      log(`Poll error: ${e.message}`);
    }
    setTimeout(poll, 70000);
  }

  poll();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log("=== MineBean Bot v2 Starting ===");
  log(`Wallet  : ${wallet.address}`);
  log(`Rounds  : ${CFG.totalRounds}`);
  log(`Blok    : ${CFG.blocksPerDeploy} per round`);
  log(`ETH/rnd : ${CFG.ethPerRound} ETH`);
  log(`Strategi: ${CFG.strategy}`);
  log(`Deploy  : ${CFG.deploySecsLeft}s sebelum round habis`);

  // Cek network
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) {
    throw new Error(`Chain salah! ${net.chainId} bukan Base (8453)`);
  }
  log("✅ Base Mainnet OK");

  // Cek saldo
  const balance = await provider.getBalance(wallet.address);
  const balEth  = parseFloat(ethers.formatEther(balance));
  const needed  = parseFloat(CFG.ethPerRound) * CFG.totalRounds;
  log(`Saldo   : ${balEth.toFixed(6)} ETH | Dibutuhkan ~${needed.toFixed(6)} ETH`);
  if (balEth < needed * 1.1) log("⚠️  Saldo mepet!");

  // EV
  const evLine = await getEVLine();

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
    const rId      = Number(round.roundId);
    lastPollRoundId = rId;

    log(`Round saat ini: ${rId} | Sisa waktu: ${timeLeft}s`);

    if (timeLeft > CFG.deploySecsLeft + 5) {
      scheduleDeployForRound(rId, Number(round.endTime));
    } else {
      log(`Waktu sisa terlalu mepet (${timeLeft}s), tunggu round berikutnya.`);
    }
  } catch (e) {
    log(`Tidak bisa fetch round awal: ${e.message}`);
  }

  // Connect SSE
  connectSSE();
  log("Bot berjalan ✓");
}

// ── Graceful shutdown ─────────────────────────────────────────
process.on("SIGINT", async () => {
  log("Shutdown (SIGINT)...");
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  await tg(`🛑 <b>Bot Dihentikan</b>\n${roundsDone}/${CFG.totalRounds} rounds selesai.\n🫘 BEAN masih di wallet, klaim di minebean.com`);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("Shutdown (SIGTERM)...");
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  process.exit(0);
});

process.on("unhandledRejection", (r) => log(`[unhandledRejection] ${r}`));

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await tg(`💥 <b>Bot Crash!</b>\n<code>${e.message.slice(0, 300)}</code>`);
  process.exit(1);
});
