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

// Staff ranked by empties logged. stats: [{ name, empties, tokens, faults }] for people who logged in the period.
// rosterNames: active staff names, so people with no empties can still show as worst.
// top: up to 3 people with at least one empty, most first. worst: up to 3 of the rest, fewest first.
export function staffTopWorst(stats, rosterNames) {
  const byName = new Map(stats.map(r => [r.name, r]));
  const names = new Set([...rosterNames, ...stats.map(r => r.name)]);
  const rows = [...names].map(name => byName.get(name) || { name, empties: 0, tokens: 0, faults: 0 });
  rows.sort((a, b) => b.empties - a.empties || b.tokens - a.tokens || a.name.localeCompare(b.name));
  const top = rows.filter(r => r.empties > 0).slice(0, 3);
  const rest = rows.filter(r => !top.includes(r));
  const worst = rest.slice(-3).sort((a, b) => a.empties - b.empties || a.tokens - b.tokens || a.name.localeCompare(b.name));
  return { top, worst };
}
