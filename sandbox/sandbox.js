// © 2026 Cumulative Web Inc. All rights reserved. (cumulativeweb.com)
// THE BOOTH SANDBOX — TEST MODE page logic.
// Runs the production ledger code (ledger-core.js, same file as prod) against
// an in-memory throwaway ledger. Every entry's memo is stamped SANDBOX TEST.
// No real money, no real credits, nothing persisted beyond this browser tab
// (sessionStorage only, cleared on tab close).
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function ok(el, t) { el.innerHTML = '<div class="okmsg">' + esc(t) + "</div>"; }
  function bad(el, t) { el.innerHTML = '<div class="err">' + esc(t) + "</div>"; }
  function showReceipt(el, entry) {
    el.innerHTML += '<pre class="receipt">' + esc(JSON.stringify(entry, null, 2)) + "</pre>";
  }
  function randHex(n) {
    var a = new Uint8Array(n), i;
    crypto.getRandomValues(a);
    var s = "";
    for (i = 0; i < n; i++) s += ("0" + a[i].toString(16)).slice(-2);
    return s;
  }

  var mem = { lines: [], read: function () { return this.lines.slice(); }, append: function (l) { this.lines.push(l); } };
  var rubric = null, testKey = null, clockOffsetMs = 0;

  fetch("first-spin.json").then(function (r) { return r.json(); }).then(function (cfg) {
    rubric = cfg;
    renderLog();
  }).catch(function () { bad($("ledger-log"), "Rubric failed to load — sandbox cannot run."); });

  function L() { return new BoothLedger.Ledger(mem, rubric); }
  function sandboxNow() { return new Date(Date.now() + clockOffsetMs).toISOString(); }
  var MEMO = "SANDBOX TEST — simulated credits, no real money";

  function renderLog() {
    var html = "";
    mem.lines.forEach(function (ln, i) {
      var e = JSON.parse(ln);
      html += '<pre class="receipt">#' + i + " " + esc(e.type) + " · " + esc(e.id) + "\n" +
        esc(JSON.stringify(e, null, 1).slice(0, 600)) + (JSON.stringify(e).length > 600 ? "\n…" : "") + "</pre>";
    });
    $("ledger-log").innerHTML = html ||
      '<p style="color:#555">No sandbox entries yet — run a step above.</p>';
  }
  function bal(artist) { return (L().balance("artist:" + artist) / 100).toFixed(2); }

  $("mk-key").onclick = function () {
    testKey = "sb_test_" + randHex(32);
    $("key-out").innerHTML = '<div class="okmsg">Test key generated (synthetic, browser-only, unlocks the steps below):</div>' +
      '<div class="keybox">' + esc(testKey) + "</div>" +
      '<p style="color:#555;font-size:.9rem">This key has no value anywhere. It only labels your sandbox receipts.</p>';
  };
  function needKey() {
    if (!testKey) { bad($("key-out"), "Generate a test key first (step 1)."); return false; }
    return true;
  }

  $("do-purchase").onclick = function () {
    if (!needKey()) return;
    var artist = $("p-artist").value.trim() || "sandbox_artist";
    var n = parseInt($("p-n").value, 10);
    try {
      var e = L().purchase(artist, n, sandboxNow(), n + " TEST credit(s) @ $1 (simulated). " + MEMO);
      ok($("p-out"), "Simulated purchase: " + n + " TEST credit(s) → " + artist +
        ". Balance: $" + bal(artist) + " TEST. Entry " + e.id);
      showReceipt($("p-out"), e);
      renderLog();
    } catch (err) { bad($("p-out"), "REJECTED: " + err.message); }
  };

  $("do-request").onclick = function () {
    if (!needKey()) return;
    var artist = $("p-artist").value.trim() || "sandbox_artist";
    try {
      var e = L().requestReview(artist, $("r-id").value.trim(), $("r-track").value.trim(), null, sandboxNow());
      e.memo = (e.memo || "") + " " + MEMO;
      ok($("r-out"), "Simulated request: 1 TEST credit → escrow, 72h clock started. Balance: $" + bal(artist) + " TEST. Entry " + e.id);
      showReceipt($("r-out"), e);
      renderLog();
    } catch (err) { bad($("r-out"), "REJECTED: " + err.message); }
  };

  function cannedVerdict(artist, track) {
    var src = function (fact) {
      return { fact: fact, observed: "sandbox rehearsal", url: "https://example.invalid/sandbox" };
    };
    return {
      format: "first-spin-verdict/v1",
      subject: { artist: artist, track: track },
      evaluated_by: "sandbox_reviewer (SIMULATED)",
      evaluation_date: sandboxNow().slice(0, 10),
      summary: "Sandbox rehearsal verdict: competent hook and lane, momentum unverified. Canned valid verdict for the TEST flow.",
      scores: [
        { criterion: "hook_density", score: 4, score_confidence: "derived", notes: "Sandbox note: hook arrives early in the rehearsal listen.", sources: [src("hook lands in first 30s")] },
        { criterion: "replay_pull", score: 3, score_confidence: "estimated", notes: "Sandbox note: replay instinct moderate.", sources: [src("second listen requested in rehearsal")] },
        { criterion: "lane_clarity", score: 4, score_confidence: "verified", notes: "Sandbox note: lane is unmistakable.", sources: [src("alt-rap lane markers present")] },
        { criterion: "sync_readiness", score: 3, score_confidence: "derived", notes: "Sandbox note: sync-plausible with edit.", sources: [src("clean stems assumed for rehearsal")] },
        { criterion: "momentum_evidence", score: 2, score_confidence: "estimated", notes: "Sandbox note: no verified momentum in rehearsal.", sources: [src("no placements cited in rehearsal")] }
      ],
      deal_breakers: [
        { flag_id: "payola_adjacency", triggered: false, notes: "Sandbox: none observed." },
        { flag_id: "claimed_as_verified", triggered: false, notes: "Sandbox: none observed." },
        { flag_id: "rights_disputed", triggered: false, notes: "Sandbox: none observed." },
        { flag_id: "stream_inflation", triggered: false, notes: "Sandbox: none observed." },
        { flag_id: "no_verifiable_presence", triggered: false, notes: "Sandbox: rehearsal only." }
      ]
    };
  }

  $("do-deliver").onclick = function () {
    if (!needKey()) return;
    var artist = $("p-artist").value.trim() || "sandbox_artist";
    var rid = $("r-id").value.trim(), who = $("d-who").value.trim() || "sandbox_reviewer";
    var track = $("r-track").value.trim();
    try {
      var c = L().claimReview(rid, who, sandboxNow());
      var v = cannedVerdict(artist, track);
      var d = L().deliverReview(rid, who, v, sandboxNow());
      var s = L().settlementPaid(who, 50, sandboxNow(), "SIMULATED settlement $0.50 → " + who + ". " + MEMO);
      ok($("d-out"), "Simulated delivery: verdict ACCEPTED by the production validator (5 criteria, confidence caps, citations, deal-breakers all enforced), escrow → reviewer_owed $0.50 + CWI $0.50, SIMULATED settlement $0.50 → " + who +
        ". Entries " + c.id + ", " + d.id + ", " + s.id);
      showReceipt($("d-out"), c); showReceipt($("d-out"), d); showReceipt($("d-out"), s);
      renderLog();
    } catch (err) { bad($("d-out"), "REJECTED: " + err.message); }
  };

  $("do-refund").onclick = function () {
    if (!needKey()) return;
    var artist = $("p-artist").value.trim() || "sandbox_artist";
    var rid = "sb_rev_refund_" + randHex(3);
    try {
      var q = L().requestReview(artist, rid, "Sandbox Refund Track", null, sandboxNow());
      clockOffsetMs += 73 * 3600 * 1000; // advance the sandbox clock past the 72h window
      var r = L().refund(rid, sandboxNow(), "sandbox rehearsal: 73h elapsed, no review. " + MEMO);
      ok($("f-out"), "Simulated refund: " + rid + " requested, clock +73h, escrow → artist. Balance: $" +
        bal(artist) + " TEST. Entries " + q.id + ", " + r.id);
      showReceipt($("f-out"), q); showReceipt($("f-out"), r);
      renderLog();
    } catch (err) { bad($("f-out"), "REJECTED: " + err.message); }
  };

  $("dl").onclick = function () {
    var blob = new Blob([mem.lines.join("\n") + "\n"], { type: "application/x-ndjson" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "booth-sandbox-receipts.jsonl";
    a.click();
  };

  $("verify").onclick = function () {
    try {
      var res = L().verify();
      if (res.ok) ok($("ledger-log"), "Chain verified: " + mem.lines.length + " sandbox entries, all hashes link.");
      else bad($("ledger-log"), "Chain BROKEN at entry " + res.broken_at);
    } catch (err) { bad($("ledger-log"), "Verify failed: " + err.message); }
  };
})();
