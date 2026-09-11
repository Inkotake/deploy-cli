# Provenance

This repository is a standalone extraction of the static-publishing CLI that shipped inside the
**Teacher DSH** desktop distribution, where it was `teacher-publish` (`@teacher-dsh/publish-cli`).

Naming history, so old references can be traced: `teacher-publish` (in the desktop product) →
`verified-publish` (the working name during extraction, and the name the first live probes ran under)
→ **`vpublish`** (the published name: shorter to type, and free on npm while `deploy-cli` — the
repository name — was already taken). Environment variables from both earlier names are still read as
fallbacks, and a `gh-pages` branch published under the old commit trailer `X-Verified-Publish` is
still recognised as ours rather than as a foreign branch.

## What came from where

| Part | Origin |
|---|---|
| Provider adapters (`src/providers/*`) and the measured provider contract (`docs/provider-protocols.md`) | The Teacher DSH publish CLI, whose anonymous-provider protocols were measured against the live services (recorded as `verification.verifiedAt: 2026-09-10`). The measurements were carried over unchanged: editing them would falsify evidence rather than refactor code. |
| Verification, planning, inspection, health/breaker and archive/HTTP helpers | Same origin. The verification semantics (`filesExpected` vs `filesRequired`, `htmlExact`, `browserVerified: false`) are unchanged; the note now states explicitly when a comparison was partial. |
| Teacher-specific safety rules | Split out of the core into `src/policies/teacher.mjs`, so the general-purpose default does not assume that every `results.csv` is a gradebook. |
| Everything else in this repository | Written for the extraction: the identity module, the policy engine, claim storage, upload snapshots, the proxy layer, the region semantics, the GitHub Pages hardening, the JSON contract version, the test suite and the documentation. |

## Licence

The original code is MIT, `Copyright (c) 2026 Anywhere Labs`. That notice is retained in `LICENSE`
alongside the contributors line, as the licence requires.

## Compatibility with the original distribution

- The legacy environment variables (`TEACHER_DSH_HOME`, `TEACHER_DEPLOY_HOME`, `TEACHER_DEPLOY_BIN`,
  `TEACHER_PUBLISH_REGISTRY`, `TEACHER_PUBLISH_STATUS_FILE`) are still read as fallbacks, so a
  distribution that consumed the old names keeps working while it migrates.
- The original command name is not kept here. A consuming product should publish its own alias (for
  example a `teacher-publish` shim that forwards to `verified-publish --policy teacher`) rather than
  this repository carrying a product-specific name.
- The provider registry format changed: `capabilitySchema: 1` is now required, and capability fields
  moved into a structured `capabilities` object. A registry written for the old CLI is refused with a
  message naming both versions instead of being misread.
