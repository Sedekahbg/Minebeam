// src/ev.js
// House edge: 1% admin + ~10% vault from losers ≈ blended ~11%
const HOUSE_EDGE = 0.11;

export function calcEV({ ethPerRound, priceNative, beanpotPoolFormatted }) {
  const ethCost    = parseFloat(ethPerRound) * HOUSE_EDGE;
  const beanValue  = 1.0 * priceNative;
  const beanpotEV  = (1 / 777) * parseFloat(beanpotPoolFormatted || "0") * priceNative;
  const netEV      = beanValue + beanpotEV - ethCost;

  return { ethCost, beanValue, beanpotEV, netEV };
}
