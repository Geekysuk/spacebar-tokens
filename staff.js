import { doc, getDoc, collection, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, sha256, el, setMsg } from "./fb.js";

const REMEMBER_MS = 12 * 60 * 60 * 1000;
const TEST_DUE_MS = 48 * 60 * 60 * 1000;
const FAULT_EMAIL_URL = "https://send-fault-email-77052047925.europe-west2.run.app";
const state = { tag: "", machine: null, status: null, staffHash: "", staffName: "" };

const digitsOnly = (input) => { input.value = input.value.replace(/\D/g, "").slice(0, 4); };
["tag", "staff"].forEach(id => el(id).addEventListener("input", e => digitsOnly(e.target)));
el("staff").addEventListener("keydown", e => { if (e.key === "Enter") el("btn-staff").click(); });
el("tag").addEventListener("keydown", e => { if (e.key === "Enter") el("btn-machine").click(); });

function show(step) {
  ["step-staff", "step-machine", "step-count", "step-done"].forEach(s => el(s).classList.toggle("hidden", s !== step));
  window.scrollTo(0, 0);
}
function remember() { try { localStorage.setItem("sb_staff", JSON.stringify({ h: state.staffHash, n: state.staffName, t: Date.now() })); } catch {} }
function forget() { try { localStorage.removeItem("sb_staff"); } catch {} state.staffHash = ""; state.staffName = ""; }
function recall() {
  try { const s = JSON.parse(localStorage.getItem("sb_staff") || "null");
    if (s && s.h && Date.now() - s.t < REMEMBER_MS) { state.staffHash = s.h; state.staffName = s.n; return true; } } catch {}
  return false;
}
const tsDate = (t) => (t && typeof t.toDate === "function") ? t.toDate() : null;
function ago(d) {
  const h = Math.floor((Date.now() - d.getTime()) / 3600000);
  if (h < 1) return "less than an hour ago";
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const dd = Math.floor(h / 24); return `${dd} day${dd === 1 ? "" : "s"} ago`;
}
const fmtWhen = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" });

function goMachine() {
  el("who-name").textContent = state.staffName;
  el("tag").value = ""; setMsg("machine-msg", "");
  show("step-machine"); el("tag").focus();
}

el("btn-staff").addEventListener("click", async () => {
  const code = el("staff").value.trim(); setMsg("staff-msg", "");
  if (code.length !== 4) return setMsg("staff-msg", "Enter your 4-digit staff code.", "error");
  const btn = el("btn-staff"); btn.disabled = true;
  try {
    const hash = await sha256(code);
    const sSnap = await getDoc(doc(db, "staffCodes", hash));
    if (!sSnap.exists() || sSnap.data().active === false) return setMsg("staff-msg", "That staff code isn't recognised.", "error");
    state.staffHash = hash; state.staffName = sSnap.data().name; remember(); el("staff").value = ""; goMachine();
  } catch (err) { console.error(err); setMsg("staff-msg", "Couldn't check the code — is the phone online?", "error"); }
  finally { btn.disabled = false; }
});
el("btn-switch").addEventListener("click", (e) => { e.preventDefault(); forget(); setMsg("staff-msg", ""); show("step-staff"); el("staff").focus(); });

function renderChecks() {
  const st = state.status || {};
  const last = tsDate(st.lastTestedAt);
  const mustTest = !last || (Date.now() - last.getTime() > TEST_DUE_MS);
  el("m-status").textContent = last ? `Last tested ${ago(last)} by ${st.lastTestedBy || "staff"}` : "Never tested";

  const faultBox = el("fault-open");
  if (st.faultOpen) {
    faultBox.textContent = `Fault already reported: ${st.faultNote || "(no details)"}`;
    faultBox.classList.remove("hidden");
  } else faultBox.classList.add("hidden");

  const opts = [];
  opts.push(["ok", "Tested — working OK", "ok"]);
  if (st.faultOpen) {
    opts.push(["stillbroken", "Still broken — same fault", "bad"]);
    opts.push(["bad", "Something else is wrong", "bad"]);
  } else opts.push(["bad", "Something's wrong", "bad"]);
  opts.push(["skipped", mustTest ? `Skipped — not allowed, ${last ? "not tested for " + ago(last).replace(" ago", "") : "never tested"}` : "Skipped — too busy to test", "", mustTest]);

  el("check-options").innerHTML = opts.map(([v, label, cls, dis]) =>
    `<label class="choice ${cls}${dis ? " disabled" : ""}"><input type="radio" name="check" value="${v}"${dis ? " disabled" : ""}> ${label}</label>`).join("");
  document.querySelectorAll('input[name="check"]').forEach(r => r.addEventListener("change", () => {
    const bad = document.querySelector('input[name="check"]:checked')?.value === "bad";
    el("fault-wrap").classList.toggle("hidden", !bad);
    if (bad) el("note").focus();
  }));
  el("fault-wrap").classList.add("hidden");
}

el("btn-machine").addEventListener("click", async () => {
  const tag = el("tag").value.trim(); setMsg("machine-msg", "");
  if (tag.length !== 4) return setMsg("machine-msg", "Enter the 4-digit machine code from the sticker.", "error");
  const btn = el("btn-machine"); btn.disabled = true;
  try {
    const [mSnap, sSnap] = await Promise.all([getDoc(doc(db, "machines", tag)), getDoc(doc(db, "status", tag))]);
    if (!mSnap.exists() || mSnap.data().active === false) return setMsg("machine-msg", `No machine with code ${tag}. Check the sticker.`, "error");
    state.tag = tag; state.machine = mSnap.data(); state.status = sSnap.exists() ? sSnap.data() : null;
    el("m-name").textContent = state.machine.name; el("m-who").textContent = state.staffName;
    el("tokens").value = ""; el("note").value = ""; setMsg("count-msg", "");
    renderChecks();
    show("step-count"); el("tokens").focus();
  } catch (err) { console.error(err); setMsg("machine-msg", "Couldn't find the machine — is the phone online?", "error"); }
  finally { btn.disabled = false; }
});

el("btn-back").addEventListener("click", goMachine);

el("btn-save").addEventListener("click", async () => {
  setMsg("count-msg", "");
  const a = el("tokens").value.trim();
  if (a === "" || !/^\d+$/.test(a)) return setMsg("count-msg", "Type the number of tokens you took out.", "error");
  const tokens = parseInt(a, 10);
  if (tokens > 100000) return setMsg("count-msg", "That's more than 100,000 — double-check it.", "error");
  const check = document.querySelector('input[name="check"]:checked')?.value;
  if (!check) return setMsg("count-msg", "Tick one of the machine check options.", "error");
  const note = el("note").value.trim();
  if (check === "bad" && !note) return setMsg("count-msg", "Say what's wrong so it can be fixed.", "error");

  const btn = el("btn-save"); btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const emptyRef = doc(collection(db, "empties"));
    const base = { tag: state.tag, machineName: state.machine.name, staffHash: state.staffHash, staffName: state.staffName, at: serverTimestamp() };
    batch.set(emptyRef, { ...base, tokens, ok: check === "ok" || check === "skipped", check, note: check === "bad" ? note : "" });
    let faultRef = null;
    if (check === "bad") { faultRef = doc(collection(db, "faults")); batch.set(faultRef, { ...base, note, status: "open", emptyId: emptyRef.id }); }
    if (check !== "skipped") {
      const st = { tag: state.tag, staffHash: state.staffHash, lastTestedAt: serverTimestamp(), lastTestedBy: state.staffName, lastCheck: check,
        faultOpen: check === "bad" ? true : !!(state.status && state.status.faultOpen) };
      if (check === "bad") Object.assign(st, { faultNote: note, faultAt: serverTimestamp(), faultBy: state.staffName, faultId: faultRef.id });
      batch.set(doc(db, "status", state.tag), st, { merge: true });
    }
    await batch.commit();
    remember();
    if (check === "bad" || check === "stillbroken") {
      const faultNote = check === "bad" ? note : ((state.status && state.status.faultNote) || "");
      fetch(FAULT_EMAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: state.tag, staffHash: state.staffHash, kind: check, note: faultNote }) })
        .catch(err => console.error("fault email failed", err));
    }
    el("done-n").textContent = tokens.toLocaleString("en-GB");
    el("done-sub").textContent = `tokens logged from ${state.machine.name} by ${state.staffName}`;
    el("done-fault").classList.toggle("hidden", check !== "bad");
    show("step-done");
  } catch (err) {
    console.error(err);
    const denied = err && err.code === "permission-denied";
    setMsg("count-msg", denied ? "Not allowed — your staff code may have been disabled. Ask Rob." : "Couldn't save — check the phone's online and try again.", "error");
  } finally { btn.disabled = false; }
});

el("btn-another").addEventListener("click", goMachine);
el("btn-finish").addEventListener("click", () => { forget(); show("step-staff"); el("staff").focus(); });

if (recall()) goMachine(); else el("staff").focus();
