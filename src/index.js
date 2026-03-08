// ============================================================
//  MineBean Auto Deploy Bot v4
//  Chain: Base Mainnet (8453)
//  Based on official skill doc: https://minebean.com/skill.md
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
  holdBean: process.env.HOLD_BEAN === "true",            // true = tahan BEAN (roasting bonus)
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
let totalSpentWei = 0n;
let totalClaimedWei = 0n;
let totalBeanClaimed = 0n;
let sessionStart = Date.now();
let deployTimer = null;
let currentRoundId = null;
let sseInstance = null;
let lastGridData = null;   // cache grid dari SSE deployed events
let deploying = false;     // lock to prevent concurrent deploys

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

// Hitung sisa waktu dari endTime (unix seconds)
function getSecsLeft(endTime) {
  const end = Number(endTime);
  if (!end || isNaN(end)) return 0;
  return Math.max(0, Math.floor((end * 1000 - Date.now()) / 1000));
}

// ── EV Calculation (from skill doc) ──────────────────────────
// Net EV ≈ BEAN_value + Beanpot_EV − (ETH_deployed × effective_house_edge)
// BEAN_value = 1 BEAN × priceNative
// Beanpot_EV = (1/777) × beanpotPool × priceNative
// effective_house_edge ≈ 0.11 (1% admin + ~10% vault from losers)
async function calculateEV() {
  try {
    const [priceData, roundData] = await Promise.all([
      apiGet("/api/price"),
      apiGet("/api/round/current"),
    ]);
    const priceNative = parseFloat(priceData.bean.priceNative);
    const beanpotPool = parseFloat(roundData.beanpotPoolFormatted || "0");
    const ethDeployed = parseFloat(CFG.ethPerRound);

    const beanValue = 1.0 * priceNative;                          // 1 BEAN reward
    const beanpotEV = (1 / 777) * beanpotPool * priceNative;      // jackpot EV
    const houseCost = ethDeployed * 0.11;                          // ~11% effective edge
    const netEV = beanValue + beanpotEV - houseCost;

    return { netEV, beanValue, beanpotEV, houseCost, priceNative, beanpotPool };
  } catch (e) {
    log(`EV calc error: ${e.message}`);
    return null;
  }
}

// ── Block Selection ──────────────────────────────────────────
// Skill doc: "Deploy to less crowded blocks for bigger proportional share"
// All 25 blocks have equal 1/25 win probability (Chainlink VRF uniform)
function pickBlocks(blocks) {
  const n = CFG.blocksPerDeploy;

  if (!blocks || blocks.length === 0) {
    // Fallback random
    const all = Array.from({ length: 25 }, (_, i) => i);
    for (let i = 24; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, n).sort((a, b) => a - b);
  }

  if (CFG.strategy === "least_crowded") {
    // Prioritas: blok kosong (minerCount=0), lalu paling sedikit ETH
    return [...blocks]
      .sort((a, b) => {
        const aDeployed = parseFloat(a.deployedFormatted || "0");
        const bDeployed = parseFloat(b.deployedFormatted || "0");
        const aMiners = a.minerCount || 0;
        const bMiners = b.minerCount || 0;
        // Kosong dulu, lalu paling sedikit miners, lalu paling sedikit ETH
        if (aMiners === 0 && bMiners !== 0) return -1;
        if (bMiners === 0 && aMiners !== 0) return 1;
        if (aMiners !== bMiners) return aMiners - bMiners;
        return aDeployed - bDeployed;
      })
      .slice(0, n)
      .map(b => b.id)
      .sort((a, b) => a - b);
  }

  // Random strategy
  const all = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).sort((a, b) => a - b);
}

// ── Balance Check ────────────────────────────────────────────
async function checkBalance() {
  const balance = await provider.getBalance(wallet.address);
  const balEth = parseFloat(ethers.formatEther(balance));
  const needed = parseFloat(CFG.ethPerRound) + 0.0001; // + gas margin
  const minBal = parseFloat(CFG.minBalance);

  if (balEth < needed) {
    log(`⚠️ Saldo kurang: ${balEth.toFixed(6)} ETH < ${needed.toFixed(6)} ETH (deploy + gas)`);
    return false;
  }
  if (balEth < minBal) {
    log(`⚠️ Saldo di bawah minimum: ${balEth.toFixed(6)} ETH < ${minBal} ETH`);
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
    await tg(`⚠️ <b>Skip Round ${roundId}</b>\nSaldo ETH tidak cukup untuk deploy.`);
    return;
  }

  // Fetch grid — use cached SSE data if fresh, otherwise API
  let round;
  try {
    round = await apiGet(`/api/round/current?user=${wallet.address}`);
    lastGridData = round.blocks;
    log(`Grid OK: roundId=${round.roundId}, pool=${round.totalDeployedFormatted} ETH, sisa=${getSecsLeft(round.endTime)}s`);
  } catch (e) {
    log(`Gagal fetch grid: ${e.message} — pakai cache/random`);
    round = { blocks: lastGridData || [], totalDeployedFormatted: "?", beanpotPoolFormatted: "?" };
  }

  // Cek round tidak sudah berganti
  if (round.roundId && Number(round.roundId) !== Number(roundId)) {
    log(`Round ${roundId} sudah kedaluwarsa (now: ${round.roundId}), skip.`);
    return;
  }

  // Cek waktu masih ada
  const secsLeft = getSecsLeft(round.endTime);
  if (secsLeft < 3) {
    log(`Round ${roundId}: tinggal ${secsLeft}s, terlalu mepet, skip.`);
    return;
  }

  const blocks = pickBlocks(round.blocks);
  const ethValue = ethers.parseEther(CFG.ethPerRound);
  const perBlock = (parseFloat(CFG.ethPerRound) / CFG.blocksPerDeploy).toFixed(8);

  log(`Blok: [${blocks.join(", ")}] | ${CFG.ethPerRound} ETH | ${secsLeft}s sisa`);

  await tg(
    `🎯 <b>DEPLOY Round ${roundId}</b>\n\n` +
    `📍 Progress: <code>${roundsDone + 1}${CFG.totalRounds ? "/" + CFG.totalRounds : ""}</code>\n` +
    `Blocks: <code>[${blocks.join(", ")}]</code>\n` +
    `ETH: <code>${CFG.ethPerRound} ETH</code> (${perBlock}/blok)\n` +
    `Pool: <code>${round.totalDeployedFormatted} ETH</code> | Beanpot: <code>${round.beanpotPoolFormatted || "?"} BEAN</code>`
  );

  try {
    const tx = await gridContract.deploy(blocks, { value: ethValue });
    deployedThisRnd = true;
    totalSpentWei += ethValue;
    log(`TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`TX confirmed: block ${receipt.blockNumber}, gas: ${receipt.gasUsed.toString()}`);

    await tg(
      `✅ <b>Round ${roundId} deployed</b>\n\n` +
      `Blocks: <code>[${blocks.join(", ")}]</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>\n` +
      `Gas: <code>${receipt.gasUsed.toString()}</code>\n` +
      `⏳ Waiting for settlement...`
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

// ── Schedule deploy ──────────────────────────────────────────
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

// ── Claim ETH ────────────────────────────────────────────────
async function tryClaimETH(label) {
  try {
    // Use API for accurate pending rewards
    let pending;
    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      pending = parseFloat(rewards.pendingETHFormatted || "0");
    } catch {
      // Fallback to contract
      const [pendingWei] = await gridContract.getTotalPendingRewards(wallet.address);
      pending = parseFloat(ethers.formatEther(pendingWei));
    }

    log(`Pending ETH: ${pending.toFixed(6)} ETH`);
    if (pending < CFG.claimEthMin) { log(`Skip claim (< ${CFG.claimEthMin})`); return; }

    const tx = await gridContract.claimETH();
    const receipt = await tx.wait();
    const claimedWei = ethers.parseEther(pending.toString());
    totalClaimedWei += claimedWei;

    log(`ETH claimed: ${pending.toFixed(6)} ETH | TX: ${shortTx(tx.hash)}`);
    await tg(
      `💰 <b>ETH Claimed${label ? ` — ${label}` : ""}!</b>\n` +
      `Amount: <code>${pending.toFixed(6)} ETH</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (e) { log(`claimETH error: ${e.message}`); }
}

// ── Claim BEAN ───────────────────────────────────────────────
// Skill doc: 10% fee on mined (unroasted) BEAN only. Roasted bonus untaxed.
// Holding unclaimed BEAN earns passive roasting bonus from others' claims.
async function tryClaimBEAN(label) {
  if (CFG.holdBean) {
    log("HOLD_BEAN=true — skip claim BEAN (earning roasting bonus)");
    return;
  }

  try {
    let gross, fee, net;
    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      const bean = rewards.pendingBEAN;
      gross = parseFloat(bean.grossFormatted || "0");
      fee = parseFloat(bean.feeFormatted || "0");
      net = parseFloat(bean.netFormatted || "0");
    } catch {
      // Fallback to contract
      const result = await gridContract.getPendingBEAN(wallet.address);
      gross = parseFloat(ethers.formatEther(result.gross));
      fee = parseFloat(ethers.formatEther(result.fee));
      net = parseFloat(ethers.formatEther(result.net));
    }

    log(`Pending BEAN: gross=${gross.toFixed(4)}, fee=${fee.toFixed(4)}, net=${net.toFixed(4)}`);
    if (net < CFG.claimBeanMin) { log(`Skip BEAN claim (net ${net.toFixed(4)} < ${CFG.claimBeanMin})`); return; }

    const tx = await gridContract.claimBEAN();
    await tx.wait();
    totalBeanClaimed += ethers.parseEther(net.toString());

    log(`BEAN claimed: ${net.toFixed(4)} BEAN | TX: ${shortTx(tx.hash)}`);
    await tg(
      `🫘 <b>BEAN Claimed${label ? ` — ${label}` : ""}!</b>\n` +
      `Gross: <code>${gross.toFixed(4)} BEAN</code>\n` +
      `Fee (10% roasting): <code>${fee.toFixed(4)} BEAN</code>\n` +
      `Net: <code>${net.toFixed(4)} BEAN</code>\n` +
      `TX: <code>${shortTx(tx.hash)}</code>`
    );
  } catch (e) { log(`claimBEAN error: ${e.message}`); }
}

// ── Status Report ────────────────────────────────────────────
async function sendStatus() {
  try {
    const balance = await provider.getBalance(wallet.address);
    const spent = parseFloat(ethers.formatEther(totalSpentWei));
    const claimed = parseFloat(ethers.formatEther(totalClaimedWei));
    const pnl = claimed - spent;

    // BEAN info
    let beanLine = "";
    try {
      const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
      const bean = rewards.pendingBEAN;
      beanLine = `\n🫘 BEAN pending: <code>${bean.netFormatted || "0"} BEAN</code> (unroasted: ${bean.unroastedFormatted || "0"}, roasted: ${bean.roastedFormatted || "0"})`;
    } catch {
      try {
        const b = await gridContract.getPendingBEAN(wallet.address);
        beanLine = `\n🫘 BEAN pending: <code>${parseFloat(ethers.formatEther(b.net)).toFixed(4)} BEAN</code>`;
      } catch { }
    }

    // BEAN balance in wallet
    let beanBalLine = "";
    try {
      const beanBal = await beanContract.balanceOf(wallet.address);
      const beanBalFmt = parseFloat(ethers.formatEther(beanBal));
      if (beanBalFmt > 0) beanBalLine = `\n🫘 BEAN wallet: <code>${beanBalFmt.toFixed(4)} BEAN</code>`;
    } catch { }

    // EV
    let evLine = "";
    const ev = await calculateEV();
    if (ev) {
      evLine = `\n📊 EV/round: <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH</code> ${ev.netEV >= 0 ? "✅" : "⚠️"}`;
    }

    const roundsText = CFG.totalRounds ? `${roundsDone}/${CFG.totalRounds}` : `${roundsDone} (unlimited)`;

    await tg(
      `📊 <b>Status Report</b>\n\n` +
      `⏱ Durasi: <code>${elapsed()}</code>\n` +
      `🔄 Progress: <code>${roundsText} rounds</code>\n` +
      `💸 ETH dipakai: <code>${spent.toFixed(6)} ETH</code>\n` +
      `💰 ETH kembali: <code>${claimed.toFixed(6)} ETH</code>\n` +
      `📈 Net PnL: <code>${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)} ETH</code>` +
      beanLine + beanBalLine + evLine + `\n` +
      `👛 Saldo: <code>${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH</code>`
    );
  } catch (e) { log(`sendStatus error: ${e.message}`); }
}

// ── Round Transition Handler ─────────────────────────────────
async function onRoundTransition(data) {
  const { settled, newRound } = data;

  if (deployedThisRnd) { roundsDone++; log(`Round selesai. Total: ${roundsDone}${CFG.totalRounds ? "/" + CFG.totalRounds : ""}`); }
  deployedThisRnd = false;
  lastGridData = null; // Reset grid cache for new round

  if (settled) {
    const bpHit = settled.beanpotAmount && settled.beanpotAmount !== "0";
    log(`Settled ${settled.roundId} — winBlock: ${settled.winningBlock}${bpHit ? " 🎰 BEANPOT!" : ""}`);
    if (bpHit) {
      await tg(
        `🎰 <b>BEANPOT HIT! Round ${settled.roundId}</b>\n` +
        `Winning block: <code>${settled.winningBlock}</code>\n` +
        `Jackpot: <code>${ethers.formatEther(settled.beanpotAmount)} BEAN</code>`
      );
    }
  }

  // Check if we're done (only if totalRounds > 0)
  if (CFG.totalRounds > 0 && roundsDone >= CFG.totalRounds) {
    if (deployTimer) clearTimeout(deployTimer);
    await tryClaimETH("Final");
    await tryClaimBEAN("Final");
    await sendStatus();
    await tg(
      `🏁 <b>AUTO-MINER SELESAI! (${CFG.totalRounds} rounds)</b>\n\n` +
      `⏱ Total: <code>${elapsed()}</code>\n` +
      `🫘 BEAN ada di wallet, klaim/stake di <a href="https://minebean.com">minebean.com</a>`
    );
    process.exit(0);
  }

  // Periodic claim
  if (roundsDone > 0 && roundsDone % CFG.claimEvery === 0) {
    await tryClaimETH(`Round ${roundsDone}`);
    if (!CFG.holdBean) await tryClaimBEAN(`Round ${roundsDone}`);
    await sendStatus();
  }

  // Schedule next deploy
  if (newRound) {
    const rId = Number(newRound.roundId);
    currentRoundId = rId;
    log(`New round: ${rId} | endTime: ${newRound.endTime} | beanpot: ${newRound.beanpotPoolFormatted || "?"} BEAN`);
    scheduleDeployForRound(rId, newRound.endTime);
  }
}

// ── SSE (with reconnect + state recovery) ────────────────────
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

    es.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);

        if (type === "heartbeat") {
          log("SSE heartbeat ✓");
        }
        else if (type === "deployed") {
          // Update grid cache from real-time SSE data
          if (data && data.blocks) {
            lastGridData = data.blocks;
          }
        }
        else if (type === "roundTransition") {
          log("roundTransition diterima");
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

        // State recovery: fetch current round on reconnect
        try {
          const round = await apiGet(`/api/round/current?user=${wallet.address}`);
          const rId = Number(round.roundId);
          const secsLeft = getSecsLeft(round.endTime);
          currentRoundId = rId;
          lastGridData = round.blocks;
          log(`SSE recovery: round ${rId}, ${secsLeft}s left`);

          if (!deployedThisRnd && secsLeft > CFG.deploySecsLeft + 3) {
            scheduleDeployForRound(rId, round.endTime);
          }
        } catch (e) {
          log(`SSE recovery fetch fail: ${e.message}`);
        }

        connect();
      }, backoff);
    };
  }

  connect();
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log("=== MineBean Bot v4 ===");
  log(`Wallet  : ${wallet.address}`);
  log(`Rounds  : ${CFG.totalRounds || "unlimited (24/7)"} | Blok: ${CFG.blocksPerDeploy} | ETH: ${CFG.ethPerRound}`);
  log(`Strategi: ${CFG.strategy} | Deploy: ${CFG.deploySecsLeft}s sebelum habis`);
  log(`Claim   : ETH setiap ${CFG.claimEvery} rounds (min ${CFG.claimEthMin}) | BEAN: ${CFG.holdBean ? "HOLD (roasting)" : `claim min ${CFG.claimBeanMin}`}`);

  // Verify chain
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`Chain salah: ${net.chainId}, butuh Base Mainnet (8453)`);
  log("✅ Base Mainnet OK");

  // Balance check
  const balance = await provider.getBalance(wallet.address);
  const balEth = parseFloat(ethers.formatEther(balance));
  log(`Saldo   : ${balEth.toFixed(6)} ETH`);

  if (balEth < parseFloat(CFG.minBalance)) {
    log(`⚠️ Saldo rendah: ${balEth.toFixed(6)} ETH < minimum ${CFG.minBalance} ETH — tetap jalan, skip round jika kurang`);
  }

  // BEAN balance
  try {
    const beanBal = await beanContract.balanceOf(wallet.address);
    log(`BEAN    : ${parseFloat(ethers.formatEther(beanBal)).toFixed(4)} BEAN`);
  } catch { }

  // EV calculation
  const ev = await calculateEV();
  let evLine = "";
  if (ev) {
    evLine = `\n\n📊 <b>EV/round:</b> <code>${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH</code> ${ev.netEV >= 0 ? "✅" : "⚠️"}` +
      `\n   BEAN: ${ev.beanValue.toFixed(8)} | Beanpot: ${ev.beanpotEV.toFixed(8)} | Cost: ${ev.houseCost.toFixed(8)}`;
    log(`EV: ${ev.netEV >= 0 ? "+" : ""}${ev.netEV.toFixed(8)} ETH (BEAN: ${ev.beanValue.toFixed(8)}, BP: ${ev.beanpotEV.toFixed(8)}, cost: ${ev.houseCost.toFixed(8)})`);
  }

  // Pending rewards check
  try {
    const rewards = await apiGet(`/api/user/${wallet.address}/rewards`);
    log(`Pending : ETH=${rewards.pendingETHFormatted || "0"}, BEAN net=${rewards.pendingBEAN?.netFormatted || "0"}`);
  } catch { }

  const roundsText = CFG.totalRounds ? `${CFG.totalRounds} rounds` : "unlimited (24/7)";

  await tg(
    `🤖 <b>AUTO-MINER v4 STARTED! (${roundsText})</b>\n\n` +
    `Session: <code>${wallet.address.slice(0, 10)}...</code> | PID: <code>${process.pid}</code>\n\n` +
    `⚙️ Config:\n` +
    `• ${CFG.blocksPerDeploy} blocks per deploy (${CFG.strategy})\n` +
    `• Modal: <code>${CFG.ethPerRound} ETH/round</code>\n` +
    `• Deploy: ${CFG.deploySecsLeft}s sebelum round habis\n` +
    `• Claim ETH: setiap ${CFG.claimEvery} rounds\n` +
    `• BEAN: ${CFG.holdBean ? "HOLD (roasting bonus)" : `claim setiap ${CFG.claimEvery} rounds`}\n` +
    `• Duration: ${roundsText}` +
    evLine
  );

  // Fetch current round and schedule deploy
  try {
    const round = await apiGet(`/api/round/current?user=${wallet.address}`);
    const rId = Number(round.roundId);
    const secsLeft = getSecsLeft(round.endTime);
    currentRoundId = rId;
    lastGridData = round.blocks;

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

  // Connect SSE for real-time updates
  connectSSE();

  // Periodic status report (every 30 minutes)
  setInterval(() => {
    sendStatus().catch(e => log(`periodic status err: ${e.message}`));
  }, 30 * 60 * 1000);

  log("Bot berjalan ✓ (24/7 mode)");
}

// ── Graceful shutdown ────────────────────────────────────────
process.on("SIGINT", async () => {
  log("SIGINT received, shutting down...");
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  await tryClaimETH("Shutdown");
  await sendStatus();
  await tg(
    `🛑 <b>Bot Dihentikan</b>\n` +
    `${roundsDone}${CFG.totalRounds ? "/" + CFG.totalRounds : ""} rounds completed.\n` +
    `⏱ Duration: <code>${elapsed()}</code>\n` +
    `🫘 BEAN ada di wallet, klaim di minebean.com`
  );
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("SIGTERM received, shutting down...");
  if (deployTimer) clearTimeout(deployTimer);
  if (sseInstance) sseInstance.close();
  await tryClaimETH("SIGTERM");
  await tg(`🛑 <b>Bot SIGTERM</b> — ${roundsDone} rounds done. Claimed ETH.`);
  process.exit(0);
});

process.on("unhandledRejection", (r) => log(`[unhandledRejection] ${r}`));

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await tg(`💥 <b>Bot Crash!</b>\n<code>${e.message.slice(0, 300)}</code>`);
  process.exit(1);
});
