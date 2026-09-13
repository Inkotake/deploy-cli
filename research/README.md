# Research layer

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
