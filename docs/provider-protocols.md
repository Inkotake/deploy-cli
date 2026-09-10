# Static provider protocols

Verified reference for the anonymous / persistent static-hosting providers that
`verified-publish` implements. This file is the contract the adapters in
`src/providers/` must satisfy.

Everything below was verified against live documentation and, where noted, against published
source code. Anything not verified is marked **UNVERIFIED** and must not be relied on. Each
provider's `capabilities` entry in `config/providers.json` is derived from this file; when a service
changes, re-measure with `tools/probe-contracts.mjs` and update both.

## Cross-service summary

| Provider | Endpoint | Shape | Anonymous lifetime | Ownership key | `.glb`/`.gltf` | 429 `Retry-After` |
|---|---|---|---|---|---|---|
| ship.page | `POST https://ship.page/deploy` | html / json / zip by `Content-Type` | 30 days | `claim_token` (`spc_…`) | not restricted | yes, always `60` |
| ShipStatic | `POST https://api.shipstatic.com/deployments` | multipart | 3 days | `claim` URL | not restricted (blocklist only) | yes |
| aft.page | `POST https://api.aft.page/v1/deploy` | html / json / multipart | 30 days idle | `editToken` + `claimUrl` | not restricted | not documented |
| here.now | create → presigned PUT → finalize | multi-step JSON + R2 PUT | 24 hours | `claimToken` + `claimUrl` | not restricted | yes |
| Show | `POST https://show.127.dev/upload` | multipart tar.gz | 48 hours | none | **rejected** (allowlist) | unverified |
| Dropley | `POST https://dropley.app/api/artifacts` | multipart `manifest` + `file` | 1/3/7 days | `artifactToken` | **UNVERIFIED** | yes |
| wh-drop | — | — | — | — | — | — |

`wh-drop` is registered as `enabled: false` with `disabledReason: "no-public-service-found"`.
No host, documentation, or API could be located for it (21 candidate domains do not resolve).
It must never be attempted.

## Capability rules that must be enforced before upload

- **Show** has a hard extension allowlist, so it rejects `.glb`, `.gltf`, and `.wasm`. A
  provider that cannot serve a required asset is *incompatible*, not merely lower priority.
- **Dropley** enforces a server-side extension allowlist that is not published. Model files are
  therefore treated as unsupported for Dropley until proven otherwise.
- **ShipStatic** publishes a blocklist only (`/limits`), which does not contain model or wasm
  extensions. Its live limits are `maxFileSize: 20 MiB`, `maxFilesCount: 500`,
  `maxTotalSize: 50 MiB`.
- **Show** limits: 10 MiB compressed and extracted, 100 files, 5 uploads/hour/IP.
- **here.now** limits: 1000 files per request, 250 MiB per file anonymous, 60 publishes/hour/IP.
- **aft.page** limits: 500 files, 25 MiB per file, 100 MiB total.
- **Dropley** limits: 1000 files, 50 MiB total.
- **ship.page** limits: 100 files anonymous, 10 MiB raw body, 25 MiB zip.

## Provider details

### ship.page — `ship-page`

- `POST https://ship.page/deploy`, no auth for anonymous.
- Body is selected by `Content-Type`:
  - `application/zip` — raw zip bytes. A single root directory is stripped automatically.
  - `application/json` — `{"files": {"index.html": "<html>", "logo.png": {"encoding": "base64", "content": "…"}}}`.
  - any other type — the raw body is stored as `/index.html`.
- Query: `?ttl=<seconds>` (minimum 60), `?email=<address>` (anonymous only, mails the claim link).
- Response: `{ slug, url, files, plan, expires_at, password_protected, claim_token?, claim_email? }`.
  `claim_token` is shown exactly once and matches `^spc_[a-z0-9]{24}$`. There is no claim URL
  field; claiming is `POST /drops/{slug}/claim` with the token.
- The public URL must be taken from the response `url` field. Documentation examples still show
  `*.shipped.run` while responses have been observed on `*.shipped.page`.

### ShipStatic — `shipstatic`

- `POST https://api.shipstatic.com/deployments`, `multipart/form-data`, no `Authorization`
  header for anonymous deploys.
- Fields: `files[]` (one part per file, filename carries the relative path), `checksums`
  (JSON array of one **MD5** per file, same order), optional `labels`, `via`, `password`, `ttl`.
- Optional `Idempotency-Key` header (≤256 chars) replays the original `201` for 24 hours;
  replayed responses carry `Idempotency-Replay: true`.
- Response `201`: `{ deployment, url, claim?, files, size, status, password, via, created, expires }`.
  `claim` and `expires` are present only for anonymous deployments. Anyone holding the `claim`
  URL can take ownership of the deployment, so it must never be presented as a share link.
- `GET https://api.shipstatic.com/limits` returns the live limits and blocklist.

### aft.page — `aft-page`

- `POST https://api.aft.page/v1/deploy`.
- Body may be raw HTML, `{"files": [{"path", "content", "encoding"}]}`, or multipart with
  `file0`, `file0_path`, `file1`, `file1_path`, …
- Query: `?slug=` (optional) and `?expires=` (anon quick-view, e.g. `24h`).
- Response: `{ ok, slug, deployId, url, files, bytes, editToken, claimUrl, owned, notice }`.
- Updates use `PATCH /v1/deploy?slug=` with header `X-Aft-Edit-Token`.
- Unclaimed sites are deleted after 30 days idle, so expiry is not a fixed deadline.

### here.now — `here-now`

- The only multi-step protocol:
  1. `POST https://here.now/api/v1/publish` with
     `{ files: [{ path, size, contentType, hash? }], spaMode?, displayName? }`.
  2. `PUT` each file to the presigned `*.r2.cloudflarestorage.com` URL from
     `upload.uploads[]`, using exactly the returned headers. **Egress to both hosts is required.**
  3. `POST https://here.now/api/v1/publish/{slug}/finalize` with `{ versionId }`.
- Finalize is **idempotent by `versionId`**; a retry of a completed finalize returns
  `{ success, replayed: true }`. Concurrent finalize returns `409 finalize_in_flight` with
  `Retry-After`. A stale `baseVersionId` returns `409 version_conflict`.
- Anonymous responses carry `claimToken` (returned exactly once) and `claimUrl`
  (`https://here.now/c/<token>`) which must be copied byte for byte.
- `publishStatus` is the authoritative ownership/persistence source.

### Show — `show`

- `POST https://show.127.dev/upload`, `multipart/form-data`, fields `file` (a **tar.gz**
  archive), `name`, and optional `mode=spa`.
- Response: `{ deploymentId, url, createdAt, expiresAt, mode, requestId }`.
- No claim URL and no edit key: Show is purely ephemeral.

### Dropley — `dropley`

- `POST https://dropley.app/api/artifacts`, `multipart/form-data`.
- Parts: one `file` part per file (part name is literally `file`), plus a `manifest` field that
  is a **JSON string**:
  `{"manifestVersion":1,"entry":"index.html","files":[{"path","size","contentType"}]}`.
- Strict validation: `manifestVersion` must be `1`, `entry` must be `index.html` and present in
  `files`, every file entry must carry `contentType`, and the number of `file` parts must equal
  `manifest.files.length` exactly. Positions must line up.
- Optional fields: `expiry` (`1d`/`3d`/`7d`), `source`, `tags`.
- Response `201`: `{ shortId, url, expiresAt, artifactToken }`.
- Rate limited to 5 uploads/hour; `429` always carries `Retry-After`.

## Persistent providers

`netlify`, `cloudflare-pages`, `vercel`, and `github-pages` are driven through their bundled
CLIs in the optional deploy directory (`VERIFIED_PUBLISH_DEPLOY_HOME`, or whatever
`netlify` / `wrangler` / `vercel` the operating system already provides on `PATH`). They are only
selected when the
project already has provider configuration or the provider CLI is authenticated. A failed
persistent provider must never silently downgrade a `persistent` request to an anonymous
temporary host.

## Live observations added by the publish-cli implementation (2026-09-10)

These were measured against the live services with
`tools/probe-contracts.mjs`. They refine, and in three cases
contradict, the documented behaviour above. The registry records them in each provider's
`verification` block and the adapters implement them.

1. **ship.page accepts `application/zip`.** The documented reference is the JSON file map, but a
   raw zip POST to `https://ship.page/deploy` with `?ttl=` returns the documented response shape.
   The zip transport is used because it preserves bytes exactly, which remote SHA-256 verification
   requires. A 62-file Vite artifact was served byte-identical for every file.
2. **ShipStatic requires the part name `files[]` and rejects the optional `ttl` field.** Sending
   `ttl` in anonymous mode fails with `403 forbidden: An expiring deployment requires a credential`.
   Omitting it uses the platform schedule and the response `expires` is epoch **seconds**.
3. **ShipStatic silently drops zero-byte file parts.** A deployment containing an empty file (for
   example a committed `.gitkeep`) fails with
   `Files count (n) must match checksums count (n+1)`. The adapter treats that as a capability
   failure before uploading.
4. **ShipStatic rewrites served HTML**, appending `?_ship=<id>` to asset URLs. JS/CSS/font bytes
   are served unchanged. The registry therefore marks it `htmlPolicy: presence-only`, so its HTML
   is presence-checked and every other resource is still SHA-256 compared.
5. **here.now returns `upload.versionId`, `upload.finalizeUrl` and `siteUrl`**, and rejects a
   finalize whose `versionId` is null with `400 invalid_type`. The adapter reads those exact
   fields and never posts a null versionId. here.now injects Open Graph meta tags into the served
   `index.html`, so it is also `htmlPolicy: presence-only`.
6. **aft.page does not serve the uploaded HTML at all.** A 416-byte `index.html` was served as
   9873 bytes (9461 without the import-map banner): a generated wrapper/summary page. Its
   `url` field is present and correct, but the served output can never satisfy a byte comparison,
   so it is excluded from the default plan and only selectable with `--allow-inexact`.
7. **Show returns its URL on a `*.127.dev` subdomain** (`https://<id>-<name>.127.dev`), not on
   `show.127.dev` itself, and enforces 5 uploads/hour/IP with an explicit `Retry-After: 3600`.
8. **Dropley's allowlist rejects `.ttf`, `.woff`, `.woff2` and extensionless files** with
   `422 VALIDATION_ERROR`. A typical Vite artifact therefore cannot be served by Dropley, which is
   consistent with the decision to treat its unpublished allowlist as unsupported.
9. **wh-drop remains unimplemented.** No host, documentation or API was found, and
   `adapterAvailability()` returns false for it so it can never be dispatched even if an overlay
   re-enables it.
