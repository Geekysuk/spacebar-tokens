import { doc, getDoc, addDoc, collection, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, sha256, el, setMsg } from "./fb.js";

const state = { tag: "", machine: null, staffHash: "", staffName: "" };

const digitsOnly = (input) => { input.value = input.value.replace(/\D/g, "").slice(0, 4); };
["tag", "staff"].forEach(id => el(id).addEventListener("input", e => digitsOnly(e.target)));
el("tag").addEventListener("input", () => { if (el("tag").value.length === 4) el("staff").focus(); });
el("staff").addEventListener("keydown", e => { if (e.key === "Enter") el("btn-next").click(); });

function show(step) {
  ["step-codes", "step-count", "step-done"].forEach(s => el(s).classList.toggle("hidden", s !== step));
  window.scrollTo(0, 0);
}

el("btn-next").addEventListener("click", async () => {
  const tag = el("tag").value.trim();
  const code = el("staff").value.trim();
  setMsg("codes-msg", "");
  if (tag.length !== 4) return setMsg("codes-msg", "Enter the 4-digit machine code from the sticker.", "error");
  if (code.length !== 4) return setMsg("codes-msg", "Enter your 4-digit staff code.", "error");
  const btn = el("btn-next");
  btn.disabled = true;
  try {
    const mSnap = await getDoc(doc(db, "machines", tag));
    if (!mSnap.exists() || mSnap.data().active === false) {
      return setMsg("codes-msg", `No machine with code ${tag}. Check the sticker.`, "error");
    }
    const hash = await sha256(code);
    const sSnap = await getDoc(doc(db, "staffCodes", hash));
    if (!sSnap.exists() || sSnap.data().active === false) {
      return setMsg("codes-msg", "That staff code isn't recognised.", "error");
    }
    state.tag = tag;
    state.machine = mSnap.data();
    state.staffHash = hash;
    state.staffName = sSnap.data().name;
    el("m-name").textContent = state.machine.name;
    el("m-who").textContent = state.staffName;
    el("tokens").value = ""; el("tokens2").value = ""; el("note").value = "";
    document.querySelectorAll('input[name="check"]').forEach(r => { r.checked = false; });
    el("fault-wrap").classList.add("hidden");
    setMsg("count-msg", "");
    show("step-count");
    el("tokens").focus();
  } catch (err) {
    setMsg("codes-msg", "Couldn't check the codes — is the phone online?", "error");
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll('input[name="check"]').forEach(r => r.addEventListener("change", () => {
  const bad = document.querySelector('input[name="check"]:checked')?.value === "bad";
  el("fault-wrap").classList.toggle("hidden", !bad);
  if (bad) el("note").focus();
}));

el("btn-back").addEventListener("click", () => show("step-codes"));

el("btn-save").addEventListener("click", async () => {
  setMsg("count-msg", "");
  const a = el("tokens").value.trim(), b = el("tokens2").value.trim();
  if (a === "" || !/^\d+$/.test(a)) return setMsg("count-msg", "Type the number of tokens you took out.", "error");
  if (a !== b) return setMsg("count-msg", "The two numbers don't match — check and type again.", "error");
  const tokens = parseInt(a, 10);
  if (tokens > 100000) return setMsg("count-msg", "That's more than 100,000 — double-check it.", "error");
  const check = document.querySelector('input[name="check"]:checked')?.value;
  if (!check) return setMsg("count-msg", "Tick whether the machine's working OK or not.", "error");
  const note = el("note").value.trim();
  if (check === "bad" && !note) return setMsg("count-msg", "Say what's wrong so it can be fixed.", "error");

  const btn = el("btn-save");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const emptyRef = doc(collection(db, "empties"));
    const base = {
      tag: state.tag,
      machineName: state.machine.name,
      staffHash: state.staffHash,
      staffName: state.staffName,
      at: serverTimestamp()
    };
    batch.set(emptyRef, { ...base, tokens, ok: check === "ok", note: check === "bad" ? note : "" });
    if (check === "bad") {
      batch.set(doc(collection(db, "faults")), { ...base, note, status: "open", emptyId: emptyRef.id });
    }
    await batch.commit();
    el("done-n").textContent = tokens.toLocaleString("en-GB");
    el("done-sub").textContent = `tokens logged from ${state.machine.name} by ${state.staffName}`;
    el("done-fault").classList.toggle("hidden", check !== "bad");
    show("step-done");
  } catch (err) {
    console.error(err);
    setMsg("count-msg", "Couldn't save — check the phone's online and try again.", "error");
  } finally {
    btn.disabled = false;
  }
});

el("btn-another").addEventListener("click", () => {
  el("tag").value = ""; el("staff").value = "";
  setMsg("codes-msg", "");
  show("step-codes");
  el("tag").focus();
});

el("tag").focus();
