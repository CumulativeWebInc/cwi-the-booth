// © 2026 Cumulative Web Inc. All rights reserved. (cumulativeweb.com)
// A6 — Royalty-advance estimator core.
// Algorithm mirrors /tmp-era back-test (backtest.py) EXACTLY; parity is
// tested in Node (see tests in the task log). UMD: browser + Node.
//
// Method (published on the page — royalty-advance-empirical-80/v1):
//   1. Fit an ordinary least-squares trend on the trailing monthly earnings.
//   2. Predict the next 12 months (floored at $0), sum them.
//   3. Advance point = ADVANCE_RATIO (default 0.6, editable) × predicted total.
//   4. Interval = point × (1 ± Q), where Q is the empirical 80th-percentile
//      of |relative residual| from walk-forward back-testing (backtest.json).
// All outputs are labeled ESTIMATE/SAMPLE. Not an offer.
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.AdvanceEstimator = factory(); }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var METHOD_ID = "royalty-advance-empirical-80/v1";
  var NOMINAL_COVERAGE = 0.80;

  function fitOLS(y) {
    var n = y.length, i;
    var sx = 0, sxx = 0, sy = 0, sxy = 0;
    for (i = 0; i < n; i++) { sx += i; sxx += i * i; sy += y[i]; sxy += i * y[i]; }
    var denom = n * sxx - sx * sx;
    var b = denom ? (n * sxy - sx * sy) / denom : 0;
    var a = (sy - b * sx) / n;
    return { intercept: a, slope: b };
  }

  function predictMonths(y, k) {
    var f = fitOLS(y), n = y.length, out = [], j, v;
    for (j = 1; j <= k; j++) {
      v = f.intercept + f.slope * (n - 1 + j);
      out.push(v < 0 ? 0 : v);
    }
    return out;
  }

  // monthly: array of 12 trailing monthly earnings (USD). opts: {ratio, q}
  function estimate(monthly, opts) {
    opts = opts || {};
    var ratio = (typeof opts.ratio === "number") ? opts.ratio : 0.6;
    var q = (typeof opts.q === "number") ? opts.q : 0.2056; // q80 full-sample, backtest.json
    if (!Array.isArray(monthly) || monthly.length < 3)
      throw new Error("need at least 3 monthly earnings figures");
    monthly.forEach(function (v) {
      if (typeof v !== "number" || isNaN(v) || v < 0)
        throw new Error("monthly earnings must be non-negative numbers");
    });
    if (!(ratio > 0) || ratio > 1) throw new Error("advance ratio must be in (0, 1]");
    var preds = predictMonths(monthly, 12);
    var predTotal = preds.reduce(function (s, v) { return s + v; }, 0);
    var point = ratio * predTotal;
    return {
      label: "ESTIMATE",
      sample: "SAMPLE",
      method_id: METHOD_ID,
      nominal_coverage: NOMINAL_COVERAGE,
      advance_ratio: ratio,
      q80: q,
      predicted_next_12mo_royalties_usd: round2(predTotal),
      advance_point_usd: round2(point),
      advance_low_usd: round2(point * (1 - q)),
      advance_high_usd: round2(point * (1 + q)),
      monthly_predictions_usd: preds.map(round2)
    };
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  // Streams shortcut: last-12-month streams × per-stream $ → flat monthly series.
  // Labeled assumption: flat monthly shape is a modeling assumption, not data.
  function fromStreams(streams12mo, perStreamUsd) {
    if (!(streams12mo >= 0) || !(perStreamUsd > 0))
      throw new Error("streams must be >= 0 and per-stream $ must be > 0");
    var monthly = (streams12mo * perStreamUsd) / 12;
    var series = []; for (var i = 0; i < 12; i++) series.push(round2(monthly));
    return { series: series, assumption: "flat monthly shape (streams/12)" };
  }

  return {
    estimate: estimate, fitOLS: fitOLS, predictMonths: predictMonths,
    fromStreams: fromStreams, METHOD_ID: METHOD_ID, NOMINAL_COVERAGE: NOMINAL_COVERAGE
  };
}));
