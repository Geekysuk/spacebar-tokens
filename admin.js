import {
  collection, doc, onSnapshot, query, orderBy, setDoc, updateDoc, deleteDoc, addDoc, getDoc,
  serverTimestamp, Timestamp, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth, sha256, el, setMsg, esc } from "./fb.js";
import { STAFF_URL } from "./config.js";
import { tokensInWindow, repairCost, machinePayback, estimatePayback } from "./calc.js";

/* ---------- state ---------- */
const S = { machines: [], staff: [], empties: [], faults: [], weeks: {}, details: {}, settings: {}, costs: {}, period: "week", ready: 0, _machineTag: null, role: null, managerLogin: false };
let unsubs = [];
let view = "overview";
// Views only Rob can open. Managers get a note instead.
const ADMIN_ONLY = ["staff", "sticker", "settings"];

/* ---------- helpers ---------- */
const DAY = 86400000;
const tsDate = (t) => (t && typeof t.toDate === "function") ? t.toDate() : (t ? new Date(t) : new Date());
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
const fmtDayYear = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
const fmtShortRaw = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
const fmtShort = { format: (d) => fmtShortRaw.format(d).replace(/Sept/, "Sep") };
const n = (x) => Number(x || 0).toLocaleString("en-GB");
const dayKey = (d) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p; // YYYY-MM-DD in London time
};
function londonMidnight(d) { // Date at 00:00 London time of the day containing d
  const [y, m, dd] = dayKey(d).split("-").map(Number);
  // find the UTC instant that is 00:00 in London for that date
  let guess = new Date(Date.UTC(y, m - 1, dd, 0, 0, 0));
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess);
    const h = Number(parts.find(p => p.type === "hour").value), mi = Number(parts.find(p => p.type === "minute").value);
    if (h === 0 && mi === 0) break;
    guess = new Date(guess.getTime() - (h * 60 + mi) * 60000);
  }
  return guess;
}
function weekStart(d) { // Monday 00:00 London
  const mid = londonMidnight(d);
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(mid);
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
  return londonMidnight(new Date(mid.getTime() - dow * DAY + 3600000 * 6));
}
function monthStart(d) {
  const [y, m] = dayKey(d).split("-").map(Number);
  return londonMidnight(new Date(Date.UTC(y, m - 1, 1, 12)));
}
const weekKey = (d) => dayKey(weekStart(d));
function weekLabel(a, b) {
  const sa = fmtShort.format(a), sb = fmtShort.format(b);
  const ma = sa.split(" ")[1], mb = sb.split(" ")[1];
  return ma === mb ? `${sa.split(" ")[0]}–${sb}` : `${sa} – ${sb}`;
}
const machineByTag = (tag) => S.machines.find(m => m.tag === tag);

function periodRange() {
  const now = new Date();
  if (S.period === "week") return { from: weekStart(now), to: now, label: "This week" };
  if (S.period === "7d") return { from: new Date(now.getTime() - 7 * DAY), to: now, label: "Last 7 days" };
  if (S.period === "month") return { from: monthStart(now), to: now, label: "This month" };
  if (S.period === "30d") return { from: new Date(now.getTime() - 30 * DAY), to: now, label: "Last 30 days" };
  const first = S.empties.length ? tsDate(S.empties[S.empties.length - 1].at) : now;
  return { from: first, to: now, label: "All time" };
}

/* ---------- auth ---------- */
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => endSession(), 30 * 60 * 1000);
}
["click", "keydown", "touchstart", "scroll"].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));

el("btn-login").addEventListener("click", async () => {
  setMsg("login-msg", "");
  const btn = el("btn-login"); btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, el("email").value.trim(), el("password").value);
  } catch (e) {
    setMsg("login-msg", "Sign-in failed — check the email and password.", "error");
  } finally { btn.disabled = false; }
});
el("password").addEventListener("keydown", e => { if (e.key === "Enter") el("btn-login").click(); });
// Signing out. A manager's session record goes too, so the code can't be reused from it.
async function endSession() {
  const u = auth.currentUser;
  if (u && u.isAnonymous) { try { await deleteDoc(doc(db, "sessions", u.uid)); } catch (e) { /* already gone */ } }
  return signOut(auth);
}
el("btn-signout").addEventListener("click", endSession);

onAuthStateChanged(auth, async (user) => {
  el("boot").classList.add("hidden");
  if (!user) {
    S.role = null;
    unsubs.forEach(u => u()); unsubs = [];
    el("app").classList.add("hidden");
    el("login").classList.remove("hidden");
    return;
  }
  if (S.managerLogin) return; // the manager sign-in button finishes this
  if (user.isAnonymous) {
    // A returning manager needs a live session (8 hours), or they're signed out.
    const s = await getDoc(doc(db, "sessions", user.uid)).catch(() => null);
    const fresh = !!s && s.exists() && Date.now() - tsDate(s.data().at).getTime() < 8 * 3600 * 1000;
    if (!fresh) return endSession();
  }
  enter(user);
});

// Manager sign-in: the 4-digit code must belong to an active manager.
el("mgr-btn").addEventListener("click", async () => {
  setMsg("mgr-msg", "");
  const code = el("mgr-code").value.trim();
  if (!/^\d{4}$/.test(code)) return setMsg("mgr-msg", "Enter your 4-digit code.", "error");
  const btn = el("mgr-btn"); btn.disabled = true;
  S.managerLogin = true;
  try {
    const hash = await sha256(code);
    const sc = await getDoc(doc(db, "staffCodes", hash));
    if (!sc.exists() || sc.data().active === false || sc.data().role !== "manager") throw Object.assign(new Error("not a manager"), { code: "not-manager" });
    const cred = await signInAnonymously(auth);
    await setDoc(doc(db, "sessions", cred.user.uid), { staffHash: hash, role: "manager", at: serverTimestamp() });
    S.managerLogin = false;
    el("mgr-code").value = "";
    enter(cred.user);
  } catch (e) {
    S.managerLogin = false;
    if (auth.currentUser && auth.currentUser.isAnonymous) { try { await signOut(auth); } catch (x) { /* ignore */ } }
    setMsg("mgr-msg", e.code === "auth/operation-not-allowed"
      ? "Manager sign-in isn't switched on in Firebase yet (Authentication → Sign-in method → Anonymous)."
      : e.code === "not-manager" ? "That code isn't a manager code." : "Couldn't sign in. Try again.", "error");
  } finally { btn.disabled = false; }
});
el("mgr-code").addEventListener("keydown", e => { if (e.key === "Enter") el("mgr-btn").click(); });

function enter(user) {
  S.role = user.isAnonymous ? "manager" : "admin";
  el("login").classList.add("hidden");
  el("app").classList.remove("hidden");
  el("app-tag").textContent = S.role === "manager" ? "manager view" : "tokens";
  document.querySelectorAll("[data-admin]").forEach(a => a.classList.toggle("hidden", S.role !== "admin"));
  resetIdle();
  unsubs.forEach(u => u()); unsubs = [];
  subscribe();
  route();
}

/* ---------- data ---------- */
function subscribe() {
  const opts = { includeMetadataChanges: false };
  const sub = (q, key, mapFn) => onSnapshot(q, (snap) => {
    S[key] = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    if (mapFn) mapFn();
    S.ready++;
    render();
  }, (err) => { console.error(key, err); toast(`Couldn't load ${key}: ${err.code || err.message}`); });

  unsubs.push(sub(query(collection(db, "machines"), orderBy("name")), "machines"));
  unsubs.push(sub(query(collection(db, "empties"), orderBy("at", "desc")), "empties"));
  unsubs.push(sub(query(collection(db, "faults"), orderBy("at", "desc")), "faults", S.role === "admin" ? migrateLegacyCosts : null));
  unsubs.push(onSnapshot(collection(db, "weeks"), (snap) => {
    S.weeks = {};
    snap.docs.forEach(d => { S.weeks[d.id] = d.data(); });
    render();
  }));
  if (S.role !== "admin") return; // managers stop here: no staff codes, money or settings
  unsubs.push(sub(query(collection(db, "staffCodes"), orderBy("name")), "staff"));
  unsubs.push(onSnapshot(collection(db, "faultCosts"), (snap) => {
    S.costs = {};
    snap.docs.forEach(d => { S.costs[d.id] = d.data(); });
    render();
  }, (err) => toast(`Couldn't load repair costs: ${err.code || err.message}`)));
  unsubs.push(onSnapshot(collection(db, "machineDetails"), (snap) => {
    S.details = {};
    snap.docs.forEach(d => { S.details[d.id] = d.data(); });
    render();
  }, (err) => toast(`Couldn't load machine details: ${err.code || err.message}`)));
  unsubs.push(onSnapshot(doc(db, "settings", "app"), (snap) => {
    S.settings = snap.exists() ? snap.data() : {};
    render();
  }, (err) => toast(`Couldn't load settings: ${err.code || err.message}`)));
}

// Repair costs used to sit on the fault itself. Move them to faultCosts (Rob only) once,
// so managers can read the repair history without the money. Runs for Rob's session only.
let migrating = false;
async function migrateLegacyCosts() {
  if (migrating || S.role !== "admin") return;
  const legacy = S.faults.filter(f => f.partsCost !== undefined || f.labourCost !== undefined);
  if (!legacy.length) return;
  migrating = true;
  try {
    const batch = writeBatch(db);
    for (const f of legacy) {
      batch.set(doc(db, "faultCosts", f.id), { partsCost: Number(f.partsCost) || 0, labourCost: Number(f.labourCost) || 0, updatedAt: serverTimestamp() }, { merge: true });
      batch.update(doc(db, "faults", f.id), { partsCost: deleteField(), labourCost: deleteField() });
    }
    await batch.commit();
  } catch (e) { toast("Couldn't move old repair costs: " + (e.code || e.message)); }
  finally { migrating = false; }
}

function toast(text) {
  let t = el("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "msg info"; t.style.cssText = "position:fixed;left:12px;right:12px;bottom:16px;z-index:20"; document.body.appendChild(t); }
  t.textContent = text; t.classList.remove("hidden");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 3500);
}

/* ---------- routing ---------- */
window.addEventListener("hashchange", route);
function route() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/([^/?#]+))?/);
  view = m ? m[1] : "overview";
  S._machineTag = m && m[2] ? decodeURIComponent(m[2]) : null;
  const navView = view === "machine" ? "machines" : view;
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.view === navView));
  render();
}

function render() {
  if (!auth.currentUser || !S.role) return;
  const open = S.faults.filter(f => f.status !== "closed").length;
  el("nav-faults").textContent = open ? `(${open})` : "";
  const v = el("view");
  if (S.role === "manager" && ADMIN_ONLY.includes(view)) { v.innerHTML = `<p class="muted">Only Rob can open this page.</p>`; return; }
  const fn = { overview, empties, faults, weekly, machines, machine: machineDetail, staff, sticker, settings: settingsView }[view] || overview;
  v.innerHTML = fn();
  wire(v);
}

/* ---------- views ---------- */
// Who logged the most empties and reported the most faults in a period.
function staffStats(from, to) {
  const rows = {};
  const row = (name) => (rows[name || "—"] ||= { name: name || "—", empties: 0, tokens: 0, faults: 0 });
  S.empties.forEach(e => { const t = tsDate(e.at); if (t >= from && t <= to) { const r = row(e.staffName); r.empties++; r.tokens += e.tokens || 0; } });
  S.faults.forEach(f => { const t = tsDate(f.at); if (t >= from && t <= to) row(f.staffName).faults++; });
  return Object.values(rows).sort((a, b) => b.empties - a.empties || b.faults - a.faults || a.name.localeCompare(b.name));
}

function overview() {
  const { from, to, label } = periodRange();
  const staffRows = staffStats(from, to);
  const days = Math.max(1, (to - from) / DAY);
  const inRange = S.empties.filter(e => { const d = tsDate(e.at); return d >= from && d <= to; });
  const totals = {};
  inRange.forEach(e => { const t = totals[e.tag] ||= { tokens: 0, count: 0 }; t.tokens += e.tokens || 0; t.count++; });
  const rows = S.machines.map(m => ({ ...m, ...(totals[m.tag] || { tokens: 0, count: 0 }) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const active = rows.filter(r => r.active !== false);
  const grand = rows.reduce((s, r) => s + r.tokens, 0);
  const max = Math.max(1, ...rows.map(r => r.tokens));
  const best = active[0], worst = active.length > 1 ? active[active.length - 1] : null;
  const todayKey = dayKey(new Date());
  const today = S.empties.filter(e => dayKey(tsDate(e.at)) === todayKey).reduce((s, e) => s + (e.tokens || 0), 0);

  const seg = ["week:This week", "7d:Last 7 days", "month:This month", "30d:Last 30 days", "all:All time"]
    .map(s => { const [k, t] = s.split(":"); return `<button data-period="${k}" class="${S.period === k ? "active" : ""}">${t}</button>`; }).join("");

  return `
    <div class="seg">${seg}</div>
    <div class="tiles">
      <div class="tile"><div class="k">${esc(label)}</div><div class="v">${n(grand)}</div><div class="k">tokens · ${inRange.length} empties · ${n(Math.round(grand / days))}/day</div></div>
      <div class="tile"><div class="k">Today</div><div class="v">${n(today)}</div><div class="k">tokens so far</div></div>
      <div class="tile best"><div class="k">Best</div><div class="v small">${best && best.tokens ? esc(best.name) : "—"}</div><div class="k">${best && best.tokens ? n(best.tokens) + " tokens" : "nothing logged yet"}</div></div>
      <div class="tile worst"><div class="k">Worst</div><div class="v small">${worst ? esc(worst.name) : "—"}</div><div class="k">${worst ? n(worst.tokens) + " tokens" : ""}</div></div>
    </div>
    <section class="panel">
      <h2>Ranking · ${esc(label)}</h2>
      ${rows.length ? rows.map((r, i) => `
        <div class="rank ${r.active === false ? "worst" : ""}">
          <div class="name">${i + 1}. ${esc(r.name)} <span class="dim small">${esc(r.tag)}${r.active === false ? " · off" : ""}</span></div>
          <div class="stat"><b>${n(r.tokens)}</b> <span class="dim small">tokens</span></div>
          <div class="bar"><i style="--w:${(100 * r.tokens / max).toFixed(1)}%"></i></div>
          <div class="meta">${r.count} ${r.count === 1 ? "empty" : "empties"} · ${(r.tokens / days).toFixed(1)}/day · ${grand ? (100 * r.tokens / grand).toFixed(0) : 0}% of all tokens</div>
        </div>`).join("") : `<p class="muted">No machines yet — add them under Machines.</p>`}
    </section>
    <section class="panel">
      <h2>Staff · ${esc(label)}</h2>
      ${staffRows.length ? `<div class="tbl-wrap"><table>
        <thead><tr><th>Name</th><th class="num">Empties</th><th class="num">Tokens</th><th class="num">Faults reported</th></tr></thead>
        <tbody>${staffRows.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${n(s.empties)}</td><td class="num">${n(s.tokens)}</td><td class="num">${n(s.faults)}</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted">Nothing logged in this period.</p>`}
    </section>`;
}

function empties() {
  const fm = S._fMachine || "", fs = S._fStaff || "";
  let list = S.empties;
  if (fm) list = list.filter(e => e.tag === fm);
  if (fs) list = list.filter(e => e.staffName === fs);
  const staffNames = [...new Set(S.empties.map(e => e.staffName))].sort();
  const groups = {};
  list.forEach(e => { const k = dayKey(tsDate(e.at)); (groups[k] ||= []).push(e); });
  const nowLocal = new Date();
  const dtDefault = `${dayKey(nowLocal)}T${fmtTime.format(nowLocal)}`;

  return `
    ${S.role === "admin" ? `<section class="panel">
      <h2>Add an empty (Rob)</h2>
      <div class="row">
        <div><label>Machine</label><select id="ae-machine">${S.machines.filter(m => m.active !== false).map(m => `<option value="${esc(m.tag)}">${esc(m.name)}</option>`).join("")}</select></div>
        <div><label>Tokens</label><input id="ae-tokens" type="number" inputmode="numeric" min="0" max="100000"></div>
      </div>
      <label>When</label><input id="ae-when" type="datetime-local" value="${dtDefault}">
      <label>Note (optional)</label><input id="ae-note" type="text" maxlength="300">
      <div id="ae-msg"></div>
      <button id="ae-save" class="btn primary mt">Add empty</button>
    </section>` : ""}
    <section class="panel">
      <h2>All empties</h2>
      <div class="filters">
        <select id="f-machine"><option value="">All machines</option>${S.machines.map(m => `<option value="${esc(m.tag)}" ${fm === m.tag ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
        <select id="f-staff"><option value="">All staff</option>${staffNames.map(s => `<option ${fs === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      </div>
      <p class="dim small">${list.length} empties · ${n(list.reduce((s, e) => s + (e.tokens || 0), 0))} tokens</p>
      ${Object.keys(groups).sort().reverse().map(k => `
        <div class="day-head">${fmtDay.format(tsDate(groups[k][0].at))} · ${n(groups[k].reduce((s, e) => s + (e.tokens || 0), 0))} tokens</div>
        ${groups[k].map(e => `
          <div class="list-item">
            <div class="main">
              <div><b>${esc(e.machineName)}</b> <span class="dim small">${esc(e.tag)}</span> ${e.check === "bad" ? '<span class="pill bad">fault</span>' : e.check === "stillbroken" ? '<span class="pill bad">still broken</span>' : e.check === "skipped" ? '<span class="pill open">not tested</span>' : ""}</div>
              <div class="t">${fmtTime.format(tsDate(e.at))} · ${esc(e.staffName)}</div>
              ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}
            </div>
            <div class="n">${n(e.tokens)}</div>
            ${S.role === "admin" ? `<button class="btn auto quiet" data-del-empty="${e.id}" title="Delete">✕</button>` : ""}
          </div>`).join("")}`).join("") || `<p class="muted">Nothing logged yet.</p>`}
    </section>`;
}

function faults() {
  const open = S.faults.filter(f => f.status === "open");
  const prog = S.faults.filter(f => f.status === "inprogress");
  const closed = S.faults.filter(f => f.status === "closed").slice(0, 50);
  const pill = (f) => f.status === "inprogress"
    ? `<span class="pill" style="background:rgba(46,127,194,0.18);color:#8ed1fc">in progress</span>`
    : `<span class="pill ${f.status === "open" ? "open" : "closed"}">${f.status}</span>`;
  const buttons = (f) => S.role !== "admin" ? "" : f.status === "open"
    ? `<button class="btn auto" data-prog-fault="${f.id}">In progress</button><button class="btn auto" data-close-fault="${f.id}">Fixed</button>`
    : f.status === "inprogress"
      ? `<button class="btn auto" data-close-fault="${f.id}">Fixed</button><button class="btn auto quiet" data-open-fault="${f.id}">Back to open</button>`
      : `<button class="btn auto quiet" data-reopen-fault="${f.id}">Reopen</button>`;
  const item = (f) => `
    <div class="list-item">
      <div class="main">
        <div><b>${esc(f.machineName)}</b> <span class="dim small">${esc(f.tag)}</span> ${pill(f)}</div>
        <div class="t">${fmtDay.format(tsDate(f.at))} ${fmtTime.format(tsDate(f.at))} · reported by ${esc(f.staffName)}${f.status === "inprogress" && f.inProgressBy ? ` · in progress (${esc(f.inProgressBy)})` : ""}${f.closedAt ? ` · closed ${fmtShort.format(tsDate(f.closedAt))}${f.closedBy ? ` by ${esc(f.closedBy)}` : ""}` : ""}</div>
        <div class="note">${esc(f.note)}</div>
        ${f.status === "closed" ? (f.closeNote ? `<div class="note" style="color:var(--blue-soft)">${esc(f.closeNote)}</div>` : "") : (f.techNote ? `<div class="note" style="color:var(--blue-soft)">${esc(f.inProgressBy || "Technician")}: ${esc(f.techNote)}</div>` : "")}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${buttons(f)}</div>
    </div>`;
  return `
    <section class="panel"><h2>Open (${open.length})</h2>${open.map(item).join("") || `<p class="muted">Nothing waiting. Staff report faults on the token page when they tick "Something's wrong".</p>`}</section>
    <section class="panel"><h2>In progress (${prog.length})</h2>${prog.map(item).join("") || `<p class="muted">Nothing in progress. The technician (or you) can mark a job in progress once it's been looked at.</p>`}</section>
    <section class="panel"><h2>Fixed</h2>${closed.map(item).join("") || `<p class="muted">None yet.</p>`}</section>`;
}

function weekly() {
  const ro = S.role === "admin" ? "" : " disabled"; // managers read the weekly check, not edit it
  const now = new Date();
  const thisMon = weekStart(now);
  let firstMon = S.empties.length ? weekStart(tsDate(S.empties[S.empties.length - 1].at)) : thisMon;
  const savedKeys = Object.keys(S.weeks).sort();
  if (savedKeys.length) { const d = londonMidnight(new Date(savedKeys[0] + "T12:00:00Z")); if (d < firstMon) firstMon = d; }
  const weeks = [];
  for (let d = thisMon; d >= firstMon; d = weekStart(new Date(d.getTime() - DAY))) {
    const k = dayKey(d);
    const end = new Date(weekStart(new Date(d.getTime() + 8 * DAY)).getTime() - 1);
    const collected = S.empties.filter(e => { const t = tsDate(e.at); return t >= d && t <= end; }).reduce((s, e) => s + (e.tokens || 0), 0);
    const sold = S.weeks[k]?.tokensSold ?? null;
    const startCount = S.weeks[k]?.startCount ?? null;
    const topUp = S.weeks[k]?.topUp ?? null;
    const nextStart = S.weeks[dayKey(weekStart(new Date(d.getTime() + 8 * DAY)))]?.startCount ?? null;
    weeks.push({ k, start: d, end, collected, sold, startCount, topUp, nextStart });
    if (weeks.length > 104) break;
  }
  return `
    <section class="panel">
      <h2>Weekly check — sold vs collected</h2>
      <p class="muted small">Weeks run Monday to Sunday. Enter the tokens on the bar stock on Monday as the start count, then each week the tokens you topped up from the reserve and the tokens sold (type 0 if none). Collected comes from staff empties. Missing = start + collected + topped up − sold − next Monday's start count. Green = balanced, red = tokens unaccounted for. This week shows once next Monday's start count is in.</p>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Week</th><th class="num">Start count</th><th class="num">Topped up</th><th class="num">Sold</th><th class="num">Collected</th><th class="num">Missing</th></tr></thead>
        <tbody>${weeks.map(w => {
          const missing = (w.startCount === null || w.topUp === null || w.sold === null || w.nextStart === null)
            ? null : (w.startCount + w.collected + w.topUp - w.sold) - w.nextStart;
          return `<tr>
            <td class="wk">${weekLabel(w.start, w.end)}<span class="sub">${w.k === dayKey(thisMon) ? "this week" : ""}</span></td>
            <td class="num"><input type="number" inputmode="numeric" min="0" style="width:76px;padding:6px 8px;text-align:right" data-start="${w.k}" value="${w.startCount ?? ""}" placeholder="—"${ro}></td>
            <td class="num"><input type="number" inputmode="numeric" min="0" style="width:76px;padding:6px 8px;text-align:right" data-topup="${w.k}" value="${w.topUp ?? ""}" placeholder="—"${ro}></td>
            <td class="num"><input type="number" inputmode="numeric" min="0" style="width:76px;padding:6px 8px;text-align:right" data-week="${w.k}" value="${w.sold ?? ""}" placeholder="—"${ro}></td>
            <td class="num">${n(w.collected)}</td>
            <td class="num ${missing === null ? "dim" : missing === 0 ? "diff-pos" : "diff-neg"}">${missing === null ? "—" : (missing > 0 ? "+" : "") + n(missing)}</td>
          </tr>`; }).join("")}</tbody>
      </table></div>
      ${S.role === "admin" ? `<p class="dim small" style="margin-top:10px">Saves when you leave the box.</p>` : ""}
    </section>`;
}

function machines() {
  const admin = S.role === "admin";
  const used = new Set(S.machines.map(m => m.tag));
  let next = 1001; while (used.has(String(next))) next++;
  return `
    ${admin ? `<section class="panel">
      <h2>Add a machine</h2>
      <div class="row">
        <div><label>Name</label><input id="am-name" type="text" maxlength="60" placeholder="e.g. Mario Kart"></div>
        <div><label>4-digit code</label><input id="am-tag" type="tel" inputmode="numeric" maxlength="4" value="${next}"></div>
      </div>
      <div id="am-msg"></div>
      <button id="am-save" class="btn primary mt">Add machine</button>
      <label for="am-bulk" style="margin-top:18px">Or add several — one name per line (codes assigned from the next free number)</label>
      <textarea id="am-bulk" placeholder="Mario Kart&#10;Pac Man&#10;Galaga"></textarea>
      <div id="am-bulk-msg"></div>
      <button id="am-bulk-save" class="btn mt">Add all</button>
    </section>` : ""}
    <section class="panel">
      <h2>Machines (${S.machines.length})</h2>
      <div class="mgrid">${S.machines.map(m => machineTile(m)).join("") || `<p class="muted">No machines yet.</p>`}</div>
      <p class="dim small" style="margin-top:10px">${admin ? "Tap a machine for its photo, tokens, payback and repairs. Turn a machine off if it leaves the floor — its history stays. The code is fixed once created (it's on the sticker)." : "Tap a machine for its tokens and repairs."}</p>
    </section>`;
}

// Access levels for a staff code. Repair is Michael's technician page; it uses its own tech code.
const ROLES = [["general", "General"], ["repair", "Repair"], ["manager", "Manager"]];
const roleOptions = (cur) => ROLES.map(([v, t]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${t}</option>`).join("");

function staff() {
  const counts = {};
  S.empties.forEach(e => { counts[e.staffHash] = (counts[e.staffHash] || 0) + 1; });
  return `
    <section class="panel">
      <h2>Add a staff code</h2>
      <div class="row">
        <div><label>Name</label><input id="as-name" type="text" maxlength="40"></div>
        <div><label>4-digit code</label><input id="as-code" type="tel" inputmode="numeric" maxlength="4"></div>
        <div><label>Access</label><select id="as-role">${roleOptions("general")}</select></div>
      </div>
      <div id="as-msg"></div>
      <button id="as-save" class="btn primary mt">Add code</button>
      <p class="dim small" style="margin-top:10px">General: logs empties and reports faults on the staff page. Repair: the technician page (their own tech code). Manager: the manager view (performance, not money or settings). Codes are stored hashed, so write each one down when you give it out. One code per person so empties are attributable.</p>
    </section>
    <section class="panel">
      <h2>Staff (${S.staff.length})</h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Name</th><th class="num">Empties logged</th><th>Access</th><th></th></tr></thead>
        <tbody>${S.staff.map(s => `
          <tr class="${s.active === false ? "inactive" : ""}">
            <td>${esc(s.name)}${s.active === false ? '<span class="sub">disabled</span>' : ""}</td>
            <td class="num">${n(counts[s.id] || 0)}</td>
            <td><select data-staff-role="${s.id}">${roleOptions(s.role || "general")}</select></td>
            <td style="white-space:nowrap">
              <button class="btn auto quiet" data-staff-toggle="${s.id}">${s.active === false ? "Enable" : "Disable"}</button>
              <button class="btn auto danger" data-staff-del="${s.id}">Remove</button>
            </td>
          </tr>`).join("") || `<tr><td colspan="4" class="muted">No staff codes yet.</td></tr>`}</tbody>
      </table></div>
    </section>`;
}

function sticker() {
  const sel = S._stickerTag || (S.machines[0] && S.machines[0].tag) || "";
  const m = machineByTag(sel);
  return `
    <section class="panel no-print">
      <h2>Print a QR sticker</h2>
      <label>Machine</label>
      <select id="st-machine">${S.machines.map(x => `<option value="${esc(x.tag)}" ${x.tag === sel ? "selected" : ""}>${esc(x.name)} · ${esc(x.tag)}</option>`).join("")}</select>
      <p class="dim small" style="margin-top:10px">Same QR on every sticker (it opens ${esc(STAFF_URL)}); the big number underneath is what staff type in. 50 × 68 mm.</p>
      <button id="st-print" class="btn primary mt">Print</button>
    </section>
    ${m ? `<div class="sticker">
      <div class="qr" id="st-qr"></div>
      <div class="tagno">${esc(m.tag)}</div>
      <div class="mname">${esc(m.name)}</div>
      <div class="foot">Staff: scan, enter this code + your code<br>Spacebar Arcade</div>
    </div>` : `<p class="muted">Add a machine first.</p>`}`;
}

/* ---------- machines: stats, tiles, machine page, settings ---------- */
const gbp = (x) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(x) || 0);
const empMine = (tag) => S.empties.filter(e => e.tag === tag).map(e => ({ tokens: e.tokens || 0, at: tsDate(e.at) }));

// Typed £ amount to a number. Blank gives 0, bad input gives undefined.
function parseMoney(s) {
  const t = String(s ?? "").replace(/[£,\s]/g, "");
  if (t === "") return 0;
  const x = Number(t);
  return Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : undefined;
}

// Ask for parts and labour costs. Returns null if cancelled.
function askRepairCost(prev = {}) {
  const parts = prompt("Parts cost (£) — leave blank if none", prev.partsCost ?? "");
  if (parts === null) return null;
  const labour = prompt("Labour cost (£) — leave blank if none", prev.labourCost ?? "");
  if (labour === null) return null;
  const p = parseMoney(parts), l = parseMoney(labour);
  if (p === undefined || l === undefined) { alert("Enter the cost as a number, e.g. 25 or 12.50."); return null; }
  return { partsCost: p, labourCost: l };
}

function statusPill(s) {
  return s === "inprogress"
    ? `<span class="pill" style="background:rgba(46,127,194,0.18);color:#8ed1fc">in progress</span>`
    : `<span class="pill ${s === "open" ? "open" : "closed"}">${s}</span>`;
}

// Shrink a photo to about 640px JPEG so it fits comfortably in the database.
async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("can't read that image"));
      i.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("can't read that image");
    for (const [max, q] of [[640, 0.7], [640, 0.55], [480, 0.6]]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", q);
      if (data.length <= 700000) return data;
    }
    throw new Error("that photo is too detailed, try a smaller one");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A repair with its money (kept in faultCosts, Rob only). Managers get no costs.
const withCosts = (f) => ({ ...f, ...(S.costs[f.id] || {}) });

function machineStats(tag, now = new Date()) {
  const mine = empMine(tag);
  const repairs = S.faults.filter(f => f.tag === tag).map(withCosts);
  const tokenValue = typeof S.settings?.tokenValue === "number" ? S.settings.tokenValue : null;
  const p = S.details[tag]?.purchasePrice;
  const price = typeof p === "number" && p > 0 ? p : null;
  const allTime = tokensInWindow(mine, null, now);
  return {
    allTime, tokenValue, price, repairs,
    openRepairs: repairs.filter(f => f.status !== "closed").length,
    ...machinePayback({ tokensAllTime: allTime, repairs, price, tokenValue })
  };
}

function tileBacking(st) {
  if (S.role !== "admin") return ""; // money is Rob's
  if (st.tokenValue == null) return `<span class="dim">set token value in Settings</span>`;
  if (st.price == null) return `<span class="dim">no price entered yet</span>`;
  if (st.paidBack) return `<span style="color:var(--ok)">Paid back</span>`;
  return `${Math.round(st.pct)}% paid back · ${gbp(st.left)} to go`;
}

function machineTile(m) {
  const st = machineStats(m.tag);
  const photo = S.details[m.tag]?.photo;
  return `
    <a class="mtile ${m.active === false ? "inactive" : ""}" href="#/machine/${esc(m.tag)}">
      <div class="mphoto">${photo ? `<img src="${esc(photo)}" alt="">` : `<span>${esc(m.tag)}</span>`}</div>
      <div class="mbody">
        <div class="tile-name">${esc(m.name)}</div>
        <div class="dim small">${esc(m.tag)}${m.active === false ? " · off" : ""} · ${n(st.allTime)} tokens</div>
        <div class="small" style="margin-top:6px">${tileBacking(st)}</div>
        ${st.openRepairs ? `<div style="margin-top:8px"><span class="pill open">${st.openRepairs} open repair${st.openRepairs > 1 ? "s" : ""}</span></div>` : ""}
      </div>
    </a>`;
}

function machineDetail() {
  const admin = S.role === "admin";
  const tag = S._machineTag;
  const m = machineByTag(tag);
  if (!m) return S.machines.length
    ? `<div style="margin-bottom:12px"><a href="#/machines">← All machines</a></div><p class="muted">That machine isn't in the list.</p>`
    : `<p class="muted">Loading…</p>`;
  const now = new Date();
  const st = machineStats(tag, now);
  const d = S.details[tag] || {};
  const mine = empMine(tag);
  const first = mine.reduce((a, e) => Math.min(a, e.at.getTime()), now.getTime());

  const periods = [["Last 7 days", 7], ["Last 14 days", 14], ["Last 30 days", 30], ["All time", null]];
  const tokenTiles = periods.map(([label, days]) => {
    const t = tokensInWindow(mine, days, now);
    const span = days ?? Math.max(1, (now.getTime() - first) / DAY);
    return `<div class="tile"><div class="k">${label}</div><div class="v">${n(t)}</div><div class="k">tokens · ${n(Math.round(t / span))}/day</div></div>`;
  }).join("");

  let payback;
  if (st.tokenValue == null) {
    payback = `<p class="muted">Set the value of one token in <a href="#/settings">Settings</a> to see payback.</p>`;
  } else {
    const est = st.price != null && !st.paidBack
      ? estimatePayback({ left: st.left, tokens30: tokensInWindow(mine, 30, now), tokenValue: st.tokenValue, now })
      : null;
    const summary = st.price == null
      ? `<p class="muted">Enter what you paid for it below to see payback.</p>`
      : st.paidBack
        ? `<p style="color:var(--ok)"><b>Paid back in full</b> · ${gbp(st.ahead)} ahead</p>`
        : `<p><b>${Math.round(st.pct)}% paid back</b> · ${gbp(st.left)} still to recover</p>
           <p class="dim small">${est && est.date ? `Estimated payback <b>${fmtDayYear.format(est.date)}</b>, at the last 30 days' takings` : "Not enough takings in the last 30 days to estimate a date."}</p>`;
    payback = `
      <div class="mline"><span>Earned · ${n(st.allTime)} tokens × ${gbp(st.tokenValue)}</span><b>${gbp(st.earned)}</b></div>
      <div class="mline"><span>Repairs</span><b>${st.repairsTotal > 0 ? "−" : ""}${gbp(st.repairsTotal)}</b></div>
      <div class="mline"><span>Net back so far</span><b>${gbp(st.net)}</b></div>
      <div style="margin:12px 0">${summary}</div>`;
  }

  const priceBlock = `
    <label for="mp-price">What you paid for it (£)</label>
    <div class="row">
      <input id="mp-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="e.g. 850" value="${d.purchasePrice ?? ""}">
      <button id="mp-price-save" class="btn auto">Save</button>
    </div>
    <div id="mp-price-msg"></div>`;

  const repairs = S.faults.filter(f => f.tag === tag).map(withCosts);
  const repairRows = repairs.map(f => `
    <div class="list-item">
      <div class="main">
        <div>${statusPill(f.status)} <span class="dim small">${fmtDayYear.format(tsDate(f.at))}${f.closedAt ? ` · fixed ${fmtDayYear.format(tsDate(f.closedAt))}` : ""}</span></div>
        <div class="note">${esc(f.note)}</div>
        ${f.closeNote ? `<div class="note" style="color:var(--blue-soft)">${esc(f.closeNote)}</div>` : ""}
        ${admin ? `<div class="dim small">Parts ${gbp(f.partsCost)} · Labour ${gbp(f.labourCost)} · ${gbp(repairCost(f))}</div>` : ""}
      </div>
      ${admin ? `<button class="btn auto quiet" data-edit-cost="${f.id}">Cost</button>` : ""}
    </div>`).join("");

  return `
    <div style="margin-bottom:12px"><a href="#/machines">← All machines</a></div>
    ${admin ? `<section class="panel">
      <div class="mbig">${d.photo ? `<img src="${esc(d.photo)}" alt="${esc(m.name)}">` : `<span class="dim">No photo yet</span>`}</div>
      <button id="mp-pick" class="btn">${d.photo ? "Replace photo" : "Add photo"}</button>
      <input id="mp-file" type="file" accept="image/*" style="display:none">
      <div id="mp-msg"></div>
      <h2 style="margin-top:14px">${esc(m.name)}</h2>
      <div class="dim small">Code ${esc(m.tag)}${m.active === false ? " · off — not shown to staff" : ""}</div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn auto quiet" data-rename="${esc(m.tag)}">Rename</button>
        <button class="btn auto quiet" data-toggle="${esc(m.tag)}">${m.active === false ? "Turn on" : "Turn off"}</button>
      </div>
    </section>` : `<section class="panel"><h2>${esc(m.name)}</h2><div class="dim small">Code ${esc(m.tag)}${m.active === false ? " · off" : ""}</div></section>`}
    <section class="panel"><h2>Tokens</h2><div class="tiles">${tokenTiles}</div></section>
    ${admin ? `<section class="panel">
      <h2>Payback</h2>
      ${payback}
      ${priceBlock}
    </section>` : ""}
    <section class="panel">
      <h2>Repairs (${repairs.length})${admin ? ` · ${gbp(st.repairsTotal)} in total` : ""}</h2>
      ${repairRows || `<p class="muted">No repairs logged for this machine.</p>`}
    </section>`;
}

function settingsView() {
  const tv = S.settings?.tokenValue;
  return `
    <section class="panel">
      <h2>Token value</h2>
      <p class="dim small">What one token is worth to you, in £. Every machine's payback uses it, so changing it here updates them all.</p>
      <label for="set-token">£ per token</label>
      <div class="row">
        <input id="set-token" type="number" inputmode="decimal" min="0" step="0.01" placeholder="e.g. 0.50" value="${typeof tv === "number" ? tv : ""}">
        <button id="set-token-save" class="btn primary auto">Save</button>
      </div>
      <div id="set-msg"></div>
    </section>`;
}

/* ---------- wiring ---------- */
let qrSvg = null;
async function loadQr() {
  if (qrSvg) return qrSvg;
  qrSvg = await (await fetch("qr.svg")).text();
  return qrSvg;
}

function wire(v) {
  v.querySelectorAll("[data-period]").forEach(b => b.addEventListener("click", () => { S.period = b.dataset.period; render(); }));

  // empties
  v.querySelector("#f-machine")?.addEventListener("change", e => { S._fMachine = e.target.value; render(); });
  v.querySelector("#f-staff")?.addEventListener("change", e => { S._fStaff = e.target.value; render(); });
  v.querySelector("#ae-save")?.addEventListener("click", async () => {
    const tag = el("ae-machine").value, tokens = parseInt(el("ae-tokens").value, 10);
    const when = new Date(el("ae-when").value);
    if (!tag) return setMsg("ae-msg", "Pick a machine.", "error");
    if (!(tokens >= 0)) return setMsg("ae-msg", "Enter the token count.", "error");
    if (isNaN(when) || when > new Date()) return setMsg("ae-msg", "Date can't be in the future.", "error");
    const m = machineByTag(tag);
    try {
      await addDoc(collection(db, "empties"), {
        tag, machineName: m.name, tokens, staffHash: "admin", staffName: "Rob", ok: true,
        note: el("ae-note").value.trim(), at: Timestamp.fromDate(when)
      });
      el("ae-tokens").value = ""; el("ae-note").value = "";
      setMsg("ae-msg", `Added ${n(tokens)} tokens for ${m.name}.`, "good");
    } catch (e) { setMsg("ae-msg", "Couldn't save: " + e.message, "error"); }
  });
  v.querySelectorAll("[data-del-empty]").forEach(b => b.addEventListener("click", async () => {
    const e = S.empties.find(x => x.id === b.dataset.delEmpty);
    if (!confirm(`Delete this empty? ${n(e.tokens)} tokens from ${e.machineName} (${e.staffName}).`)) return;
    await deleteDoc(doc(db, "empties", e.id));
  }));

  // faults
  const syncStatus = (batch, tag, skipId) => {
    const rest = S.faults.filter(x => x.tag === tag && x.status !== "closed" && x.id !== skipId).sort((p, q) => tsDate(p.at) - tsDate(q.at));
    if (!rest.length) batch.set(doc(db, "status", tag), { tag, faultOpen: false, faultState: "closed", faultNote: "", faultAt: null, faultBy: "", faultId: "", faultTechBy: "", faultTechNote: "" }, { merge: true });
    else { const r = rest[0]; batch.set(doc(db, "status", tag), { tag, faultOpen: true, faultState: r.status === "inprogress" ? "inprogress" : "open", faultNote: r.note, faultAt: r.at, faultBy: r.staffName, faultId: r.id, faultTechBy: r.inProgressBy || "", faultTechNote: r.techNote || "" }, { merge: true }); }
  };
  v.querySelectorAll("[data-prog-fault]").forEach(b => b.addEventListener("click", async () => {
    const f = S.faults.find(x => x.id === b.dataset.progFault);
    const note = prompt("Note for " + f.machineName + " (optional) — e.g. waiting on a part", f.techNote || "");
    if (note === null) return;
    const batch = writeBatch(db);
    batch.update(doc(db, "faults", f.id), { status: "inprogress", inProgressAt: serverTimestamp(), inProgressBy: "Rob", techNote: note.trim() });
    batch.set(doc(db, "status", f.tag), { tag: f.tag, faultOpen: true, faultState: "inprogress", faultTechBy: "Rob", faultTechNote: note.trim() }, { merge: true });
    await batch.commit();
  }));
  v.querySelectorAll("[data-open-fault]").forEach(b => b.addEventListener("click", async () => {
    const f = S.faults.find(x => x.id === b.dataset.openFault);
    const batch = writeBatch(db);
    batch.update(doc(db, "faults", f.id), { status: "open", inProgressAt: null, inProgressBy: "", techNote: "" });
    batch.set(doc(db, "status", f.tag), { tag: f.tag, faultOpen: true, faultState: "open", faultTechBy: "", faultTechNote: "" }, { merge: true });
    await batch.commit();
  }));
  v.querySelectorAll("[data-close-fault]").forEach(b => b.addEventListener("click", async () => {
    const f = S.faults.find(x => x.id === b.dataset.closeFault);
    const cost = askRepairCost(S.costs[f.id] || f);
    if (!cost) return;
    const batch = writeBatch(db);
    batch.set(doc(db, "faultCosts", f.id), { ...cost, updatedAt: serverTimestamp() }, { merge: true });
    batch.update(doc(db, "faults", f.id), { status: "closed", closedAt: serverTimestamp(), closedBy: "Rob", partsCost: deleteField(), labourCost: deleteField() });
    syncStatus(batch, f.tag, f.id);
    await batch.commit();
  }));
  v.querySelectorAll("[data-reopen-fault]").forEach(b => b.addEventListener("click", async () => {
    const f = S.faults.find(x => x.id === b.dataset.reopenFault);
    const batch = writeBatch(db);
    batch.update(doc(db, "faults", f.id), { status: "open", closedAt: null, closedBy: "", closeNote: "" });
    batch.set(doc(db, "status", f.tag), { tag: f.tag, faultOpen: true, faultState: "open", faultNote: f.note, faultAt: f.at, faultBy: f.staffName, faultId: f.id, faultTechBy: "", faultTechNote: "" }, { merge: true });
    await batch.commit();
  }));

  // weekly
  v.querySelectorAll("[data-week]").forEach(inp => {
    const save = async () => {
      const val = inp.value.trim();
      const k = inp.dataset.week;
      const cur = S.weeks[k]?.tokensSold ?? null;
      const num = val === "" ? null : parseInt(val, 10);
      if (num === cur) return;
      await setDoc(doc(db, "weeks", k), { tokensSold: num, updatedAt: serverTimestamp() }, { merge: true });
      toast(`Saved week of ${k}.`);
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
  });
  v.querySelectorAll("[data-start]").forEach(inp => {
    const save = async () => {
      const val = inp.value.trim();
      const k = inp.dataset.start;
      const cur = S.weeks[k]?.startCount ?? null;
      const num = val === "" ? null : parseInt(val, 10);
      if (num === cur) return;
      await setDoc(doc(db, "weeks", k), { startCount: num, updatedAt: serverTimestamp() }, { merge: true });
      toast(`Saved start count for week of ${k}.`);
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
  });
  v.querySelectorAll("[data-topup]").forEach(inp => {
    const save = async () => {
      const val = inp.value.trim();
      const k = inp.dataset.topup;
      const cur = S.weeks[k]?.topUp ?? null;
      const num = val === "" ? null : parseInt(val, 10);
      if (num === cur) return;
      await setDoc(doc(db, "weeks", k), { topUp: num, updatedAt: serverTimestamp() }, { merge: true });
      toast(`Saved top-up for week of ${k}.`);
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
  });

  // machines
  v.querySelector("#am-save")?.addEventListener("click", async () => {
    const name = el("am-name").value.trim(), tag = el("am-tag").value.trim();
    if (!name) return setMsg("am-msg", "Give the machine a name.", "error");
    if (!/^\d{4}$/.test(tag)) return setMsg("am-msg", "Code must be exactly 4 digits.", "error");
    if (machineByTag(tag)) return setMsg("am-msg", `Code ${tag} is already used.`, "error");
    await setDoc(doc(db, "machines", tag), { name, tag, active: true, createdAt: serverTimestamp() });
    el("am-name").value = "";
    setMsg("am-msg", `Added ${name} as ${tag}.`, "good");
  });
  v.querySelector("#am-bulk-save")?.addEventListener("click", async () => {
    const names = el("am-bulk").value.split("\n").map(x => x.trim()).filter(Boolean);
    if (!names.length) return setMsg("am-bulk-msg", "Paste some names first.", "error");
    const existing = new Set(S.machines.map(m => m.name.toLowerCase()));
    const used = new Set(S.machines.map(m => m.tag));
    let next = 1001; const batch = writeBatch(db); const added = [], skipped = [];
    for (const name of names) {
      if (existing.has(name.toLowerCase())) { skipped.push(name); continue; }
      while (used.has(String(next))) next++;
      const tag = String(next); used.add(tag); existing.add(name.toLowerCase());
      batch.set(doc(db, "machines", tag), { name, tag, active: true, createdAt: serverTimestamp() });
      added.push(`${tag} ${name}`);
    }
    if (!added.length) return setMsg("am-bulk-msg", "All of those already exist.", "error");
    try {
      await batch.commit();
      el("am-bulk").value = "";
      setMsg("am-bulk-msg", `Added ${added.length}: ${added.join(", ")}${skipped.length ? ` · skipped (already there): ${skipped.join(", ")}` : ""}`, "good");
    } catch (e) { setMsg("am-bulk-msg", "Couldn't save: " + e.message, "error"); }
  });
  v.querySelectorAll("[data-rename]").forEach(b => b.addEventListener("click", async () => {
    const m = machineByTag(b.dataset.rename);
    const name = prompt("New name for " + m.name, m.name);
    if (name && name.trim() && name.trim() !== m.name) await updateDoc(doc(db, "machines", m.tag), { name: name.trim() });
  }));
  v.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
    const m = machineByTag(b.dataset.toggle);
    await updateDoc(doc(db, "machines", m.tag), { active: m.active === false });
  }));

  // machine page: photo, purchase price, repair costs
  v.querySelector("#mp-pick")?.addEventListener("click", () => v.querySelector("#mp-file").click());
  v.querySelector("#mp-file")?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setMsg("mp-msg", "Saving photo…", "info");
    try {
      const photo = await resizePhoto(file);
      await setDoc(doc(db, "machineDetails", S._machineTag), { photo, photoAt: serverTimestamp() }, { merge: true });
      toast("Photo saved.");
    } catch (err) {
      setMsg("mp-msg", "Couldn't save that photo. " + (err.message || ""), "error");
    }
  });
  v.querySelector("#mp-price-save")?.addEventListener("click", async () => {
    const raw = el("mp-price").value.trim();
    const price = raw === "" ? null : parseMoney(raw);
    if (price === undefined || price === 0) return setMsg("mp-price-msg", "Enter what you paid, e.g. 850, or leave it blank.", "error");
    try {
      await setDoc(doc(db, "machineDetails", S._machineTag), { purchasePrice: price, updatedAt: serverTimestamp() }, { merge: true });
      toast(price ? `Saved: ${gbp(price)}.` : "Price cleared.");
    } catch (err) { setMsg("mp-price-msg", "Couldn't save: " + err.message, "error"); }
  });
  v.querySelectorAll("[data-edit-cost]").forEach(b => b.addEventListener("click", async () => {
    const f = S.faults.find(x => x.id === b.dataset.editCost);
    const cost = askRepairCost(S.costs[f.id] || f);
    if (!cost) return;
    await setDoc(doc(db, "faultCosts", f.id), { ...cost, updatedAt: serverTimestamp() }, { merge: true });
  }));

  // settings
  v.querySelector("#set-token-save")?.addEventListener("click", async () => {
    const raw = el("set-token").value.trim();
    const val = raw === "" ? undefined : parseMoney(raw);
    if (val === undefined || val === 0) return setMsg("set-msg", "Enter the value of one token, e.g. 0.50.", "error");
    try {
      await setDoc(doc(db, "settings", "app"), { tokenValue: val, updatedAt: serverTimestamp() }, { merge: true });
      toast(`Saved. One token is worth ${gbp(val)}.`);
    } catch (err) { setMsg("set-msg", "Couldn't save: " + err.message, "error"); }
  });

  // staff
  v.querySelector("#as-save")?.addEventListener("click", async () => {
    const name = el("as-name").value.trim(), code = el("as-code").value.trim();
    if (!name) return setMsg("as-msg", "Enter their name.", "error");
    if (!/^\d{4}$/.test(code)) return setMsg("as-msg", "Code must be exactly 4 digits.", "error");
    const hash = await sha256(code);
    if ((await getDoc(doc(db, "staffCodes", hash))).exists()) return setMsg("as-msg", "That code's already taken — pick another.", "error");
    await setDoc(doc(db, "staffCodes", hash), { name, role: el("as-role").value, active: true, createdAt: serverTimestamp() });
    el("as-name").value = ""; el("as-code").value = "";
    setMsg("as-msg", `Added ${name}. Their code is ${code} — write it down now.`, "good");
  });
  v.querySelectorAll("[data-staff-toggle]").forEach(b => b.addEventListener("click", async () => {
    const s = S.staff.find(x => x.id === b.dataset.staffToggle);
    await updateDoc(doc(db, "staffCodes", s.id), { active: s.active === false });
  }));
  v.querySelectorAll("[data-staff-role]").forEach(sel => sel.addEventListener("change", async () => {
    await updateDoc(doc(db, "staffCodes", sel.dataset.staffRole), { role: sel.value });
    toast(`Access changed to ${sel.options[sel.selectedIndex].text}.`);
  }));
  v.querySelectorAll("[data-staff-del]").forEach(b => b.addEventListener("click", async () => {
    const s = S.staff.find(x => x.id === b.dataset.staffDel);
    if (!confirm(`Remove ${s.name}'s code? Their past empties stay on record.`)) return;
    await deleteDoc(doc(db, "staffCodes", s.id));
  }));

  // sticker
  v.querySelector("#st-machine")?.addEventListener("change", e => { S._stickerTag = e.target.value; render(); });
  v.querySelector("#st-print")?.addEventListener("click", () => window.print());
  const qrBox = v.querySelector("#st-qr");
  if (qrBox) loadQr().then(svg => { qrBox.innerHTML = svg; });
}

if (!location.hash) location.hash = "#/overview";
