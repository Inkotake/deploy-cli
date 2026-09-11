# vpublish

**Deploy a built static folder anywhere. Verify what actually went live. Fail over when the host doesn't.**

English · [中文](./README.zh-CN.md)

`vpublish` is a static-publishing router for humans and agents. Point it at a `dist/` and it inspects
the artifact, picks a host that can actually serve it, uploads it, fetches the files back and compares
them byte for byte — and only then reports a URL.

```text
dist/ → inspect → pick a compatible host → upload → fetch back → compare SHA-256 → URL
```

An HTTP 2xx from an upload is a *candidate* success. Success is only reported after verification.

```console
$ vpublish ./dist
Inspected 62 files (4.8 MiB), no blocked files
Publishing plan (quick-share, region auto)
  1. ship-page  score=10
Deployment verified.
  provider:  ship-page (temporary)
  url:       https://xxxx.shipped.page/
  expires:   2026-10-11T00:00:00.000Z
  verified:  62 of 62 required resources hash-matched by http-sha256
```

## Install

Node **22.2+**, no other requirement. The package has **zero dependencies** — no install step, no
`node_modules`, no post-install scripts.

```console
# from a clone (works today — the package is not on npm yet, see Status)
$ git clone https://github.com/Inkotake/deploy-cli
$ node deploy-cli/bin/vpublish.mjs ./dist

# once it is published
$ npx vpublish ./dist
$ npm install --global vpublish
```

## Usage

```console
$ vpublish ./dist                      # deploy to an anonymous host, then verify
$ vpublish plan ./dist --json          # what would happen, and why (contacts nothing)
$ vpublish ./dist --dry-run            # the same, without uploading
$ vpublish deploy ./dist --mode persistent   # your own Netlify / Cloudflare / Vercel / GitHub Pages
$ vpublish verify https://… ./dist     # re-check a live URL against the local build
$ vpublish ./dist --json | jq .verification
```

Common flags: `--json`, `--mode`, `--region`, `--provider`, `--dry-run`, `--verify-all`,
`--allow-inexact`, `--proxy`. Full reference: [`docs/cli.md`](./docs/cli.md).

## Commands

| Command | Purpose |
|---|---|
| `vpublish [dir]` | Shorthand for `deploy [dir]`. |
| `detect` | Find the artifact; report the registry, project markers, git remote, tunnel tools. |
| `inspect` | Build the byte manifest, run the safety scan, list client-side routes and broken references. |
| `plan` | Order the candidate providers for one mode and explain every decision. Contacts nothing. |
| `deploy` | The only command that mutates remote state: upload, verify, report. |
| `verify <url> [dir]` | Re-compare a deployed URL against a local artifact without uploading. |
| `providers` | Registry: capabilities, verification status, breaker state, adapter availability. |
| `claim` | Stored ownership credentials; `show --reveal` prints one. |
| `doctor` | One-shot environment report. |
| `tunnel` | Session-only localhost exposure through a tunnel tool you already have. |

## Modes

| Mode | Behaviour |
|---|---|
| `quick-share` (default) | Anonymous temporary host. Failover between compatible hosts is allowed; the URL expires. |
| `persistent` | Account-owned durable host through your own `netlify` / `wrangler` / `vercel` CLI or `git`. **Never** silently downgraded to an anonymous host. |
| `tunnel` | Session-scoped localhost exposure. Not a deployment, never reported as verified. |

## Providers

| Provider | Mode | Verification | HTML byte-exact | Anonymous lifetime |
|---|---|---|---|---|
| ship.page | quick-share | live-tested | yes | 30 days |
| ShipStatic | quick-share | live-tested | no (rewrites HTML) | 3 days |
| here.now | quick-share | live-tested | no (injects meta tags) | 24 hours |
| show | quick-share | live-tested | strict | 48 hours |
| aft.page | quick-share | live-tested | no (serves a wrapper page) | 30 days idle |
| Dropley | quick-share | unverified | strict | 1/3/7 days |
| Netlify · Cloudflare Pages · Vercel · GitHub Pages | persistent | expected | yes | durable |

`live-tested` means the protocol was measured against the live service; `expected` means the adapter
implements the provider's documented CLI contract and only its failure path has been exercised. The
registry is the source of truth — `vpublish providers --json`, and
[`docs/provider-protocols.md`](./docs/provider-protocols.md) for the measured details.

Persistent providers are driven by the CLI you already have, or by `git` for GitHub Pages. Nothing is
installed for you: a missing CLI is reported as unavailable rather than downloaded.

## Safety

- **Nothing is uploaded while the safety scan has a hard block.** The rule set is fixed and generic:
  credentials, private keys, sensitive directories.
- The scan does **not** judge project-specific data — `grades.csv` or `report-card.docx` pass, because
  a tool that guesses what a given user's data means is wrong for everyone else. A product that must
  refuse those enforces that itself against the per-path manifest from `inspect --json`; see
  [`docs/consuming.md`](./docs/consuming.md).
- Ownership credentials are stored in the private state directory and never printed unless you pass
  `--show-claim-secret`. Never forward a claim value or URL: holding it means owning the deployment.
- GitHub Pages is treated as shared state: a branch this tool does not own is **refused** rather than
  overwritten, `CNAME` is preserved byte for byte, and our own pushes use `--force-with-lease`.
- A provider URL is taken from the response and checked against the registry's host allowlist — never
  derived from a naming convention.

## Documentation

| | |
|---|---|
| [`docs/cli.md`](./docs/cli.md) | Commands, flags, exit codes, JSON contract, environment variables. |
| [`docs/verification.md`](./docs/verification.md) | What is compared, how much of it, and what this cannot prove. |
| [`docs/provider-protocols.md`](./docs/provider-protocols.md) | The measured contract behind each adapter. |
| [`docs/consuming.md`](./docs/consuming.md) | Using this as an upstream dependency (pinning, rules, aliases). |
| [`docs/releasing.md`](./docs/releasing.md) | Publishing to npm, 2FA, credential hygiene. |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | The failures that actually cost time. |

## Status

- **Not on npm yet.** Installable from a clone; the registry refuses a non-interactive publish without
  a 2FA-capable credential. [`docs/releasing.md`](./docs/releasing.md) has both ways to finish it.
- **Persistent success paths** have not been run against live authenticated accounts — only their
  failure paths. Treat `persistent` as `expected` until you have run it yourself.
- The anonymous providers were re-probed live on 2026-09-11 and matched the registry
  ([evidence](./docs/evidence/live-probe-2026-09-11.md)); hosts change, so re-run
  `tools/probe-contracts.mjs` before trusting an old entry.
- **No browser rendering** is performed: WebGL, module execution and CORS are outside what this can
  prove, and it never claims otherwise.

## Development

```console
$ npm test                       # unit + integration tests, no network
$ node tools/smoke.mjs           # command surface, --json discipline, exit codes
$ node tools/check-imports.mjs   # proves the package still has no dependencies
```

Fake providers run on `127.0.0.1`, so the suite never touches the internet. CI runs it on Linux,
Windows and macOS across Node 22 and 24.

## License

MIT — see [`LICENSE`](./LICENSE).
