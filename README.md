# verified-publish

**Deploy a built static folder anywhere. Verify what actually went live. Fail over when the host doesn't.**

`verified-publish` is a static-publishing router for humans and agents. Point it at a `dist/` and it
inspects the artifact, chooses a host that can actually serve it, uploads it, fetches the files back
and compares them byte for byte, and only then reports a URL.

```text
dist/  →  inspect  →  choose a compatible host  →  upload  →  fetch it back  →  compare SHA-256  →  URL
```

An HTTP 2xx from an upload is a *candidate* success. Success is only reported after verification.

```console
$ verified-publish ./dist
Inspected 62 files (4.8 MiB), no blocked files
Publishing plan (quick-share, region auto)
  1. ship-page  score=10
Deployment verified.
  provider:  ship-page (temporary)
  url:       https://xxxx.shipped.page/
  expires:   2026-10-11T00:00:00.000Z
  verified:  62 of 62 required resources hash-matched by http-sha256
```

Machine-readable form, same run:

```console
$ verified-publish ./dist --json | jq '.verification.passed, .url'
true
"https://xxxx.shipped.page/"
```

## Install

```console
$ npx verified-publish ./dist
# or
$ npm install --global verified-publish
```

Node **22.2+** is the only requirement. The package has **zero dependencies** — no install step, no
`node_modules`, no post-install scripts — so it also runs straight from a tarball or an offline
bundle.

## What it does that a plain uploader does not

| | |
|---|---|
| **Capability matching** | A provider whose extension allowlist rejects `.glb` is *incompatible*, not merely lower priority. Limits (file count, per-file size, total size, model/`wasm` support) are enforced before anything is uploaded. |
| **Failover with a circuit breaker** | Compatible hosts are tried in order. A host that fails opens a breaker (DNS 24 h, unreachable 20 min, 5xx 10 min, rate limit 1 h, capability 24 h, integrity 6 h) so the next run does not hammer it. |
| **Pre-publish safety scan** | Credentials, private keys and sensitive directories are hard-blocked. Nothing is uploaded while a block is present. |
| **Post-publish byte verification** | Every deployed resource is fetched with GET and compared by SHA-256 against the local manifest. A byte difference, a 404, a wrong content type, an HTML fallback served for a `.js` file or a host error page is a failure. |
| **Private ownership credentials** | A claim token/URL is stored in the private state directory; it is never printed unless you ask with `--show-claim-secret`. |
| **A stable machine contract** | `--json` writes exactly one document to stdout (diagnostics go to stderr) and exit codes are documented. |
| **Immutable upload snapshot** | Providers driven through an external CLI or `git` publish from a hardlinked snapshot, so a rebuild between inspection and upload cannot go live unverified. |

## Commands

| Command | Purpose |
|---|---|
| `verified-publish [dir]` | Shorthand for `deploy [dir]`. |
| `detect [dir]` | Find the artifact, report the registry, project markers, git remote and tunnel tools. |
| `inspect [dir]` | Build the byte manifest, run the safety scan, list client-side routes and broken references. |
| `plan [dir] --mode <mode>` | Order the candidate providers for one mode and explain every decision. Contacts nothing. |
| `deploy [dir] --mode <mode>` | The only command that mutates remote state: upload, verify, report. |
| `verify <url> [dir]` | Re-compare a deployed URL against a local artifact without uploading. |
| `providers` | Print the registry (capabilities, status, breaker state, adapter availability). |
| `claim [list\|show [key]]` | Inspect stored ownership credentials. `show` hides the secret until `--reveal`. |
| `doctor [dir]` | One-shot environment report: runtime, state, policy, region, proxy, registry, providers. |
| `tunnel detect\|start` | Session-only localhost exposure through a tunnel tool that is already installed. Nothing is verified here. |

### Modes

| Mode | Behaviour |
|---|---|
| `quick-share` (default) | Anonymous temporary host. Failover between compatible hosts is allowed; the URL expires. |
| `persistent` | Account-owned durable host through your own `netlify` / `wrangler` / `vercel` CLI or `git`. **Never** silently downgraded to an anonymous host. |
| `tunnel` | Session-scoped localhost exposure. Explicitly not a deployment and never reported as verified. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Uploaded but not verified, or an unexpected error. |
| 2 | Usage error. |
| 3 | No static artifact found. |
| 4 | The safety scan hard-blocked a file. |
| 5 | The provider registry is unusable. |
| 6 | No eligible provider for the requested mode. |
| 7 | Verification failed. |
| 8 | Tunnel tools are unsupported on this machine. |
| 9 | No stored claim matches the requested key. |

## Flags worth knowing

| Flag | Meaning |
|---|---|
| `--json` | Exactly one JSON document on stdout; diagnostics on stderr. |
| `--policy <generic\|teacher>` | `generic` (default) blocks secrets. `teacher` additionally blocks student records, grades, rosters and family contact data — but only for files that can actually carry records. |
| `--region <auto\|cn-mainland\|global>` | `cn-mainland` puts region-reachable hosts ahead of higher-scoring ones; `auto` only breaks ties; `global` ignores the region priority. |
| `--verify-all` | Compare every file even above the 20 MiB fast-verification threshold. |
| `--dry-run` | Print the order and the payload; contact nothing. Exits 0 without claiming a deployment. |
| `--allow-inexact` | Also consider hosts that rewrite served HTML (ShipStatic, here.now, aft.page). Their HTML is presence-checked, everything else is still hash-compared. |
| `--no-verify` | Skip verification. The run can then never report success. |
| `--provider <id>` | Restrict the attempt to one provider. |
| `--proxy <url>` | Proxy provider requests (also honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`). |
| `--show-claim-secret` | Print the ownership credential instead of only storing it. |
| `--force-push`, `--branch <name>` | GitHub Pages: allow overwriting a branch this tool does not own, or publish to a different branch. |
| `--keep-snapshot` | Keep the upload snapshot and report its path. |

## What "verified" honestly means

Verification compares bytes, and it says exactly how far it got:

- At or below **20 MiB** every file is compared. Above it, `index.html`, every JS/CSS file, every
  `.glb`/`.gltf`/`.bin`/`.wasm` and the three largest remaining files are compared — unless you pass
  `--verify-all`. The result always carries `filesExpected` (all files) next to `filesRequired` (what
  this run compared), and the human note says the comparison was partial.
- HTML is compared byte for byte unless the host is known to rewrite it, in which case
  `htmlExact` is `false` and the paths that were only presence-checked are listed.
- The root document is requested **once more with browser-like headers**, because an edge network can
  inject its own markup for browsers while serving the uploaded bytes to a plain GET. Measured live:
  ship.page adds a Cloudflare Insights beacon for a browser-like `Accept` header (+367 bytes on a
  277-byte page). That answer is reported as `browserRepresentation` and in the human note. It does
  not fail the run — the artifact is served and a third party wrapped it — but it is never hidden.
- **No browser rendering is performed.** WebGL, module-execution and CORS failures are outside what
  this tool can prove, and it never claims otherwise (`browserVerified` is always `false`).
- A deployment whose verification cannot run is treated as **failed**, never as a success.

## Providers

Six anonymous hosts and four durable ones. Status comes from the registry, which records when each
claim was last measured.

| Provider | Mode | Verified status | HTML byte-exact | Anonymous lifetime |
|---|---|---|---|---|
| ship.page | quick-share | live-tested | yes | 30 days |
| ShipStatic | quick-share | live-tested | no (rewrites HTML) | 3 days |
| here.now | quick-share | live-tested | no (injects meta tags) | 24 hours |
| show | quick-share | live-tested | strict | 48 hours |
| aft.page | quick-share | live-tested | no (serves a wrapper page) | 30 days idle |
| Dropley | quick-share | unverified | strict | 1/3/7 days |
| Netlify | persistent | expected | yes | durable |
| Cloudflare Pages | persistent | expected | yes | durable |
| Vercel | persistent | expected | yes | durable |
| GitHub Pages | persistent | expected | yes | durable |

`expected` means the adapter implements the provider's documented CLI contract and only its failure
path has been exercised. Do not read it as measured. The registry is the source of truth:
`verified-publish providers --json` shows capabilities, `verification.status` and breaker state.

Persistent providers are driven by the CLI you already have (`netlify`, `wrangler`, `vercel`) or by
`git` for GitHub Pages. Nothing is installed for you; if the CLI is missing, the provider is reported
as unavailable rather than downloaded.

## Safety

- **Nothing is uploaded while the safety scan has a hard block**, in any mode.
- The `teacher` policy blocks student records, grades, rosters, attendance and family contact data
  **only** when the file can carry records (`.csv`, `.xlsx`, `.json`, `.pdf`, extensionless, …); a
  component named `grade-utils.js` is a warning, not a refusal.
- Ownership credentials are written to `claims.json` in the private state directory (mode `0600`
  where the filesystem supports it) and reported without their value. `verified-publish claim show`
  reveals one when you ask for it. Never forward a claim value or claim URL: holding it means owning
  the deployment.
- GitHub Pages is treated as shared state: a branch this tool does not own is **refused** rather than
  overwritten, a `CNAME` is carried over byte for byte, and our own pushes use
  `--force-with-lease` instead of `--force`.
- Provider URLs are taken from the response and checked against the registry's host allowlist: a URL
  is never derived from a naming convention.

## State and environment

| Variable | Effect |
|---|---|
| `VERIFIED_PUBLISH_HOME` | State directory (health cache, claims). Defaults to `~/.verified-publish`. |
| `VERIFIED_PUBLISH_REGISTRY` | Use a different provider registry file. |
| `VERIFIED_PUBLISH_STATUS_FILE` | Local availability overlay (may only change `enabled`, `priority`, `health`, `lastValidated`, `notes`). |
| `VERIFIED_PUBLISH_POLICY`, `VERIFIED_PUBLISH_REGION` | Defaults for `--policy` and `--region`. |
| `VERIFIED_PUBLISH_DEPLOY_HOME`, `VERIFIED_PUBLISH_DEPLOY_BIN` | Where to look for `netlify`/`wrangler`/`vercel` before falling back to `PATH`. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Standard proxy variables, honoured by every request. |

Legacy names from the project this was extracted from (`TEACHER_DSH_HOME`, `TEACHER_DEPLOY_HOME`,
`TEACHER_PUBLISH_REGISTRY`, `TEACHER_PUBLISH_STATUS_FILE`) are still read as fallbacks.

## JSON contract

Every `--json` payload starts with:

```json
{ "schemaVersion": 1, "command": "deploy", "...": "command-specific fields" }
```

`deploy` reports `success`, `provider`, `url`, `mode`, `persistence`, `expiresAt`, `claim`,
`snapshot`, `verification` and `attempts` on success, and `provider`, `reason`, `nextAction`,
`artifactOk` and `attempts` on failure — so a failure is as machine-readable as a success.

## Development

```console
$ npm test                 # unit + integration tests (node:test, no network)
$ node tools/smoke.mjs      # command surface, --json discipline and exit codes
$ node tools/check-imports.mjs   # proves the package still has no dependencies
$ node tools/probe-contracts.mjs # maintainers only: re-measure the live anonymous providers
```

The test suite covers the provider adapters, verification, planning, the registry schema, the policy
split, claim handling, the upload snapshot, the proxy path and the CLI contract. Nothing in `npm test`
touches the network: fake providers run on `127.0.0.1`.

## Status

Honest list of what is **not** verified yet:

- **Persistent success paths** (Netlify, Cloudflare Pages, Vercel, GitHub Pages) have not been run
  against live authenticated accounts. Only their failure paths were exercised.
- The anonymous providers were measured on **2026-09-10** and re-probed live on **2026-09-11**: all
  six responded, endpoints and lifetimes matched the registry, and a real deployment to ship.page was
  verified 4/4 (see `docs/evidence/live-probe-2026-09-11.md`). Hosts change — re-run
  `tools/probe-contracts.mjs` before trusting an old registry entry.
- **No browser rendering** is performed by design.
- Tunnel relays are a convenience, not a supported publishing path; the SSH-based ones are marked
  experimental.

## Provenance and licence

Extracted from the Teacher DSH desktop distribution (MIT). See `docs/provenance.md` for what came
from where, and `docs/provider-protocols.md` for the measured provider contract this tool implements.

MIT — see `LICENSE`.
