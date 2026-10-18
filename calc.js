// Pure helpers for the machine pages. No Firebase or DOM in here, so they can be tested.
const DAY_MS = 86400000;

// Tokens from empties in the last `days` days (rolling). days = null means all time.
// empties: [{ tokens, at: Date }]
export function tokensInWindow(empties, days, now) {
  const from = days == null ? -Infinity : now.getTime() - days * DAY_MS;
  let total = 0;
  for (const e of empties) {
    if (e.at.getTime() >= from) total += Number(e.tokens) || 0;
  }
  return total;
}

// What one repair cost: parts plus labour, both optional.
export function repairCost(f) {
  return (Number(f.partsCost) || 0) + (Number(f.labourCost) || 0);
}

// Payback. Earned = all-time tokens x value of one token. Repair costs come off the top.
export function machinePayback({ tokensAllTime, repairs, price, tokenValue }) {
  const repairsTotal = repairs.reduce((s, f) => s + repairCost(f), 0);
  if (tokenValue == null) {
    return { reason: "token-value", repairsTotal, earned: null, net: null, pct: null, left: null, paidBack: false, ahead: 0 };
  }
  const earned = tokensAllTime * tokenValue;
  const net = earned - repairsTotal;
  if (price == null || !(price > 0)) {
    return { reason: "price", repairsTotal, earned, net, pct: null, left: null, paidBack: false, ahead: 0 };
  }
  const paidBack = net >= price;
  return {
    reason: null,
    repairsTotal,
    earned,
    net,
    pct: (net / price) * 100,
    left: paidBack ? 0 : price - net,
    paidBack,
    ahead: paidBack ? net - price : 0
  };
}

// Estimated payback date, at the takings of the last 30 days.
export function estimatePayback({ left, tokens30, tokenValue, now }) {
  if (left <= 0) return { date: null, perDay: null };
  const perDay = (tokens30 * tokenValue) / 30;
  if (!(perDay > 0)) return { date: null, perDay: 0 };
  return { date: new Date(now.getTime() + (left / perDay) * DAY_MS), perDay };
}
