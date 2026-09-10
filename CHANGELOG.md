# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release of the standalone tool, extracted from the Teacher DSH desktop distribution.

### Added

- `deploy`, `inspect`, `plan`, `verify`, `detect`, `providers`, `claim`, `doctor` and `tunnel`
  commands, plus `verified-publish <dir>` as shorthand for `deploy <dir>`.
- Capability-aware provider planning: extension allowlists and blocklists, file-count, per-file and
  total-size limits, model/`wasm` support and HTML-rewrite behaviour are enforced **before** upload.
- Failover across compatible providers with a per-provider circuit breaker, and a refusal to
  silently downgrade `persistent` to an anonymous host.
- Post-publish verification: every deployed resource is re-fetched and compared by SHA-256, with an
  explicit `filesExpected` / `filesRequired` split and `--verify-all` for large artifacts.
- Safety policies: `generic` (credentials and private material) and `teacher` (adds student records,
  grades, rosters and family contact data, but only for files that can carry records).
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
- An offline test suite (`node:test`) covering the adapters, verification, planning, the registry
  schema, the policy split, claims, snapshots, the proxy path and the CLI contract.

### Changed

- Renamed from `teacher-publish` (`@teacher-dsh/publish-cli`) to `verified-publish`; the old
  environment variable names are still read as fallbacks.
- Registry capabilities moved from flat `ttlSecondsDefault` / `ttlSecondsSource` and a
  `verification.htmlPolicy` string to a structured `capabilities` object with `ttl`, `denyExtensions`,
  `claimable`, `htmlExact` and optional `idempotent` / `updateInPlace`.
- The registry requires the new `capabilitySchema` key; a file without it is refused.
- Provider CLI discovery no longer depends on a bundled runtime: `PATH` is used when no bundle is
  present, and the deploy directory is configurable.

### Fixed

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
  against live authenticated accounts; only their failure paths were.
- No browser rendering is performed, by design.
