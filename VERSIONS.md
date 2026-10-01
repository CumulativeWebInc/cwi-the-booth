# API Versions — cwi-the-booth sandbox

Stripe-style date versioning (OPERATION BEST lane A8). The sandbox is a
static browser demo (no server), so the pin is a `cwi_version` **field** in
the machine-readable config `sandbox/first-spin.json` rather than an HTTP
header. Unknown pins resolve to the current version — additive only, never
a breaking change.

## Versions| CWI-Version | Status  | Notes |
|-------------|---------|-------|
| 2026-10-01  | current | Initial date-versioned release. Behavior = the A1+A2 sandbox (test mode): production ledger-core.js against an in-memory throwaway ledger; memos stamped "SANDBOX TEST"; no real money; sessionStorage only. |

© 2026 Cumulative Web Inc. All rights reserved.
