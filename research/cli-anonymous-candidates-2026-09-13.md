# CLI-based anonymous candidates — contracts verified, measurement pending

Two candidates need a CLI to be present but **no account**. Their contracts were verified against the
official documentation on 2026-09-13; neither has been measured yet, and this file says exactly why.

## Cloudflare — temporary accounts (`wrangler`)

Source: `https://developers.cloudflare.com/workers/platform/claim-deployments/index.md`
(page states "Last updated Jul 14, 2026"), fetched 2026-09-13.

Verbatim from the page:

> To continue without logging in, rerun this command with `--temporary`. Wrangler will use a temporary
> account and print a claim URL.

> Temporary account ready: Account: example-name (created) / Claim within: 60 minutes / Claim URL:
> https://dash.cloudflare.com/claim-preview?claimToken=…

> The intended user must complete the claim within 60 minutes. Opening the claim URL before the
> deadline is not enough.

Supported resources for a temporary account include Workers deployments on `workers.dev` and
**Workers Static Assets: "Up to 1,000 files, with each asset up to 5 MiB"**.

So: login-free deploy, a claim URL that must be *completed* within 60 minutes, and a documented
machine-readable claim handle (`claim.url`) the page tells the caller to pass on.

## Netlify — anonymous deploy (`netlify`)

Source: `https://cli.netlify.com/commands/deploy/`, fetched 2026-09-13.

Verbatim from the CLI reference:

> `allow-anonymous` (boolean) - If not logged in, deploy anonymously and create a claimable site
> instead of requiring authentication

> `netlify deploy --allow-anonymous --dir ./public --no-build` — Deploy without auth

The same CLI's command list contains a **`claim`** command, so the ownership path exists in the tool
rather than only in a web console. The reference page does **not** state a claim deadline, so the
"1 hour unless claimed" figure in the received research matrix is **unverified here** and must be
measured or sourced before it is repeated.

## Why neither has been measured yet

Both require the vendor CLI on the machine. This project's product rule is that **the tool never
installs anything**: an adapter may only use a CLI that already exists (the `resolveBundledBin` +
`cliAvailable` pattern the persistent adapters already follow). Measuring therefore needs one of:

1. **A temporary, prefix-local install** (`npm install --prefix <temp> wrangler`) used for the
   measurement and deleted afterwards — no global state, no PATH change, no leftover. This is exactly
   how the EdgeOne protocol was measured, and its temporary install and scratch directories were
   removed afterwards.
2. **The user installing the CLI**, after which the adapter simply uses it.

Until one of those happens, both records stay at `evidence.level: B-official-contract`,
`verification.uploadSucceeded: false`, `shareability: unverified` — a documented candidate, not a
capability.

## What the measurement would settle

| Question | Why the docs are not enough |
|---|---|
| Does `--temporary` work with a static-assets-only Worker (no script)? | The page describes Workers; an assets-only deployment is the shape this tool publishes. |
| What URL is served, and is it readable from a second egress? | `workers.dev` reachability from mainland China is the open question the user cares about, and Cloudflare's own docs mention a separate China Network product. |
| Netlify's claim deadline | The CLI reference does not state it. |
| Are assets byte-identical, and is HTML injected? | Neither page says; every prior provider had a surprise here. |
| Does the claim URL survive being opened without being completed? | Cloudflare says no; that is worth confirming because a tool that prints a claim URL must say how long it stays useful. |

## Measured 2026-09-13 (prefix-local CLI install, no account, removed afterwards)

Both CLIs were installed into a temporary prefix (wrangler 4.131.1, netlify-cli 27.5.2) with HOME and
APPDATA redirected to a throwaway directory, so no real user configuration was touched. Each platform
then received one anonymous deployment of the same fixture, read back from two egresses.

| | Cloudflare temporary account | Netlify anonymous deploy |
|---|---|---|
| Command | `wrangler deploy --temporary` with an assets-only Worker | `netlify deploy --allow-anonymous --dir <dist> --no-build` |
| Login required | no | no |
| Upload | succeeded | succeeded |
| Printed URL | `https://<name>.<account>.workers.dev` | `http://<name>.netlify.app` |
| Claim handle | claim URL, `Claim within: 60 minutes` | claim URL + `netlify claim --site <id> --token <jwt>` |
| Claim window | 60 minutes (printed, must be *completed*) | **60 minutes (printed by the CLI)** — the docs did not say |
| Bytes served | **every file byte-identical**, no HTML injection | never readable |
| Reader access | public — but see below | **password (401 for every path from both egresses)** |
| Overseas egress | reachable | 401 (password) |
| **Mainland egress (Beijing)** | **unreachable: connect ETIMEDOUT against four different addresses** | 401 (password) |

**Cloudflare is the first candidate that is technically excellent and geographically wrong for this
project.** It deploys with no account, serves the exact uploaded bytes (no injection at all, unlike
flypod and here-now), works at `/`, `/index.html` and `/index` — and is unreachable from a mainland
datacenter egress, consistent with Cloudflare selling a separate China Network product. It therefore
stays `enabled: false` for a China-facing default even though its reader verification passed overseas.

**Netlify fails on the viewer side.** The anonymous deploy is real and claimable, but the site is
password-protected until claimed, and no flag on `netlify deploy` or `sites:update` disables it. The
received research matrix listed its viewer access as a public URL; the measurement says otherwise.

Neither is registered in `config/providers.json` yet: no adapter exists for either, and the goal only
permits enabling a provider that reaches `independent-public` *including* the cross-egress dimension,
which Cloudflare did not (mainland) and Netlify did not (password).
