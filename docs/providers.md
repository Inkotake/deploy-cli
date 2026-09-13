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

## Measured limits (2026-09-13)

A second fixture — `index.html`, one asset and **100 files in one directory** (102 files, ~2 KB total) —
was deployed to every directory-capable channel, so the tool verified each file individually. The
question was not "does it accept this" but **"does it serve every file it accepted"**:

| Channel | Documented cap | Result |
|---|---|---|
| ship-page | 100 files | refused **before upload**: "accepts at most 100 files, artifact has 102" |
| show | 100 files | refused before upload, same clear message |
| BrewPage | 100 files | refused before upload, same clear message |
| shipstatic | 500 files | **102/102 verified**, no silent drops |
| aft-page | 500 files | 101/102 verified (the page itself is presence-checked) |
| flypod | not documented | 101/102 verified (page injected by the host) |
| shiply.now | 2000 files | 101/102 verified (claim banner) |
| dropley | 1000 files | **refused**: `File type not allowed: many/f001.txt` |
| here-now | 1000 files | first attempt: `HTTP 502 Application failed to respond` at finalize; **two retries both succeeded, 102/102 verified** (97 s and 120 s) |

What this establishes:

- **No channel silently dropped a file.** Every difference between "verified" and the file count is
  explained by a host that rewrites the page: that file is presence-checked, never counted as a hash.
- **The three 100-file channels enforce their cap honestly**, refusing the artifact up front instead of
  truncating it.
- **dropley cannot host a typical build**: it rejects `.txt`, so a build containing `robots.txt` fails
  outright, on top of the already-recorded rejection of fonts, `.glb`, `.wasm` and extensionless files.
- **here-now is the slowest and least predictable** of the set: 97–120 s for 102 tiny files and one
  transient 502 that two retries cleared. It is not a limit, but it is a reason not to make it a default.

## The default

`ship-page` is the default choice, and that is a measured decision rather than a preference: a 30-day
lifetime, byte-exact HTML and assets, 25 MB total, a 100-file cap that is enforced with a clear message,
mainland reachability from both egresses, and no account required. A test asserts that it still ranks
first, so re-ranking it has to argue with evidence.

## What is still unmeasured

- **Limits above the fixture**: file counts and totals are taken from each provider's documentation where
  the registry says so, and were not pushed to the limit. Only the *behaviour* on a realistic artifact was
  measured.
- **Mainland reachability**: measured from one Beijing datacenter egress plus one overseas egress; that is
  not a three-carrier or campus-network measurement.
- **The single-page channels**: only the document was tested, because that is all they accept; referenced
  assets are reported as left behind rather than uploaded.
