# Live probe — 2026-09-11

Everything below was measured from this machine, on the real services, with Node 24's global `fetch`
and the tool's own HTTP path. No proxy. These results are the evidence behind the registry's
`verification` fields and the README's status section.

## 1. Anonymous provider protocols (six for six)

`node tools/probe-contracts.mjs` — tiny probe artifacts uploaded to each live service:

| Provider | Result | What it confirms |
|---|---|---|
| ship.page | `POST /deploy` → **200**, keys `slug,url,files,plan,expires_at,password_protected,claim_token`, expiry `2026-10-11` | zip transport, 30-day lifetime, one-time `spc_…` claim token |
| ShipStatic | `POST /deployments` → **201**, `url=https://<id>.shipstatic.com`, `expires` ≈ 3 days | multipart `files[]` part name is mandatory (a `files` part returns 400 `validation_failed`) |
| aft.page | `POST /v1/deploy` → **200**, `editToken` + `claimUrl`; served `index.html` **9415 bytes for an 86-byte upload** | the service publishes its own wrapper page; the artifact is not what is served |
| here.now | create → presigned upload → finalize all **succeeded**; `siteUrl`, `versionId`, `finalizeUrl`, `claimToken` + `claimUrl`; served the 86-byte upload verbatim | multi-step protocol, 24-hour anonymous lifetime, claim pair returned |
| show | `POST /upload` (tar.gz) → **200**, `url=https://<id>-<slug>.127.dev`, expiry ≈ 48 h | `*.127.dev` host shape |
| Dropley | `POST /api/artifacts` → **201**, `artifactToken`, expiry `2026-09-18` | 7-day artifact token |

Registry impact: no endpoint, lifetime or claim field changed. The registry's existing notes stand.

## 2. Real end-to-end deployment, verified

```console
$ verified-publish deploy ./dist --mode quick-share --auto --json
exit 0
success=true provider=ship-page persistence=temporary
url=https://wave-kip-7idqt.shipped.page/
expires=2026-10-11T03:16:44.194Z
verified=4/4 required of 4 expected, method=http-sha256 strategy=all-files
hashComplete=true htmlExact=true browserVerified=false
claim.hidden=true claim.value=null claim.secretStored=<state>/claims.json preview=spc_…(28 chars)
```

- The payload contains **no** claim secret (checked with a regex for `spc_[a-z0-9]{24}`), and the
  secret is present in the private store file.
- Re-running `verify <url> <dir>` in a **separate process** passed 4/4 again.

## 3. What a browser actually receives (the finding that mattered)

Fetching the same `index.html` with four different header sets:

| Request | Bytes | SHA-256 (16) | Identical to the upload |
|---|---|---|---|
| no `accept-encoding` (the tool's own request) | 277 | `f0ddee8daf70e066` | yes |
| `accept-encoding: gzip, deflate` | 277 (from 201 compressed) | `f0ddee8daf70e066` | yes |
| PowerShell-like client | 277 (from 201 compressed) | `f0ddee8daf70e066` | yes |
| browser-like `accept: text/html,…` + `br` | **644** (from 433 compressed) | `17e4ef769e390c3a` | **no (+367 bytes)** |

The extra markup is a Cloudflare Insights beacon injected into the served HTML:

```html
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/…"
        data-cf-beacon='{"version":"2024.11.0","token":"…","spa":2}' crossorigin="anonymous"></script>
```

So a deployment can be byte-exact for the request this tool makes and still differ for the reader.
That is now surfaced by `verification.browserRepresentation` and stated in the human note; the run
still passes, because the artifact itself is served correctly and a third party wrapped it.

Non-HTML resources are unaffected: `assets/app.js`, `assets/app.css` and `assets/model.glb` were
byte-identical from every client, including PowerShell.

### Gotcha worth remembering

`Invoke-WebRequest -OutFile` is **not** a byte oracle: for the same URL it wrote a 644-byte file whose
SHA-256 differed from both the upload and the four requests above. Use the tool's own `verify`, or a
Node/curl request with the same headers, when comparing bytes.

## 4. Persistent providers on this machine

The CLIs exist in the Teacher DSH bundle but none of them is authenticated here:

| CLI | State |
|---|---|
| `netlify` 27.5.2 | `loggedIn: false`, `linked: false` |
| `vercel` 59.15.1 | `Logged out` |
| `wrangler` 4.130.0 | `You are not authenticated` |

Which is why the persistent success paths remain **unverified**: the code implements the documented
CLI contracts, and only the unauthenticated failure path has been exercised.

## 5. Not measured here

- Persistent deployments against a real account (no credentials; see §4).
- Browser rendering, WebGL, module execution and CORS behaviour (out of scope by design).
- Name availability is recorded separately in `../../verified-publish-research/raw/naming-availability-actual.md`
  (measured the same day: 22 of 23 candidates are unclaimed on npm, including `verified-publish`).
