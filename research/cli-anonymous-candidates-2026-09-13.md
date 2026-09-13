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
