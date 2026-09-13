# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-11

First release of the standalone tool, extracted from the Teacher DSH desktop distribution. Published
as `vpublish`; see the naming history in `docs/provenance.md`.

**Distribution status: source only.** This version is on GitHub
([`Inkotake/deploy-cli`](https://github.com/Inkotake/deploy-cli)) and installable from a clone, but it
is **not on npm yet**: the registry refuses a non-interactive publish without a 2FA-capable
credential (`403 … Two-factor authentication or granular access token with bypass 2fa enabled is
required`). `docs/releasing.md` records both ways to finish that step.

### Added

- `deploy`, `inspect`, `plan`, `verify`, `detect`, `providers`, `claim`, `doctor` and `tunnel`
  commands, plus `vpublish <dir>` as shorthand for `deploy <dir>`.
- Capability-aware provider planning: extension allowlists and blocklists, file-count, per-file and
  total-size limits, model/`wasm` support and HTML-rewrite behaviour are enforced **before** upload.
- Documented layout limits are enforced too: `capabilities.maxDirectoryDepth` and `maxPathLength`
  (Dropley publishes 5 directory levels and 255-character paths) are measured by `inspect`
  (`features.maxDirectoryDepth`, `features.longestPathLength`) and rejected by the planner as
  `file-layout` rather than discovered by the service after the upload.
- Failover across compatible providers with a per-provider circuit breaker, and a refusal to
  silently downgrade `persistent` to an anonymous host.
- Post-publish verification: every deployed resource is re-fetched and compared by SHA-256, with an
  explicit `filesExpected` / `filesRequired` split and `--verify-all` for large artifacts.
- `verification.browserRepresentation`: the root document is requested once more with browser-like
  headers, because an edge network can inject its own markup for browsers while serving the uploaded
  bytes to a plain GET. Measured live: ship.page adds a Cloudflare Insights beacon for a browser-like
  `Accept` header (+367 bytes on a 277-byte page). The answer is reported, never hidden, and is not
  treated as a failure.
- A fixed, non-configurable pre-publish safety scan: credentials, private keys and sensitive
  directories are hard-blocked, and nothing is uploaded while a block is present.
- Ownership credentials are stored in the private state directory (`0600` where supported) and are
  **not** printed by default; `claim list` / `claim show [--reveal]` replace the old behaviour.
- Immutable upload snapshots for providers driven through an external CLI or `git`, so a rebuild
  between inspection and upload cannot be published unverified.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` support in the HTTP layer, including HTTPS tunnelling
  through `CONNECT`.
- `--region auto|cn-mainland|global`, replacing the previously accepted-but-ignored `--cn` flag.
- GitHub Pages safety: a branch this tool does not own is refused instead of force-pushed, `CNAME`
  and `.nojekyll` are preserved, and our own pushes use `--force-with-lease`.
- A versioned JSON contract: every payload starts with `schemaVersion` and `command`.
- `schemaVersion` / `capabilitySchema` versioning, with an unknown capability schema refused rather
  than misread.
- A deployment **receipt** on every success: what went out (`artifact.manifestSha256`), who owns it
  (`owner`, with the claim stored privately), where it landed, named lifecycle clocks
  (`contentExpiresAt`, `previewAccessExpiresAt`, `claimDeadline`, `idleReclaimAfter`,
  `renewalDueAt`), per-stage checks (`uploaded`, `files`, `browser`, `targetNetwork`), the provider's
  cost status, which providers were attempted, and which were allowed.
- Recipient scope and cost constraints: `--allow-provider <a,b>` (a failure never widens the set of
  parties that receive the artifact), `--no-failover`, and `--zero-cost`, which refuses any provider
  whose free tier has not been confirmed. Cost facts live in the registry and must carry a status, a
  note, a source and the date they were read.
- `tools/check-policies.mjs` re-checks the plan and limit claims this project repeats against their
  primary sources and writes `research/policy-checks.json`; `research/README.md` documents the three
  layers (research catalog, executable adapter, default candidate) and why reachability evidence is
  recorded per probe instead of as a `china: true` attribute.
- **flypod** as a quick-share provider: `POST https://flypod.dev/sites` with the zip as the raw request
  body, no credential, 14-day anonymous lifetime, claim token stored like every other claim. Verified
  live from two vantage points (a mainland Beijing egress and an overseas one); the served HTML is not
  byte-exact because the provider injects its own render instrumentation, so the page is
  presence-checked while every asset is hash-compared.
- Two-vantage reachability evidence: `tools/probe-reader.mjs` runs from any network against a
  deployment list, and `research/reachability-{mainland,overseas}-2026-09-13.json` record the same
  fixture read from a Beijing egress and a US egress. The registry carries the result per provider as
  `verification.reachability`, with the honest boundary that one datacenter egress is not a
  three-carrier measurement.
- `tools/check-anonymous.mjs`: one harness for every login-free candidate (nonce fixture, documented
  packaging, anonymous upload, masked response, read-back with retry, platform liveness) producing
  records that follow the received evidence schema.
- Measured the two CLI-only anonymous candidates with prefix-local installs (no account, no global
  state, removed afterwards): **Cloudflare temporary accounts** (`wrangler deploy --temporary`) deploy
  an assets-only Worker and serve every file byte-identically with no HTML injection, print a
  60-minute claim window, and are **unreachable from a mainland datacenter egress** (every path timed
  out against four different addresses); **Netlify anonymous deploys** upload and print a claim window
  of the same 60 minutes but serve **401 for every path from both egresses** because the anonymous site
  is password-protected until claimed. Records:
  `research/anonymous-compliance/{cloudflare-temporary,netlify-anonymous}.json`.
- Two more login-free candidates measured and confirmed from **both** egresses (mainland Beijing and
  overseas): **BrewPage** (`POST https://brewpage.app/api/sites`, no publish auth, returns `link` and an
  `ownerToken`; multi-file with byte-identical assets, its own injected top bar, 15-day default TTL) and
  **ht-ml.app** (`POST https://api.ht-ml.app/v1/sites` with `{"html_content": …}`, no auth, returns
  `site_id`/`update_key`/`url`; single page served **byte-identically**, no expiry returned). Both are
  `independent-public`; neither has an adapter yet, so neither is registered.
- The compliance harness now speaks three request shapes (raw archive, JSON single page, multipart) and
  normalises a base URL without a trailing slash; the reader probe takes a per-deployment nonce, because
  a list can mix fixtures and one shared nonce silently reports "marker false" for every entry but the
  first.
- Two new quick-share providers, both enabled after passing the measured bar from two egresses:
  **BrewPage** (multipart `archive` to `/api/sites`, no publish auth, `ownerToken` claim, injected top
  bar so `htmlExact: false`, 20 MB / 100 files) and **ht-ml.app** (JSON `html_content` to `/v1/sites`,
  single document served byte-identically, `update_key` claim, no expiry returned). Both were then
  deployed through the real CLI, not only through stubs: BrewPage verified in 4.5 s with a full receipt,
  ht-ml.app returned a URL with `expiresAt: null` labelled `not-returned`.
- The registry's extension list is written with a leading dot (`.html`), and the planner compares it that
  way; an entry written as `html` silently rejects every file. Caught by running the planner against the
  new provider rather than trusting the adapter tests, which bypass it.
- An offline test suite (`node:test`) covering the adapters, verification, planning, the registry
  schema, the policy split, claims, snapshots, the proxy path and the CLI contract.

### Changed

- Renamed twice on the way here: `teacher-publish` (in the desktop product) → `verified-publish`
  (the working name during extraction, under which the first live probes ran) → **`vpublish`**
  (shorter, and free on npm while `deploy-cli` was taken). Environment variables from both earlier
  names are still read as fallbacks, and a `gh-pages` branch carrying the old `X-Verified-Publish`
  trailer is still recognised as ours.
- Registry capabilities moved from flat `ttlSecondsDefault` / `ttlSecondsSource` and a
  `verification.htmlPolicy` string to a structured `capabilities` object with `ttl`, `denyExtensions`,
  `claimable`, `htmlExact` and optional `idempotent` / `updateInPlace`.
- The registry requires the new `capabilitySchema` key; a file without it is refused.
- Provider CLI discovery no longer depends on a bundled runtime: `PATH` is used when no bundle is
  present, and the deploy directory is configurable.

### Removed

- The `teacher` safety policy, the `--policy` flag and `VPUBLISH_POLICY`. Sector-specific data rules
  belong to the product that has the context to judge them, not to an upstream tool: a rule that is
  wrong for the general case teaches people to bypass the scan. The core keeps one fixed rule set
  (credentials, private keys, sensitive directories), and a consumer applies its own rules to the
  per-path manifest from `inspect --json` before it calls `deploy` — see `docs/consuming.md`.

### Fixed

- Four anonymous adapters (`shipstatic`, `here-now`, `show`, `aft-page`) called an undefined helper
  since the de-branding sweep, because that sweep rewrote the call site and then skipped adding the
  import. Nothing caught it: only the ship-page adapter had an end-to-end test. All four work again,
  and the reachability evidence above was produced after the fix.
- `tools/probe-reader.mjs` joined relative paths onto a base URL without normalising a missing trailing
  slash, which made dropley look broken; the probe was wrong, not the host.

- A single `cwd`-defaulting git helper made staging commands (`git clean -fdx`, `git rm`) run inside
  the user's own project during a GitHub Pages deploy. Commands are now routed to the project or to
  the staging worktree explicitly.
- The GitHub Pages push targeted `HEAD` in a detached worktree, which pushed the previous revision
  instead of the commit that had just been created.
- `git add` could rewrite line endings on Windows, changing published bytes; the adapter now forces
  `core.autocrlf=false` for the staging tree.
- `--auto` for `tunnel start` was accepted and ignored; several available tools now require `--tool`
  or `--auto` instead of silently taking the first one.
- `check-imports` reported prose inside template literals as a dependency.

### Not yet verified

- Persistent success paths (Netlify, Cloudflare Pages, Vercel, GitHub Pages) have not been exercised
  against live authenticated accounts; only their failure paths were. On the machine used for the
  2026-09-11 probe all three CLIs were present but logged out.
- No browser rendering is performed, by design.

### Verified live (2026-09-11)

- All six anonymous providers answered; endpoints, URL shapes, lifetimes and claim fields matched the
  registry. Details and raw shapes: `docs/evidence/live-probe-2026-09-11.md`.
- A real deployment to ship.page was verified 4/4 files by SHA-256, re-verified from a separate
  process, and independently byte-compared by two HTTP clients.
- The same probe found that ship.page serves different HTML to browser-like clients; that is now
  reported by `verification.browserRepresentation` instead of being invisible.
