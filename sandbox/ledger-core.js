// © 2026 Cumulative Web Inc. All rights reserved. (cumulativeweb.com)
/**
 * THE BOOTH — credits ledger core.
 *
 * One rulebook, two runtimes: this file is written UMD so the SAME
 * enforcement code runs in the Node CLI and in the static browser UI.
 * No drift between "what the operator runs" and "what the demo shows."
 *
 * Money model (integer cents, never floats):
 *   1 credit = $1 = 100c.
 *   purchase:        artist balance +N credits
 *   review request:  1 credit artist -> escrow (72h listen deadline starts)
 *   review delivered: escrow -> reviewer_owed 50c + cwi_spread 50c
 *   refund (72h, no review): escrow -> artist
 *   settlement:      reviewer_owed -> reviewer_paid (manual, operator records)
 *
 * Enforcement (every mutation path):
 *   - append-only JSONL; each entry hash-chained (sha256 over prev_hash + body)
 *   - double-entry: every entry's debits == credits (invariant check)
 *   - no negative artist balances (can't spend what you don't have)
 *   - no double-spend: each review_id exists at most once in requested state
 *   - refund ONLY if review NOT delivered AND ts >= requested_at + 72h
 *   - delivery REQUIRES a valid First Spin verdict (format
 *     first-spin-verdict/v1): 5 criteria, integer scores 0-5, confidence
 *     labels in-vocabulary, >=1 cited source per score, confidence caps
 *     enforced (estimated<=3, unaverifiable<=1), all 5 deal-breakers evaluated,
 *     band math must match the rubric weights.
 *
 * Concurrent writers: single-operator MVP. Appends use O_APPEND (atomic for
 * small writes on POSIX). If two operators ever run concurrently, add a lock
 * file before extending — noted, not pretended away.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("crypto"), require("fs"), require("path"));
  } else {
    root.BoothLedger = factory(root.__boothCryptoShim || null, null, null);
  }
}(typeof self !== "undefined" ? self : this, function (crypto, fs, path) {

  var CREDIT_CENTS = 100;
  var REVIEWER_CUT = 50;
  var CWI_CUT = 50;
  var REFUND_WINDOW_MS = 72 * 3600 * 1000;
  var CONFIDENCE_LABELS = ["verified", "derived", "estimated", "unverifiable"];

  function sha256hex(s) {
    if (crypto && crypto.createHash) return crypto.createHash("sha256").update(s, "utf8").digest("hex");
    throw new Error("sha256 unavailable in this runtime");
  }

  function nowISO() { return new Date().toISOString(); }

  function entryHash(prevHash, body) {
    return sha256hex(prevHash + "\n" + JSON.stringify(body));
  }

  function err(msg) { var e = new Error(msg); e.booth = true; return e; }

  // ---- verdict validation (First Spin) ------------------------------------
  function validateVerdict(v, rubric) {
    if (!v || typeof v !== "object") throw err("verdict must be an object");
    if (v.format !== "first-spin-verdict/v1") throw err("verdict.format must be first-spin-verdict/v1");
    if (!rubric || !Array.isArray(rubric.criteria) || rubric.criteria.length !== 5)
      throw err("rubric must carry exactly 5 criteria");
    var weight = {}, i, c;
    for (i = 0; i < rubric.criteria.length; i++) {
      c = rubric.criteria[i];
      if (typeof c.weight !== "number") throw err("rubric criterion missing weight: " + c.id);
      weight[c.id] = c.weight;
    }
    if (!Array.isArray(v.scores) || v.scores.length !== 5)
      throw err("verdict must carry exactly 5 criterion scores");
    var total = 0, seen = {};
    for (i = 0; i < v.scores.length; i++) {
      var s = v.scores[i];
      if (!(s.criterion in weight)) throw err("unknown criterion: " + s.criterion);
      if (seen[s.criterion]) throw err("duplicate criterion score: " + s.criterion);
      seen[s.criterion] = true;
      if (!Number.isInteger(s.score) || s.score < 0 || s.score > 5)
        throw err("score must be integer 0-5 for " + s.criterion);
      if (CONFIDENCE_LABELS.indexOf(s.score_confidence) === -1)
        throw err("score_confidence out of vocabulary for " + s.criterion + ": " + s.score_confidence);
      // confidence caps (honest-by-construction)
      if (s.score_confidence === "estimated" && s.score > 3)
        throw err("estimated confidence caps score at 3 for " + s.criterion);
      if (s.score_confidence === "unverifiable" && s.score > 1)
        throw err("unverifiable confidence caps score at 1 for " + s.criterion);
      if (!Array.isArray(s.sources) || s.sources.length < 1)
        throw err("every score needs >=1 cited source (" + s.criterion + ")");
      for (var j = 0; j < s.sources.length; j++) {
        var src = s.sources[j];
        if (!src.fact || !src.observed || !src.url)
          throw err("source needs fact + observed + url (" + s.criterion + ")");
      }
      if (!s.notes) throw err("every score needs notes (" + s.criterion + ")");
      total += s.score * weight[s.criterion];
    }
    if (!Array.isArray(v.deal_breakers) || v.deal_breakers.length !== 5)
      throw err("verdict must evaluate all 5 deal-breakers");
    var rightsDisputed = false, noPresence = false, anyTriggered = false;
    for (i = 0; i < v.deal_breakers.length; i++) {
      var d = v.deal_breakers[i];
      if (typeof d.triggered !== "boolean" || !d.flag_id || !d.notes)
        throw err("deal-breaker needs flag_id + triggered + notes");
      if (d.triggered) {
        anyTriggered = true;
        if (d.flag_id === "rights_disputed") rightsDisputed = true;
        if (d.flag_id === "no_verifiable_presence") noPresence = true;
      }
    }
    var percent = Math.round(total * 20 * 100) / 100;
    var band = percent >= 90 ? "sign" : percent >= 75 ? "advance" : percent >= 50 ? "develop" : "pass";
    if (anyTriggered) band = (rightsDisputed || noPresence) ? "pass" : "develop"; // rubric auto-cap
    // declared math must match computed math (within rounding)
    if (typeof v.weighted_percent === "number" && Math.abs(v.weighted_percent - percent) > 0.01)
      throw err("declared weighted_percent does not match scores");
    if (v.band && v.band !== band) throw err("declared band does not match scores/caps");
    if (!v.summary) throw err("verdict needs a summary");
    if (!v.evaluated_by || !v.evaluation_date) throw err("verdict needs evaluated_by + evaluation_date");
    if (!v.subject || !v.subject.artist || !v.subject.track) throw err("verdict needs subject.artist + subject.track");
    return { weighted_total: Math.round(total * 100) / 100, weighted_percent: percent, band: band };
  }

  // ---- ledger state (replay) ------------------------------------------------
  function emptyState() {
    return {
      balances: {},        // account -> cents (signed)
      reviews: {},         // review_id -> {artist, status, requested_at, deadline, reviewer, verdict_summary}
      settled: {},         // reviewer -> cents paid out
      seq: 0, prevHash: "GENESIS"
    };
  }

  function applyEntry(st, e) {
    st.seq = e.seq;
    st.prevHash = e.hash;
    var t = e.type, p = e.postings || [];
    // balance convention: credits increase an account, debits decrease it.
    // (artist balances, escrow holds, reviewer_owed, cwi_spread all read positive.)
    function post(acct, delta) { st.balances[acct] = (st.balances[acct] || 0) + delta; }
    p.forEach(function (x) {
      if (x.debit) post(x.account, -x.debit);
      if (x.credit) post(x.account, x.credit);
    });
    var r = e.review_id ? st.reviews[e.review_id] : null;
    if (t === "review_requested") {
      st.reviews[e.review_id] = {
        artist: e.artist, track: e.track, spotify_url: e.spotify_url || null,
        status: "requested", requested_at: e.ts, deadline: e.ts + REFUND_WINDOW_MS,
        reviewer: null, verdict: null
      };
    } else if (t === "review_claimed" && r) { r.status = "claimed"; r.reviewer = e.reviewer; }
    else if (t === "review_delivered" && r) {
      r.status = "delivered"; r.delivered_at = e.ts; r.verdict = e.verdict_summary;
    }
    else if (t === "refund_issued" && r) { r.status = "refunded"; r.refunded_at = e.ts; }
    return st;
  }

  function checkEntryBalanced(e) {
    var d = 0, c = 0;
    (e.postings || []).forEach(function (x) { d += x.debit || 0; c += x.credit || 0; });
    if (d !== c) throw err("entry " + e.id + " not double-entry balanced: debit " + d + " != credit " + c);
    // review_claimed moves no money — it is a state transition, not a posting.
    if (d <= 0 && e.type !== "review_claimed") throw err("entry " + e.id + " posts nothing");
  }

  // ---- store ---------------------------------------------------------------
  // Node: JSONL file store. Browser: pass a custom store {read(), append(line)}.
  function fileStore(file) {
    return {
      read: function () {
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, "utf8").split("\n").filter(function (l) { return l.trim(); });
      },
      append: function (line) { fs.appendFileSync(file, line + "\n", { encoding: "utf8" }); }
    };
  }

  function Ledger(store, rubric) {
    this.store = store;
    this.rubric = rubric;
  }

  Ledger.prototype.replay = function (uptoSeq) {
    var st = emptyState(), self = this;
    this.store.read().forEach(function (line) {
      var e = JSON.parse(line);
      if (uptoSeq && e.seq > uptoSeq) return;
      self._checkHash(e, st.prevHash);
      checkEntryBalanced(e);
      applyEntry(st, e);
    });
    return st;
  };

  Ledger.prototype._checkHash = function (e, expectedPrev) {
    if (e.prev_hash !== expectedPrev) throw err("hash chain broken at entry " + e.id);
    var body = {};
    Object.keys(e).forEach(function (k) { if (k !== "hash") body[k] = e[k]; });
    if (entryHash(e.prev_hash, body) !== e.hash) throw err("entry hash mismatch: " + e.id);
  };

  Ledger.prototype.verify = function () {
    var st = this.replay();
    // re-enforce legality of every entry in order (full audit)
    var st2 = emptyState(), self = this, lines = this.store.read();
    lines.forEach(function (line) {
      var e = JSON.parse(line);
      self._checkHash(e, st2.prevHash);
      checkEntryBalanced(e);
      self._legal(st2, e);
      applyEntry(st2, e);
    });
    return { entries: lines.length, ok: true, state: st };
  };

  // legality of a single entry against current state (used pre-append + in verify)
  Ledger.prototype._legal = function (st, e) {
    var t = e.type, bal = function (a) { return st.balances[a] || 0; };
    if (t === "credit_purchase") {
      if (!Number.isInteger(e.amount_cents) || e.amount_cents <= 0 || e.amount_cents % CREDIT_CENTS !== 0)
        throw err("purchase must be a positive whole number of $1 credits");
    } else if (t === "review_requested") {
      if (st.reviews[e.review_id]) throw err("double-spend: review_id already used: " + e.review_id);
      if (bal("artist:" + e.artist) < CREDIT_CENTS)
        throw err("insufficient credits: artist " + e.artist + " has " + bal("artist:" + e.artist) + "c");
      if (!e.track) throw err("review request needs a track title");
    } else if (t === "review_claimed") {
      var r = st.reviews[e.review_id];
      if (!r) throw err("unknown review: " + e.review_id);
      if (r.status !== "requested") throw err("review " + e.review_id + " is " + r.status + ", cannot claim");
      if (!e.reviewer) throw err("claim needs a reviewer id");
    } else if (t === "review_delivered") {
      var r2 = st.reviews[e.review_id];
      if (!r2) throw err("unknown review: " + e.review_id);
      if (r2.status !== "claimed") throw err("review " + e.review_id + " is " + r2.status + ", cannot deliver");
      if (!e.reviewer || e.reviewer !== r2.reviewer) throw err("deliverer must be the claiming reviewer");
      if (bal("escrow:" + e.review_id) < CREDIT_CENTS) throw err("escrow empty for " + e.review_id);
      var calc = validateVerdict(e.verdict, this.rubric); // throws on any invalid verdict
      e.verdict_summary = {
        weighted_percent: calc.weighted_percent, band: calc.band,
        artist: e.verdict.subject.artist, track: e.verdict.subject.track,
        evaluated_by: e.verdict.evaluated_by
      };
    } else if (t === "refund_issued") {
      var r3 = st.reviews[e.review_id];
      if (!r3) throw err("unknown review: " + e.review_id);
      if (r3.status === "delivered") throw err("review delivered — no refund");
      if (r3.status === "refunded") throw err("already refunded");
      if (e.ts < r3.deadline)
        throw err("refund window not open: 72h deadline is " + new Date(r3.deadline).toISOString());
      if (bal("escrow:" + e.review_id) < CREDIT_CENTS) throw err("escrow empty for " + e.review_id);
    } else if (t === "settlement_paid") {
      if (bal("reviewer_owed:" + e.reviewer) < e.amount_cents)
        throw err("reviewer " + e.reviewer + " is owed less than " + e.amount_cents + "c");
      if (!Number.isInteger(e.amount_cents) || e.amount_cents <= 0)
        throw err("settlement amount must be positive integer cents");
    } else {
      throw err("unknown entry type: " + t);
    }
  };

  Ledger.prototype._append = function (spec) {
    var st = this.replay();
    var e = {
      seq: st.seq + 1,
      id: "e" + (st.seq + 1) + "_" + sha256hex(nowISO() + Math.random()).slice(0, 8),
      ts: spec.at ? Date.parse(spec.at) : Date.now(),
      prev_hash: st.prevHash
    };
    ["type", "artist", "reviewer", "review_id", "track", "spotify_url", "amount_cents", "verdict", "memo", "verdict_summary"]
      .forEach(function (k) { if (spec[k] !== undefined) e[k] = spec[k]; });
    if (isNaN(e.ts)) throw err("bad timestamp: " + spec.at);
    e.postings = spec.postings;
    this._legal(st, e);              // enforce BEFORE writing — illegal entries never touch the file
    var body = {};
    Object.keys(e).forEach(function (k) { if (k !== "hash") body[k] = e[k]; });
    e.hash = entryHash(e.prev_hash, body);
    this.store.append(JSON.stringify(e));
    return e;
  };

  // ---- public operations -----------------------------------------------------
  Ledger.prototype.purchase = function (artist, credits, at, memo) {
    return this._append({
      type: "credit_purchase", artist: artist, amount_cents: credits * CREDIT_CENTS,
      at: at, memo: memo || (credits + " credit(s) purchased @ $1"),
      postings: [
        { account: "cwi:unearned", debit: credits * CREDIT_CENTS },
        { account: "artist:" + artist, credit: credits * CREDIT_CENTS }
      ]
    });
  };

  Ledger.prototype.requestReview = function (artist, reviewId, track, spotifyUrl, at) {
    return this._append({
      type: "review_requested", artist: artist, review_id: reviewId,
      track: track, spotify_url: spotifyUrl || null, at: at,
      memo: "review requested: " + track,
      postings: [
        { account: "artist:" + artist, debit: CREDIT_CENTS },
        { account: "escrow:" + reviewId, credit: CREDIT_CENTS }
      ]
    });
  };

  Ledger.prototype.claimReview = function (reviewId, reviewer, at) {
    return this._append({
      type: "review_claimed", review_id: reviewId, reviewer: reviewer, at: at,
      memo: reviewer + " claimed " + reviewId, postings: []
    });
  };

  Ledger.prototype.deliverReview = function (reviewId, reviewer, verdict, at) {
    return this._append({
      type: "review_delivered", review_id: reviewId, reviewer: reviewer,
      verdict: verdict, at: at, memo: "verdict delivered: " + reviewId,
      postings: [
        { account: "escrow:" + reviewId, debit: CREDIT_CENTS },
        { account: "reviewer_owed:" + reviewer, credit: REVIEWER_CUT },
        { account: "cwi_spread", credit: CWI_CUT }
      ]
    });
  };

  Ledger.prototype.refund = function (reviewId, at, reason) {
    return this._append({
      type: "refund_issued", review_id: reviewId, at: at,
      memo: reason || "no review within 72h",
      postings: [
        { account: "escrow:" + reviewId, debit: CREDIT_CENTS },
        { account: "artist:" + (this.replay().reviews[reviewId] || {}).artist, credit: CREDIT_CENTS }
      ]
    });
  };

  Ledger.prototype.settlementPaid = function (reviewer, cents, at, memo) {
    return this._append({
      type: "settlement_paid", reviewer: reviewer, amount_cents: cents, at: at,
      memo: memo || ("manual payout to " + reviewer),
      postings: [
        { account: "reviewer_owed:" + reviewer, debit: cents },
        { account: "reviewer_paid:" + reviewer, credit: cents }
      ]
    });
  };

  // ---- reads ------------------------------------------------------------------
  Ledger.prototype.balance = function (account) {
    return this.replay().balances[account] || 0;
  };

  Ledger.prototype.queue = function () {
    var st = this.replay(), out = [];
    Object.keys(st.reviews).forEach(function (id) {
      var r = st.reviews[id];
      out.push({
        review_id: id, artist: r.artist, track: r.track, spotify_url: r.spotify_url,
        status: r.status, reviewer: r.reviewer,
        requested_at: new Date(r.requested_at).toISOString(),
        deadline: new Date(r.deadline).toISOString(),
        delivered_at: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
        verdict: r.verdict || null
      });
    });
    out.sort(function (a, b) { return a.requested_at < b.requested_at ? -1 : 1; });
    return out;
  };

  Ledger.prototype.settlementReport = function () {
    var st = this.replay(), owed = {}, paid = {};
    Object.keys(st.balances).forEach(function (a) {
      var m = a.match(/^reviewer_owed:(.+)$/);
      if (m && st.balances[a] > 0) owed[m[1]] = st.balances[a];
      var m2 = a.match(/^reviewer_paid:(.+)$/);
      if (m2 && st.balances[a] > 0) paid[m2[1]] = st.balances[a];
    });
    var totalOwed = Object.keys(owed).reduce(function (s, k) { return s + owed[k]; }, 0);
    return {
      owed_cents: owed, paid_cents: paid, total_owed_cents: totalOwed,
      cwi_spread_cents: st.balances["cwi_spread"] || 0,
      note: "MANUAL SETTLEMENT ONLY. No payment rail is wired. Black holds all payment keys; payouts are recorded here AFTER he executes them."
    };
  };

  return {
    Ledger: Ledger,
    fileStore: fs ? fileStore : null,
    validateVerdict: validateVerdict,
    CREDIT_CENTS: CREDIT_CENTS, REVIEWER_CUT: REVIEWER_CUT, CWI_CUT: CWI_CUT,
    REFUND_WINDOW_MS: REFUND_WINDOW_MS, CONFIDENCE_LABELS: CONFIDENCE_LABELS
  };
}));
