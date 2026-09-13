# Research layer

## Judged candidates (one schema-aligned record each)

`research/anonymous-compliance/*.json` follows `received-anonymous-provider-evidence.schema.json`. Every
candidate this project has actually measured has a record, and the verdict is the one the evidence
supports:

| Candidate | `shareability` | Evidence level | Basis |
|---|---|---|---|
| ship-page, shipstatic, here-now, show, aft-page, dropley | enabled (registry) | A-live | live protocol re-probe 2026-09-13, both egresses |
| flypod, BrewPage, ht-ml.app | `independent-public` | A-live | anonymous deploy measured, read from a mainland and an overseas egress, now registered and enabled |
| meethtml | `independent-public` | A-live | single document served byte-identically from both egresses; 24-hour anonymous lifetime, `edit_token` claim |
| Display.dev | `independent-public` (wrapped) | A-live | readable from both egresses, but the artifact is served inside the provider's own 43 KB viewer page, so `htmlTransform: wrapped` |
| shiply.now | `independent-public` | A-live | three-step publish (manifest → PUT → finalize) with no account, read from both egresses with assets byte-identical; injects a claim banner and OG tags until claimed, exactly as its documentation states; 24-hour anonymous lifetime |
| shippage.ai | `independent-public` (wrapped) | A-live | `POST /v1/publish` with `{"html": …}` auto-registers the agent on the first call; the page is rendered at `/p/<slug>` inside the provider's own viewer, so `htmlTransform: wrapped`; 14-day retention, 500 KB per page |
| openpouch | `independent-public` | A-live | CLI-first (`npx -y openpouch deploy <dir> --json`, no account): a fixed 72-hour preview with a private save link that extends it to 7 days; root and both assets byte-identical from both egresses |
| Roxer | `not-applicable` | E-excluded | no callable contract: `/llms.txt`, `/docs`, `/api`, `/.well-known/agent.json`, `/openapi.json` and `docs.roxer.com` all 404; only the marketing homepage answers |
| EdgeOne Makers (anonymous) | `not-applicable` | A-live | 60 controlled reads: 401 while the project lived, 404 after the claim window, never a 200 |
| Cloudflare temporary accounts | `independent-public` (overseas only) | A-live | deploys with no account and serves byte-identical files, but unreachable from the mainland egress |
| Netlify anonymous | `owner-preview` | A-live | uploads with no account, but the site is password-protected until claimed (401 everywhere) |
| DropCat | `not-applicable` | A-live | returns a success envelope while serving nothing; the apex is a Coming Soon page |
| Sitebin | `not-applicable` | A-live | the anonymous endpoint answers 401; publishing needs an account |

**Not measured, and therefore not claimed:** the received matrix's P0 and P1 lists are now exhausted
except for **MindsPage**, which is a documentation discrepancy rather than an untested candidate: the
matrix lists it as a static page/site host, but the agent index the service itself publishes
(`https://mindspage.com/llms.txt`) documents `POST /api/code` — a code-session and review API taking
`{code, language}` — and no static-publish endpoint, so the matrix's claim is not supported by the source
it cites. Dropage's documented API guide is unreachable (`/docs` and `/api` both answer 410), so there is
nothing to call; openpouch turned out to be CLI-first and was measured through its CLI; Roxer published
no callable contract at all (see its record above).

**Out of scope by instruction:** every account-required provider. The user deferred those explicitly, so
their success paths remain documented as `expected` rather than verified.

## Reachability: mainland vs overseas (measured 2026-09-13)

`tools/probe-reader.mjs` runs from **any** vantage point against a deployment list and reports, per
provider, whether the root and every asset could be read with the expected SHA-256. The same tool was
run from two egresses on the same fixture:

| Vantage | Where | Egress |
|---|---|---|
| `mainland-vps-beijing` | Ubuntu 24.04 host, `vps` | 39.106.154.227, Beijing, CN (no proxy) |
| `windows-desktop-us-egress` | this workstation | 64.118.152.45, San Jose, US |

| Provider | Mainland | Overseas | Note |
|---|---|---|---|
| ship-page | reachable | reachable | HTML byte-exact from both |
| shipstatic | reachable | reachable | HTML rewrites itself (`htmlExact: false`) |
| here-now | partial | partial | assets byte-identical; the served HTML is injected (591 B root vs 601 B `/index.html`) |
| show | reachable | reachable | — |
| aft-page | reachable | reachable | serves its own wrapper page |
| dropley | reachable | reachable | the deployment URL has no trailing slash, which broke the first probe run — the tool now normalises it |
| flypod | reachable | reachable | cross-egress confirmed; HTML carries the provider's render instrumentation |

**Honest boundary:** that is *one* mainland datacenter egress, not a three-carrier or campus-network
measurement, and a datacenter network is usually more permissive than a school network. The registry
stores this as `verification.reachability` per provider, with the evidence files named, rather than a
`china: true` flag.

This directory holds **policy facts about hosting platforms**, not runtime configuration. It exists so
that "we looked this up, on this date, at this source" is a reviewable artifact instead of a fact
someone remembers.

## Three layers, deliberately separate

| Layer | Lives in | May contain | May NOT do |
|---|---|---|---|
| **Research catalog** | `research/` (this directory) | plans, prices, limits, region conditions, trials, retired services, one entry per claim with source and date | change what the tool uploads, or enable anything |
| **Executable adapters** | `src/providers/` | providers with a measured, implemented protocol | be added on the strength of a documentation page alone |
| **Default candidates** | `config/providers.json` with `enabled: true` | providers that passed verification, cost and privacy checks | be enabled by a catalog update |

A research entry can never become an executable adapter by itself, and neither can an adapter change
the token destination for another provider. The registry's `adapter` / `endpoint` / `protocol` /
`allowedHosts` fields stay the security boundary they already are.

## What is here now

| File | Content |
|---|---|
| `policy-checks.json` | Dated claim checks against primary sources, produced by `tools/check-policies.mjs`. |

Run it again whenever a plan or limit is about to be trusted:

```console
$ node tools/check-policies.mjs
CONFIRMED  edgeone-makers-limits              3/3 fragments
CONFIRMED  esa-cli-pages-token                4/4 fragments
…
```

A `confirmed` entry means the required sentence fragments were on the page that day. It is evidence
about **documentation**, not a measurement of the platform, and it is never a reason to enable a
provider by default.

## Facts that must be re-checked, never assumed

- **Free tier shape**: "free" is not a boolean. Record `status` from `free`, `quota-limited`,
  `may-charge`, `trial`, `unknown`, plus the note and the source — the registry enforces that shape.
- **Lifetime**: a host can expire the content, the preview credential and the anonymous claim at three
  different times (EdgeOne's 60-minute claim window and ESA's 60-minute test-domain token are two
  real examples). Those are separate clocks in the deploy receipt; never collapse them into one TTL.
- **Region conditions**: a China-facing acceleration region may require a filed domain. "Reachable from
  here" is not the same claim as "usable in mainland China".
- **Account conditions**: verification requirements, payment method, per-account limits, and whether a
  free plan is even open to new users today.

## China reachability evidence

Reachability is **measured per probe**, never stored as a provider attribute. A successful request from
one network says nothing about another, so evidence is recorded as:

```json
{
  "provider": "edgeone-makers",
  "host": "example.edgeone.app",
  "probe": { "region": "Shanghai", "operator": "China Telecom", "kind": "http-get" },
  "measuredAt": "2026-09-13T00:00:00.000Z",
  "results": [{ "path": "index.html", "ok": true }, { "path": "assets/font.woff2", "ok": false }]
}
```

Rules for this evidence:

- no `china: true` field on a provider, ever;
- "not measured" is a legitimate, expected value — the deploy receipt reports
  `stages.targetNetwork: 'not-measured'` until a probe exists;
- a private preview URL carrying an access token must never be handed to a public measurement service
  by default.

## Received artifacts (archived for offline citation)

A research package received on 2026-09-13 is archived verbatim rather than summarised, so its claims
can be re-read after the original links rot:

| File | Content |
|---|---|
| `received-anonymous-deployment-research.md` | The full report: strict anonymity admission criteria, P0/P1 candidates, exclusions. |
| `received-anonymous-provider-matrix.json` / `.csv` | 57 services, paths and exclusions with their interfaces and lifetimes. |
| `received-anonymous-provider-evidence.schema.json` | The proposed evidence record: `publisherAuth`, `viewerAccess`, `artifactModel`, `shareability`, `evidence`. |
| `received-edgeone-final-classification-plan.md` | The controlled classification matrix used above. |
| `edgeone-anonymous-measurement-2026-09-13.json` | The 60 reads produced by running that matrix. |

Nothing in `received-*` is runtime configuration: the matrix is a candidate list, and a provider still
has to pass the executable-adapter bar before it can appear in `config/providers.json`.
