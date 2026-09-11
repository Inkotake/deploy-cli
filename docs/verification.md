# Verification

`vpublish` reports success only when the bytes served from the public URL match the local manifest.
This file states exactly what is compared, and where the limits are — because a "verified" badge that
hides its own boundaries is worse than no badge.

## The rule

An HTTP 2xx from an upload is a **candidate** success. The deployment is only reported as successful
after the deployed resources have been fetched back with `GET` and compared by SHA-256 against the
hashes computed locally.

A run is a failure when any of these is true:

| Symptom | Reported as |
|---|---|
| A resource's bytes differ | `sha256` mismatch |
| A resource is missing | `failure.kind: 'missing'` (404) |
| A resource answers with a non-2xx status | `failure.kind: 'status'` |
| A JS/CSS/model/JSON resource answers with an HTML document | `failure.kind: 'html-fallback'` — the SPA-fallback trap |
| An HTML resource contains a host error page | `failure.kind: 'error-page'` |
| HTML is served with the wrong content type | `failure.kind: 'wrong-content-type'` |
| The root URL does not answer with HTML | `problems[]`, `strategy: 'root'` |

## How much is compared

- At or below **20 MiB** total, every file is compared (`strategy: 'all-files'`).
- Above that, `index.html`, every JS/CSS file, every `.glb`/`.gltf`/`.bin`/`.wasm`, every other HTML
  file and the three largest remaining files are compared (`strategy: 'selective'`) — unless
  `--verify-all` is given.
- The result always carries `filesExpected` (all files in the artifact) next to `filesRequired` (what
  this run compared), and the human-readable `note` says the comparison was partial.

## HTML

- `htmlExact: true` means the served HTML matched the uploaded bytes.
- Providers known to rewrite HTML (ShipStatic, here.now, aft.page) are excluded from the default plan;
  with `--allow-inexact` their HTML is **presence-checked** instead: the status must be 2xx, the body
  must be HTML, and it must not be an error page. Those paths are listed in `htmlNotCompared` and
  `htmlExact` becomes `false`. Every non-HTML resource is still hash-compared.

## What a browser receives

The root document is requested **once more with browser-like headers**, because an edge network can
inject markup for browsers while serving the uploaded bytes to a plain `GET`. The result is reported as
`browserRepresentation`:

```json
"browserRepresentation": {
  "checked": true, "identical": false,
  "status": 200, "bytes": 644, "expectedBytes": 277, "addedBytes": 367,
  "contentEncoding": "br", "decoded": true,
  "note": "a browser-like request receives 644 bytes where 277 were uploaded (+367); …"
}
```

Measured live on ship.page: a browser-like `Accept` header receives the upload plus a Cloudflare
Insights beacon (+367 bytes on a 277-byte page). This is **not** treated as a failure — the artifact is
served and a third party wrapped it — but it is never hidden: it also appears in the human `note`.

The probe can be disabled from the API (`options.browserCheck = false`); the CLI does not expose a flag
for it, because hiding it by default would defeat the purpose.

## What this cannot prove

- **No browser rendering is performed.** WebGL context creation, ES-module execution, CORS and texture
  decoding are outside what an HTTP comparison can see. `browserVerified` is always `false`, and the
  note says so.
- **A verified deployment can still expire**, and a `persistent` deployment to an asynchronous host
  (GitHub Pages) may legitimately fail verification while the site is still building.
- **Verification runs against the URL the provider returned**, at the moment `deploy` finished. Later
  edits on the host are not detected; re-run `vpublish verify <url> <dir>` to re-check.

## Ownership credentials

Some hosts return a claim token or URL that grants ownership of the deployment. `deploy` stores it in
the private state directory and reports only that it exists. Print it with `--show-claim-secret`, read
it later with `vpublish claim show <url> --reveal`. **Never forward a claim value or claim URL**:
holding it means owning the deployment.
