# Provider capabilities (measured)

Every number below comes from a deployment made by this tool, not from a marketing page. Sources:
`research/capability-2026-09-13/` (one representative fixture per channel),
`research/anonymous-compliance/` (per-candidate contract and reader evidence) and
`research/reachability-*/` (two-egress reads). Where a provider document is the only source, that is said
so explicitly.

## The representative fixture

21 files: `index.html`, two assets, a `.woff2` font, a `.glb` model, a `.wasm` module, a CJK directory
and file name (`中文/说明.txt`), a 60-character directory name, and twelve files in one directory.

| Channel | Result | HTML | CJK path | `.glb` / `.wasm` / `.woff2` |
|---|---|---|---|---|
| ship-page | 21/21 verified | byte-exact | ✅ | ✅ / ✅ / ✅ |
| shipstatic | 20/21 (page presence-checked) | rewritten by the host | ✅ | ✅ / ✅ / ✅ |
| aft-page | 20/21 (page presence-checked) | served as its own wrapper | ✅ | ✅ / ✅ / ✅ |
| here-now | 21/21 at deploy time | **injected a moment later** | ✅ | ✅ / ✅ / ✅ |
| show | refused for this fixture | — | — | ❌ 400 / ❌ 400 / ✅ |
| dropley | refused for this fixture | — | — | ❌ / ❌ / ✅ |
| flypod | refused for this fixture | injected render instrumentation | **❌ 404 in every encoding** | ✅ / ✅ / ✅ |
| BrewPage | refused for this fixture | injected top bar | (not reached) | ❌ 422 / ❌ 422 / ✅ |
| shiply.now | 20/21 (page presence-checked) | claim banner, as documented | ✅ | ✅ / ✅ / ✅ |

The three refusals are the planner working as intended: it now declines those artifacts *before*
uploading, because the registry records the measured rule rather than a guess. The provider's own error
is quoted in each registry entry (`422 File type '.glb' is not allowed` for BrewPage, `400` for show,
a server-side allowlist rejection for dropley, and a 404-after-accept for flypod's CJK path).

## Quick-share channels at a glance

| Channel | Upload | Per file | Files | Total | Lifetime | Reader gets | Claim |
|---|---|---|---|---|---|---|---|
| ship-page | zip POST | – | 100 | 25 MB | 30 days | your exact bytes | `claim_token` |
| shipstatic | multipart | 20 MB | 500 | 50 MB | 3 days | rewritten page | `claim_url` |
| aft-page | multipart | 25 MB | 500 | 100 MB | 30 days | provider wrapper | token + url |
| here-now | 3-step presigned | 250 MB | 1000 | – | 24 hours | injected page | token + url |
| show | tar.gz | – | 100 | 10 MB | 48 hours | your exact bytes | – |
| dropley | multipart manifest | – | 1000 | 50 MB | 7 days | your exact bytes | `artifact_token` |
| flypod | raw zip POST | – | – | – | 14 days | injected page | `claim_token` |
| BrewPage | multipart archive | 5 MB | 100 | 20 MB | 15 days (30 max) | injected top bar | `ownerToken` |
| shiply.now | 3-step manifest | 100 MB | 2000 | 2 GB | 24 hours | claim banner | `claim_token` |
| ht-ml.app | JSON single page | – | 1 | – | not returned | your exact page | `update_key` |
| meethtml | JSON single page | 5 MB | 1 | – | 24 hours | your exact page | `edit_token` |
| Display.dev | multipart single page | 50 MB | 1 | – | 0–30 days (documented) | provider viewer | `claim_url` |
| shippage.ai | JSON single page | 500 KB | 1 | – | 14 days | rendered at `/p/<slug>` | none exposed |

Lifetimes are read from the provider's response whenever it sends one; "not returned" means the response
carried no expiry and the tool does not invent one.

## Choosing one

- **A site you want to keep for a month, hosted from mainland China**: `ship-page` — 30 days, your exact
  bytes, 25 MB, no account.
- **Something big** (models, video, many files): `shiply.now` — 100 MB per file and 2 GB total, but 24
  hours until claimed.
- **One page** you want served byte-for-byte: `meethtml` (24 hours) or `ht-ml.app` (no expiry returned).
- **A quick look, no claim needed**: `show` or `dropley`.
- **Never** rely on `shipstatic`, `aft-page`, `here-now`, `flypod`, `BrewPage` or `shippage.ai` for
  byte-exact delivery: each adds its own banner, viewer or instrumentation, and the tool reports that
  rather than hiding it.

## What is still unmeasured

- **Limits above the fixture**: file counts and totals are taken from each provider's documentation where
  the registry says so, and were not pushed to the limit. Only the *behaviour* on a realistic artifact was
  measured.
- **Mainland reachability**: measured from one Beijing datacenter egress plus one overseas egress; that is
  not a three-carrier or campus-network measurement.
- **The single-page channels**: only the document was tested, because that is all they accept; referenced
  assets are reported as left behind rather than uploaded.
