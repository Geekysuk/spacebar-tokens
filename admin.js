import {
  collection, doc, onSnapshot, query, orderBy, setDoc, updateDoc, deleteDoc, addDoc, getDoc,
  serverTimestamp, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth, sha256, el, setMsg, esc } from "./fb.js";
import { STAFF_URL } from "./config.js";

/* ---------- state ---------- */
const S = { machines: [], staff: [], empties: [], faults: [], weeks: {}, period: "week", ready: 0 };
let unsubs = [];
let view = "overview";

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
  idleTimer = setTimeout(() => signOut(auth), 30 * 60 * 1000);
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
el("btn-signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  el("boot").classList.add("hidden");
  if (!user) {
    unsubs.forEach(u => u()); unsubs = [];
    el("app").classList.add("hidden");
    el("login").classList.remove("hidden");
    return;
  }
  el("login").classList.add("hidden");
  el("app").classList.remove("hidden");
  resetIdle();
  subscribe();
  route();
});

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
  unsubs.push(sub(query(collection(db, "staffCodes"), orderBy("name")), "staff"));
  unsubs.push(sub(query(collection(db, "empties"), orderBy("at", "desc")), "empties"));
  unsubs.push(sub(query(collection(db, "faults"), orderBy("at", "desc")), "faults"));
  unsubs.push(onSnapshot(collection(db, "weeks"), (snap) => {
    S.weeks = {};
    snap.docs.forEach(d => { S.weeks[d.id] = d.data(); });
    render();
  }));
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
  const m = location.hash.match(/^#\/([a-z]+)/);
  view = m ? m[1] : "overview";
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  render();
}

function render() {
  if (!auth.currentUser) return;
  const open = S.faults.filter(f => f.status === "open").length;
  el("nav-faults").textContent = open ? `(${open})` : "";
  const v = el("view");
  const fn = { overview, empties, faults, weekly, machines, staff, sticker }[view] || overview;
  v.innerHTML = fn();
  wire(v);
}

/* ---------- views ---------- */
function overview() {
  const { from, to, label } = periodRange();
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
    <section class="panel">
      <h2>Add an empty (Rob)</h2>
      <div class="row">
        <div><label>Machine</label><select id="ae-machine">${S.machines.filter(m => m.active !== false).map(m => `<option value="${esc(m.tag)}">${esc(m.name)}</option>`).join("")}</select></div>
        <div><label>Tokens</label><input id="ae-tokens" type="number" inputmode="numeric" min="0" max="100000"></div>
      </div>
      <label>When</label><input id="ae-when" type="datetime-local" value="${dtDefault}">
      <label>Note (optional)</label><input id="ae-note" type="text" maxlength="300">
      <div id="ae-msg"></div>
      <button id="ae-save" class="btn primary mt">Add empty</button>
    </section>
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
              <div><b>${esc(e.machineName)}</b> <span class="dim small">${esc(e.tag)}</span> ${e.ok === false ? '<span class="pill bad">fault</span>' : ""}</div>
              <div class="t">${fmtTime.format(tsDate(e.at))} · ${esc(e.staffName)}</div>
              ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}
            </div>
            <div class="n">${n(e.tokens)}</div>
            <button class="btn auto quiet" data-del-empty="${e.id}" title="Delete">✕</button>
          </div>`).join("")}`).join("") || `<p class="muted">Nothing logged yet.</p>`}
    </section>`;
}

function faults() {
  const open = S.faults.filter(f => f.status === "open");
  const closed = S.faults.filter(f => f.status !== "open").slice(0, 50);
  const item = (f) => `
    <div class="list-item">
      <div class="main">
        <div><b>${esc(f.machineName)}</b> <span class="dim small">${esc(f.tag)}</span> <span class="pill ${f.status === "open" ? "open" : "closed"}">${f.status}</span></div>
        <div class="t">${fmtDay.format(tsDate(f.at))} ${fmtTime.format(tsDate(f.at))} · reported by ${esc(f.staffName)}${f.closedAt ? ` · closed ${fmtShort.format(tsDate(f.closedAt))}` : ""}</div>
        <div class="note">${esc(f.note)}</div>
      </div>
      ${f.status === "open" ? `<button class="btn auto" data-close-fault="${f.id}">Fixed</button>` : `<button class="btn auto quiet" data-reopen-fault="${f.id}">Reopen</button>`}
    </div>`;
  return `
    <section class="panel"><h2>Open faults (${open.length})</h2>${open.map(item).join("") || `<p class="muted">Nothing open. Staff report faults on the token page when they tick "Something's wrong".</p>`}</section>
    <section class="panel"><h2>Fixed</h2>${closed.map(item).join("") || `<p class="muted">None yet.</p>`}</section>`;
}

function weekly() {
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
    const sold = S.weeks[k]?.tokensSold;
    weeks.push({ k, start: d, end, collected, sold });
    if (weeks.length > 104) break;
  }
  return `
    <section class="panel">
      <h2>Weekly check — sold vs collected</h2>
      <p class="muted small">Weeks run Monday to Sunday. Type the tokens sold that week; the app adds up what staff emptied out of the machines. Difference = sold − collected (tokens still in machines or unaccounted for).</p>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Week</th><th class="num">Sold</th><th class="num">Collected</th><th class="num">Diff</th></tr></thead>
        <tbody>${weeks.map(w => {
          const diff = (w.sold ?? null) === null ? null : w.sold - w.collected;
          return `<tr>
            <td class="wk">${weekLabel(w.start, w.end)}<span class="sub">${w.k === dayKey(thisMon) ? "this week" : ""}</span></td>
            <td class="num"><input type="number" inputmode="numeric" min="0" style="width:76px;padding:6px 8px;text-align:right" data-week="${w.k}" value="${w.sold ?? ""}" placeholder="—"></td>
            <td class="num">${n(w.collected)}</td>
            <td class="num ${diff === null ? "dim" : diff >= 0 ? "diff-pos" : "diff-neg"}">${diff === null ? "—" : (diff > 0 ? "+" : "") + n(diff)}</td>
          </tr>`; }).join("")}</tbody>
      </table></div>
      <p class="dim small" style="margin-top:10px">Saves when you leave the box.</p>
    </section>`;
}

function machines() {
  const counts = {};
  S.empties.forEach(e => { counts[e.tag] = (counts[e.tag] || 0) + (e.tokens || 0); });
  const used = new Set(S.machines.map(m => m.tag));
  let next = 1001; while (used.has(String(next))) next++;
  return `
    <section class="panel">
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
    </section>
    <section class="panel">
      <h2>Machines (${S.machines.length})</h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Code</th><th>Name</th><th class="num">All-time tokens</th><th></th></tr></thead>
        <tbody>${S.machines.map(m => `
          <tr class="${m.active === false ? "inactive" : ""}">
            <td><b>${esc(m.tag)}</b></td>
            <td>${esc(m.name)}${m.active === false ? '<span class="sub">off — not shown to staff</span>' : ""}</td>
            <td class="num">${n(counts[m.tag] || 0)}</td>
            <td style="white-space:nowrap">
              <button class="btn auto quiet" data-rename="${esc(m.tag)}">Rename</button>
              <button class="btn auto quiet" data-toggle="${esc(m.tag)}">${m.active === false ? "Turn on" : "Turn off"}</button>
            </td>
          </tr>`).join("") || `<tr><td colspan="4" class="muted">No machines yet.</td></tr>`}</tbody>
      </table></div>
      <p class="dim small" style="margin-top:10px">Turn a machine off if it leaves the floor — its history stays. The code is fixed once created (it's on the sticker).</p>
    </section>`;
}

function staff() {
  const counts = {};
  S.empties.forEach(e => { counts[e.staffHash] = (counts[e.staffHash] || 0) + 1; });
  return `
    <section class="panel">
      <h2>Add a staff code</h2>
      <div class="row">
        <div><label>Name</label><input id="as-name" type="text" maxlength="40"></div>
        <div><label>4-digit code</label><input id="as-code" type="tel" inputmode="numeric" maxlength="4"></div>
      </div>
      <div id="as-msg"></div>
      <button id="as-save" class="btn primary mt">Add code</button>
      <p class="dim small" style="margin-top:10px">Codes are stored hashed — the app can't show you a code later, so write it down when you give it out. One code per person so empties are attributable.</p>
    </section>
    <section class="panel">
      <h2>Staff (${S.staff.length})</h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Name</th><th class="num">Empties logged</th><th></th></tr></thead>
        <tbody>${S.staff.map(s => `
          <tr class="${s.active === false ? "inactive" : ""}">
            <td>${esc(s.name)}${s.active === false ? '<span class="sub">disabled</span>' : ""}</td>
            <td class="num">${n(counts[s.id] || 0)}</td>
            <td style="white-space:nowrap">
              <button class="btn auto quiet" data-staff-toggle="${s.id}">${s.active === false ? "Enable" : "Disable"}</button>
              <button class="btn auto danger" data-staff-del="${s.id}">Remove</button>
            </td>
          </tr>`).join("") || `<tr><td colspan="3" class="muted">No staff codes yet.</td></tr>`}</tbody>
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
  v.querySelectorAll("[data-close-fault]").forEach(b => b.addEventListener("click", () =>
    updateDoc(doc(db, "faults", b.dataset.closeFault), { status: "closed", closedAt: serverTimestamp() })));
  v.querySelectorAll("[data-reopen-fault]").forEach(b => b.addEventListener("click", () =>
    updateDoc(doc(db, "faults", b.dataset.reopenFault), { status: "open", closedAt: null })));

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

  // staff
  v.querySelector("#as-save")?.addEventListener("click", async () => {
    const name = el("as-name").value.trim(), code = el("as-code").value.trim();
    if (!name) return setMsg("as-msg", "Enter their name.", "error");
    if (!/^\d{4}$/.test(code)) return setMsg("as-msg", "Code must be exactly 4 digits.", "error");
    const hash = await sha256(code);
    if ((await getDoc(doc(db, "staffCodes", hash))).exists()) return setMsg("as-msg", "That code's already taken — pick another.", "error");
    await setDoc(doc(db, "staffCodes", hash), { name, active: true, createdAt: serverTimestamp() });
    el("as-name").value = ""; el("as-code").value = "";
    setMsg("as-msg", `Added ${name}. Their code is ${code} — write it down now.`, "good");
  });
  v.querySelectorAll("[data-staff-toggle]").forEach(b => b.addEventListener("click", async () => {
    const s = S.staff.find(x => x.id === b.dataset.staffToggle);
    await updateDoc(doc(db, "staffCodes", s.id), { active: s.active === false });
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
