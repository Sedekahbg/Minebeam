// src/strategy.js
import { CONFIG } from "./config.js";

/**
 * Pick N blocks to deploy to based on strategy.
 *
 * @param {Array} blocks  - Array of 25 block objects from /api/round/current
 * @param {number} n      - How many blocks to pick
 * @returns {number[]}    - Array of block IDs (0-24)
 */
export function pickBlocks(blocks, n) {
  if (CONFIG.blockStrategy === "least_crowded") {
    return pickLeastCrowded(blocks, n);
  }
  return pickRandom(n);
}

/**
 * Pick N least crowded blocks (by ETH deployed).
 * Tiebreak by block ID (prefer lower IDs).
 */
function pickLeastCrowded(blocks, n) {
  const sorted = [...blocks].sort((a, b) => {
    const diff = parseFloat(a.deployedFormatted) - parseFloat(b.deployedFormatted);
    return diff !== 0 ? diff : a.id - b.id;
  });
  return sorted.slice(0, n).map((b) => b.id).sort((a, b) => a - b);
}

/**
 * Pick N random blocks from 0–24 (no repeat).
 */
function pickRandom(n) {
  const all = Array.from({ length: 25 }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).sort((a, b) => a - b);
}
