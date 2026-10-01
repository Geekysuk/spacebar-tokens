(function () {
  "use strict";
  var API = "https://send-fault-email-77052047925.europe-west2.run.app";
  var REMEMBER_MS = 14 * 24 * 60 * 60 * 1000;
  var BLUE = "#2e7fc2", AMBER = "#fcb900", RED = "#ff5f7a";
  var state = { hash: "", name: "" };
  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function sha256(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function msg(id, text, kind) {
    var box = $(id); box.textContent = "";
    if (!text) return;
    var d = document.createElement("div"); d.className = "msg " + (kind || "info"); d.textContent = text; box.appendChild(d);
  }
  function ago(ms) {
    var h = Math.floor((Date.now() - ms) / 3600000);
    if (h < 1) return "under an hour";
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === "style") e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function post(path, body) {
    return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }
  function save() { try { localStorage.setItem("sb_tech", JSON.stringify({ h: state.hash, n: state.name, t: Date.now() })); } catch (e) {} }
  function forget() { try { localStorage.removeItem("sb_tech"); } catch (e) {} state.hash = ""; state.name = ""; }
  function recall() {
    try { var s = JSON.parse(localStorage.getItem("sb_tech") || "null");
      if (s && s.h && Date.now() - s.t < REMEMBER_MS) { state.hash = s.h; state.name = s.n; return true; } } catch (e) {}
    return false;
  }
  function show(step) {
    $("step-code").classList.toggle("hidden", step !== "code");
    $("step-jobs").classList.toggle("hidden", step !== "jobs");
  }

  function card(f) {
    var inprog = f.status === "inprogress";
    var col = inprog ? BLUE : (Date.now() - f.at > 7 * 86400000 ? RED : AMBER);
    var c = el("div", { "class": "panel", id: "job-" + f.id, style: "border-left:5px solid " + col + ";padding:14px" });

    var head = el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:10px" });
    var title = el("div", { style: "font-family:var(--display);font-size:20px" }, f.machineName);
    title.appendChild(el("span", { "class": "dim small", style: "font-family:var(--body);margin-left:8px" }, "code " + f.tag));
    head.appendChild(title);
    head.appendChild(el("div", { style: "font-weight:700;font-size:13px;color:" + col + ";white-space:nowrap" }, "open " + ago(f.at)));
    c.appendChild(head);

    c.appendChild(el("span", { "class": "pill", style: "margin-top:8px;background:" + col + "26;color:" + col }, inprog ? "In progress" + (f.techBy ? " \u00b7 " + f.techBy : "") : "Open"));
    c.appendChild(el("div", { style: "margin:10px 0 4px;font-size:16px;line-height:1.4;white-space:pre-wrap" }, f.note));
    c.appendChild(el("div", { "class": "dim small" }, "Reported by " + f.staffName + ", " + fmt.format(new Date(f.at))));
    if (f.techNote) c.appendChild(el("div", { "class": "small", style: "color:" + BLUE + ";margin-top:6px" }, "Your note: " + f.techNote));

    var ta = el("textarea", { maxlength: "300", placeholder: "Note (optional) \u2014 e.g. waiting on a part, fitted new coin mech", style: "min-height:64px;margin-top:12px" });
    ta.value = f.techNote || "";
    c.appendChild(ta);

    var row = el("div", { "class": "row", style: "margin-top:10px" });
    var status = el("div", { "class": "small", style: "margin-top:8px" });
    function act(action, label) {
      var btn = el("button", { type: "button", "class": "btn" + (action === "closed" ? " primary" : "") }, label);
      btn.addEventListener("click", function () {
        if (action === "closed" && !window.confirm("Mark " + f.machineName + " as repaired and close this job?")) return;
        var all = c.querySelectorAll("button"); Array.prototype.forEach.call(all, function (b) { b.disabled = true; });
        status.textContent = "Saving\u2026";
        post("/tech/update", { techHash: state.hash, faultId: f.id, action: action, note: ta.value.trim() }).then(function (j) {
          if (j.ok) { msg("jobs-msg", (action === "closed" ? "Closed: " : "Marked in progress: ") + f.machineName, "good"); load(); }
          else { Array.prototype.forEach.call(all, function (b) { b.disabled = false; }); status.textContent = ""; msg("jobs-msg", j.error || "Couldn't save \u2014 try again.", "error"); if (j.__status === 403) { forget(); show("code"); } }
        }).catch(function () { Array.prototype.forEach.call(all, function (b) { b.disabled = false; }); status.textContent = ""; msg("jobs-msg", "No connection \u2014 try again.", "error"); });
      });
      return btn;
    }
    if (!inprog) row.appendChild(act("inprogress", "In progress"));
    else row.appendChild(act("inprogress", "Update note"));
    row.appendChild(act("closed", "Repair done"));
    c.appendChild(row); c.appendChild(status);
    return c;
  }

  function load() {
    var box = $("jobs");
    return post("/tech/list", { techHash: state.hash }).then(function (j) {
      if (!j.ok) {
        if (j.__status === 403) { forget(); show("code"); msg("code-msg", "That code isn't recognised.", "error"); }
        else msg("jobs-msg", j.error || "Couldn't load jobs.", "error");
        return;
      }
      state.name = j.name; save();
      $("who").textContent = j.name;
      box.textContent = "";
      if (!j.faults.length) box.appendChild(el("div", { "class": "panel", style: "text-align:center" }, "No open jobs \u2014 all clear."));
      j.faults.forEach(function (f) { box.appendChild(card(f)); });
      show("jobs");
      var id = (location.hash || "").replace("#", "");
      var target = id && $("job-" + id);
      if (target) { target.style.boxShadow = "0 0 0 2px " + "#de51a8"; target.scrollIntoView({ block: "center" }); }
    }).catch(function () { show("jobs"); msg("jobs-msg", "No connection \u2014 pull to refresh.", "error"); });
  }

  $("code").addEventListener("input", function (e) { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
  $("code").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btn-code").click(); });
  $("btn-code").addEventListener("click", function () {
    var code = $("code").value.trim(); msg("code-msg", "");
    if (code.length !== 6) return msg("code-msg", "Enter your 6-digit technician code.", "error");
    var btn = $("btn-code"); btn.disabled = true;
    sha256(code).then(function (h) { state.hash = h; $("code").value = ""; return load(); })
      .then(function () { btn.disabled = false; }, function () { btn.disabled = false; });
  });
  $("btn-out").addEventListener("click", function (e) { e.preventDefault(); forget(); show("code"); $("code").focus(); });
  $("btn-refresh").addEventListener("click", function () { msg("jobs-msg", ""); load(); });

  if (recall()) { show("jobs"); load(); } else { show("code"); $("code").focus(); }
})();
