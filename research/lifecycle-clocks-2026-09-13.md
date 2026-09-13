# Lifecycle clocks — what the responses actually carried (2026-09-13)

Measured while deploying one fixture to every anonymous channel
(`reachability-2026-09-13.json`). Every value below comes from a live response, not from a
documentation page:

| Provider | `contentExpiresAt` (from the response) | `claimDeadline` | `previewAccessExpiresAt` | HTML byte-exact at deploy time |
|---|---|---|---|---|
| ship-page | 2026-10-13T07:04:29.832Z | null | null | true |
| shipstatic | 2026-09-16T07:04:40.000Z | null | null | false |
| here-now | 2026-09-14T07:04:45.707Z | null | null | true |
| show | 2026-09-15T07:04:53.907Z | null | null | true |
| aft-page | not returned | null | null | false |
| dropley | 2026-09-20T07:05:06.728Z | null | null | true |
| flypod | 2026-09-27T06:57:53.606Z | null | null | false |

Observed lifetimes match the documented ones: 30 days, 3 days, 24 hours, 48 hours, 7 days, 14 days.

## Reading of the empty columns

- **`claimDeadline` is null for all six** because none of them documents or returns a claim deadline.
  The one provider that does is EdgeOne Makers (60 minutes), and its classification is
  `login-free-upload-only` — see `edgeone-anonymous-2026-09-13.md`. A null here is the honest value,
  not a gap to fill from a marketing page.
- **`previewAccessExpiresAt` is null** because these providers serve a public URL with no access token.
  Only a host that gates the preview (EdgeOne's `eo_token`, ESA's 60-minute test token) has such a
  clock at all.
- **aft.page returns no expiry**, which matches its documentation: the site lives while it is used, so
  the tool reports `contentExpiresAt: null` rather than inventing a date.

## A correction worth keeping

The table above records what `deploy`'s own verification saw, and for **here-now it says `true`** — yet
the reader probe, run from two egresses shortly afterwards, found the served HTML **injected**
(`/index.html` returned 601 bytes against a 591-byte root and a 582-byte upload). So here-now can serve
the uploaded bytes first and inject afterwards: a byte-exact verification is a statement about the
moment it ran, which is why the registry declares `htmlExact: false` for that provider and why the
reachability evidence — not this table — is the read-time record.

The same applies to flypod, whose injection is immediate and therefore already visible at deploy time.
