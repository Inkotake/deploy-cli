# Anonymous provider re-probe — 2026-09-13

Produced by `node tools/probe-contracts.mjs`. Purpose: refresh the live evidence behind the six
implemented anonymous adapters, and record the numbers the registry claims.

## Results

| Provider | Endpoint answer | Lifetime observed | Ownership field | Notes |
|---|---|---|---|---|
| ship.page | `POST /deploy` (zip) → 200 | `expires_at` 2026-10-13 (**30 days**) | `claim_token` (`spc_…`) | The response is the authority: the provider's own pages disagree with each other (7 days vs 30 days), which is why the tool never hardcodes a TTL. |
| ShipStatic | `POST /deployments` → 201 | `expires` = created + 259200 s (**3 days**) | claim URL | The multipart part **must** be named `files[]`; sending `files` returns `400 validation_failed` ("Files count (0) must match checksums count (1)"). |
| aft.page | `POST /v1/deploy` → 200 | not returned | `editToken` + `claimUrl` | Served `index.html` as **9439 bytes for an 86-byte upload** — it serves its own wrapper page, so it stays excluded from the default plan. |
| here.now | create → presigned upload → finalize, all OK | `expiresAt` 2026-09-14 (**24 hours**) | `claimToken` + `claimUrl` | The minimal probe page was served **verbatim** (86 → 86 bytes) again, so its HTML rewriting is conditional; the `presence-only` policy stays conservative. |
| show | `POST /upload` (tar.gz) → 200 | `expiresAt` 2026-09-15 (**48 hours**) | none | URL shape `<id>-<name>.127.dev` confirmed. |
| Dropley | `POST /api/artifacts` → 201 | `expiresAt` 2026-09-20 (**7 days**) | `artifactToken` | Still the experimental one: its server-side extension allowlist rejects common build output (fonts, extensionless files). |

## What this changes

- **Contracts: nothing.** Every endpoint, lifetime and ownership field matched what the registry
  already documented, so no adapter or capability needed editing.
- **Confidence: refreshed.** `verification.verifiedAt` for these six moves to 2026-09-13, and the
  notes keep their original measurements plus this date.
- **Still open from the goal's first item:** running each provider through *this tool* end to end
  (deploy → fetch back → per-resource SHA-256) so that `contentExpiresAt`, `claimDeadline` and
  `previewAccessExpiresAt` in the receipt carry values read from real responses rather than `null`.
  The protocol layer is verified; the receipt clocks are the next round's subject.

## Provenance

Raw tool output is not persisted by `tools/probe-contracts.mjs`; the numbers above are transcribed
from that run on 2026-09-13. Re-running the tool is the way to re-check them, and a disagreement
between this file and a future run means this file is out of date — the live service wins.
