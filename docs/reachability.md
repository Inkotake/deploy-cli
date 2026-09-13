# Reachability: mainland China vs everywhere else

A deployment URL is not the same thing as a page a reader can open. This project therefore measures
reachability **per probe** — a provider, a host, a network, a moment — and never stores it as an
attribute such as `china: true`.

## Method

`tools/probe-reader.mjs` runs against a deployment list and, for each deployment, fetches the root and
every asset, comparing SHA-256 with the local bytes:

```console
# on any machine, including a mainland host
node tools/probe-reader.mjs research/reachability-2026-09-13.json \
  --out research/reachability-mainland-<date>.json --label mainland-vps-beijing
```

Two vantage points were used on 2026-09-13:

| Vantage | Where | Egress |
|---|---|---|
| `mainland-vps-beijing` | Ubuntu 24.04 host `vps` | 39.106.154.227, Beijing, CN — **no proxy** |
| `windows-desktop-us-egress` | this workstation | 64.118.152.45, San Jose, US |

Verdicts: `reachable` (root and every asset matched) · `partial` (root loaded, an asset did not match) ·
`unreachable` (the root could not be read) · `absent` (the deployment produced no URL).

## Results

| Provider | Mainland (Beijing) | Overseas (US) | Notes |
|---|---|---|---|
| ship-page | reachable | reachable | HTML byte-exact from both |
| shipstatic | reachable | reachable | rewrites its own HTML (`htmlExact: false`) |
| here-now | partial | partial | assets byte-identical; the served HTML is injected, sometimes only after a moment |
| show | reachable | reachable | — |
| aft-page | reachable | reachable | serves its own wrapper page |
| dropley | reachable | reachable | its URL has no trailing slash, which used to break the probe |
| **flypod** | reachable | reachable | injects its render instrumentation; enabled |
| **BrewPage** | reachable | reachable | multi-file site with an owner token; injects its own top bar (`htmlExact: false`), assets byte-identical; 15-day default TTL, 30 days maximum |
| **ht-ml.app** | reachable | reachable | single HTML document, **byte-identical with no injection**; returns `update_key`; no expiry is returned |
| **meethtml** | reachable | reachable | single document served byte-identically; 24-hour anonymous lifetime; `edit_token` claim |
| **Display.dev** | reachable | reachable | content is public but served inside the provider's own 43 KB viewer page, so it is never byte-comparable |
| **shiply.now** | reachable | reachable | three-step publish with no account; assets byte-identical, the page carries the claim banner it documents |
| **shippage.ai** | reachable | reachable | anonymous single page rendered by the provider at `/p/<slug>`, so the content is public but wrapped |
| **Cloudflare temporary account** | **unreachable** | reachable | every path timed out against four different addresses: DNS interference. Cloudflare sells a separate China Network product, so this is consistent |
| **Netlify anonymous deploy** | 401 (password) | 401 (password) | an unclaimed anonymous site is password-protected from every network — a viewer-side limit, not a network one |
| EdgeOne Makers (anonymous) | nothing served | nothing served | classification `login-free-upload-only`: the upload works, no reader can open the result |

The full split requested for this project is therefore:

- **reachable from mainland China**: ship-page, shipstatic, here-now, show, aft-page, dropley, flypod, BrewPage, ht-ml.app, meethtml, Display.dev, shiply.now, shippage.ai
- **not reachable from mainland China**: Cloudflare `*.workers.dev` temporary deployments
- **not readable by anyone without a credential**: Netlify anonymous deploys (password), EdgeOne anonymous previews (console session)

## Boundaries of this evidence

- **One mainland datacenter egress is not three carriers.** A Beijing VPS is usually more permissive
  than a campus or mobile network, so "reachable" here means "reachable from at least one mainland
  datacenter network on this date".
- **A host can change its behaviour between two reads.** here-now served the uploaded bytes at deploy
  time and injected markup a minute later, which is why its reads are labelled with the moment they ran.
- **Reachability is not permission.** A host being reachable says nothing about its terms, its
  retention, or whether it will still exist next month.

## Recording a new measurement

1. Produce a deployment list (the compliance harness writes the records this tool consumes).
2. Run the probe from each vantage point you have, including at least one inside mainland China.
3. Replace the evidence files under `research/` and update each provider's
   `verification.reachability` in `config/providers.json` with the new verdicts and the date.
4. Never promote a provider to `enabled: true` on a single vantage point: the cross-egress dimension is
   part of the bar, not a bonus.
