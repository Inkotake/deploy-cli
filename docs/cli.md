# CLI reference

Full surface of the `vpublish` command. The README has the short version.

## Commands

| Command | Purpose |
|---|---|
| `vpublish [dir]` | Shorthand for `deploy [dir]`. |
| `detect [dir]` | Find the artifact; report the registry, project markers, git remote and tunnel tools. |
| `inspect [dir]` | Build the byte manifest, run the safety scan, list client-side routes and broken references. |
| `plan [dir] --mode <mode>` | Order the candidate providers for one mode and explain every decision. Contacts nothing. |
| `deploy [dir] --mode <mode>` | The only command that mutates remote state: upload, verify, report. |
| `verify <url> [dir]` | Re-compare a deployed URL against a local artifact without uploading. |
| `providers` | Print the registry: capabilities, verification status, breaker state, adapter availability. |
| `claim [list\|show [key]]` | Inspect stored ownership credentials. `show` hides the secret until `--reveal`. |
| `doctor [dir]` | One-shot environment report: runtime, state, safety rules, region, proxy, registry, providers. |
| `tunnel detect\|start` | Session-only localhost exposure through a tunnel tool that is already installed. |

Every command accepts `--json` and `--verbose`. A directory argument defaults to the current working
directory, and artifact discovery descends up to three levels.

## Modes

| Mode | Behaviour |
|---|---|
| `quick-share` (default) | Anonymous temporary host. Failover between compatible hosts is allowed; the URL expires. |
| `persistent` | Account-owned durable host through your own `netlify` / `wrangler` / `vercel` CLI or `git`. **Never** silently downgraded to an anonymous host. |
| `tunnel` | Session-scoped localhost exposure. Explicitly not a deployment, and never reported as verified. |

## Flags

| Flag | Meaning |
|---|---|
| `--json` | Exactly one JSON document on stdout; diagnostics on stderr. |
| `--mode <mode>` | Deployment mode (see above). Default `quick-share`. |
| `--region <auto\|cn-mainland\|global>` | `cn-mainland` puts region-reachable hosts ahead of higher-scoring ones; `auto` only breaks ties; `global` ignores the region priority. |
| `--provider <id>` | Restrict the attempt to one provider. |
| `--dry-run` | Print the order and the payload; contact nothing. Exits 0 without claiming a deployment. |
| `--verify-all` | Compare every file even above the 20 MiB fast-verification threshold. |
| `--no-verify` | Skip verification. The run can then never report success. |
| `--allow-inexact` | Also consider hosts that rewrite served HTML (ShipStatic, here.now, aft.page). Their HTML is presence-checked; everything else is still hash-compared. |
| `--proxy <url>` | Proxy provider requests (also honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`). |
| `--show-claim-secret` | Print the ownership credential instead of only storing it. |
| `--force-push`, `--branch <name>` | GitHub Pages: allow overwriting a branch this tool does not own, or publish to a different branch. |
| `--allow-provider <a,b>` | Upload only to these provider ids. A failure never widens the set of recipients. |
| `--no-failover` | Attempt only the first eligible provider. |
| `--zero-cost` | Require a **confirmed** free tier; a provider whose cost status is unknown is refused. |
| `--keep-snapshot` | Keep the upload snapshot and report its path. |
| `--auto` | Do not prompt for confirmation. |
| `--timeout <ms>` | Request timeout. |
| `--help`, `--version` | Usage, version. |

## Exit codes

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

## JSON contract

Every `--json` payload starts with the contract version and the command that produced it:

```json
{ "schemaVersion": 1, "command": "deploy", "...": "command-specific fields" }
```

`deploy` on success:

| Field | Meaning |
|---|---|
| `success` | `true` only after verification passed. |
| `provider`, `url`, `urlSource` | Who served it, and the URL exactly as the provider reported it. |
| `mode`, `persistence`, `expiresAt`, `expiresAtSource` | How durable it is, and where that answer came from. |
| `verification` | See [`verification.md`](./verification.md) for every field. |
| `claim` | `{ kind, available, valuePreview, secretStored, hidden }` — the secret itself only with `--show-claim-secret`. |
| `lifecycle` | Named clocks: `contentExpiresAt`, `previewAccessExpiresAt`, `claimDeadline`, `idleReclaimAfter`, `renewalDueAt`, `source`. A clock nobody established is `null`. |
| `receipt` | The six answers: `artifact` (including a `manifestSha256`), `owner`, `delivered`, `lifecycle`, `stages`, `cost`, `providersAttempted`, `allowedProviders`, `failover`. |
| `snapshot` | `{ strategy, fileCount, bytes }` when the provider was driven through an external CLI or `git`. |
| `attempts` | One entry per provider tried, with `result` and, on failure, `failureKind`. |

`deploy` on failure reports `success: false`, `provider`, `reason`, `nextAction`, `artifactOk` and
`attempts`, so a failure is as machine-readable as a success.

Other payloads: `detect`, `inspect` (`manifest`, `blocked`, `warnings`, `missingReferences`, `routes`,
`features`), `plan` (`plan.order`, `plan.excluded`, `plan.disabled`), `providers` (registry plus
health), `claim`, `doctor`, `tunnel`.

## Environment variables

| Variable | Effect |
|---|---|
| `VPUBLISH_HOME` | State directory (health cache, claims). Defaults to `~/.vpublish`. |
| `VPUBLISH_REGISTRY` | Use a different provider registry file. |
| `VPUBLISH_STATUS_FILE` | Local availability overlay; may only change `enabled`, `priority`, `health`, `lastValidated`, `notes`. |
| `VPUBLISH_REGION` | Default for `--region`. |
| `VPUBLISH_DEPLOY_HOME`, `VPUBLISH_DEPLOY_BIN` | Where to look for `netlify` / `wrangler` / `vercel` before falling back to `PATH`. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Standard proxy variables, honoured by every request. |

Older spellings are read as fallbacks, so a deployment that exports them keeps working:
`VERIFIED_PUBLISH_*` (this tool's previous name) and the education edition's original
`TEACHER_DSH_HOME` / `TEACHER_DEPLOY_HOME` / `TEACHER_PUBLISH_REGISTRY` /
`TEACHER_PUBLISH_STATUS_FILE`.
