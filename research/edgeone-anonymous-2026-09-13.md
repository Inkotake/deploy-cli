# EdgeOne Makers anonymous deploy — measured 2026-09-13

**Outcome: the login-free path is real, and it is not yet usable as a publishing target.** Recorded
here because the measurement is the evidence, and because the next attempt should start from it.

## What was run

```console
$ npm install edgeone --prefix <temp>          # CLI 0.x, verified surface below
$ edgeone whoami
  ✘ You are not authenticated. Please run `edgeone login`, or set EDGEONE_PAGES_API_TOKEN.
$ edgeone makers deploy ./dist --anonymous -n vpublish-probe
  Requesting anonymous credentials ...
  Uploading package to COS ... 100%
  Creating deployment ...
  Deployment status: Success
  ✔ Anonymous deployment succeeded!
    Access URL:   https://<name>-<id>.edgeone.cool?eo_token=…&eo_time=…
    Project ID:   makers-…
    Deploy ID:    dp…
    Claim (CLI):  edgeone makers claim --sid …
    Claim (Web):  https://console.cloud.tencent.com/edgeone/makers/claim?token=…
    Please claim before 2026-09-13T05:19:35.000Z, otherwise the project will be removed.
```

The CLI's own help confirms the surface (`edgeone makers deploy -h`):

```
directoryOrZip  Path of folder or ZIP package to deploy (optional, defaults to current directory)
--anonymous     Deploy anonymously without login (ignored if already logged in). Creates a temporary
                project to claim later.  [boolean] [default: false]
--site          Site for anonymous deploy: "china" or "global". Auto-detected by IP if omitted.
-e, --env       production or preview
```

And `edgeone makers claim -h`: *"Claim an anonymously-deployed project into your account (requires
login)"*, with `--sid` optional if `.edgeone/anonymous.json` exists.

## What it wrote

`.edgeone/anonymous.json`, in the **current working directory** (not the artifact directory):

| Field | Meaning |
|---|---|
| `site` | `china` here — chosen by the CLI from the egress IP |
| `token` | the claim credential (`Sid`); capability-bearing |
| `tokenExpired` | claim deadline (60 minutes after creation) |
| `cosExpiredTime` / `cosExpiration` | the upload staging object's own short expiry |
| `projectId`, `deploymentId`, `projectName`, `targetPath`, `bucket`, `region` | provider-side identifiers |
| `siteUrl` | the access URL, including `?eo_token=…&eo_time=…` |

The access URL carries a token in the query string, and the region was `ap-shanghai`.

## Why no adapter was added

Every request returned **401** — the URL exactly as the CLI printed it, `/index.html`, and
`/assets/app.js`/`.css` with and without the token. The 401 body was a 2715-byte platform page, not the
277-byte artifact, so the deployment exists and access is being refused.

That matches the provider's own documentation: the anonymous preview link is **subject to visitor-count
and IP restrictions and is "not suitable for sharing"** until it is claimed. A plausible cause for the
401 here is that the deploy egressed through this machine's proxy path while the fetch did not, so the
"same IP" restriction no longer held — which is exactly the kind of environment dependency this project
refuses to paper over.

Shipping it as a `quick-share` provider would mean returning a URL that this tool cannot verify and a
reader may not be able to open. So it is registered **disabled, with the reason**, and appears in
`vpublish providers` for anyone who wants to pick it up:

- login-free deployment works and needs no account;
- the preview is access-restricted and short-lived (60-minute claim window);
- the anonymous project is **deleted automatically** if it is not claimed;
- claiming requires an account, i.e. it is the "login later" path the user deferred.

## If it is picked up again

1. Re-run the deploy and immediately fetch the URL **from the same egress path** the CLI used
   (compare with the polling IP) to separate the IP restriction from a token problem.
2. If the preview can be read reliably, the adapter is a normal CLI adapter: parse `siteUrl`,
   `projectId`, `deploymentId` and the deadline from stdout, and read `.edgeone/anonymous.json` from a
   private staging directory (never the artifact directory, or `.edgeone/` would be published).
3. Treat the `Sid` as a claim credential: store it with the other claims, never print it by default,
   and surface the claim deadline as `lifecycle.claimDeadline`.
4. The claimed/persistent path needs an account and belongs with the other persistent adapters, whose
   success paths are still unverified.
