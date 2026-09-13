# Anonymous compliance results

Every login-free candidate is judged by the same harness (`tools/check-anonymous.mjs`), so the results
are comparable. Run it with `node tools/check-anonymous.mjs <id>` (or `--list`).

## Method

1. Build a fixture with a random nonce (`index.html` + `assets/app.js` + `assets/app.css`) and hash it locally.
2. Package it the way the candidate documents (multipart part, or the archive as the raw request body)
   and upload it **with no credential**.
3. Capture the response with credential-shaped values masked.
4. Read the result back — root, HTML and both assets — with a short retry, and compare SHA-256 with the
   local bytes.
5. Check the platform itself (`liveness`) and write a record following
   `../received-anonymous-provider-evidence.schema.json`.

Classification: `independent-public` (root + marker + every asset verified) · `partial-preview` (root
loads, an asset does not) · `network-bound-preview` · `login-free-upload-only` (upload works, no reader
can open it) · `auth-required` (the anonymous endpoint refuses the upload).

**Cross-egress caveat:** no second independent network was available, so `crossEgressRead` is `null` in
every record and `shareability` stays `unverified`. A candidate may only be enabled in the registry once
a second network confirms the read.

## Results — 2026-09-13

| Candidate | Upload | Read-back | HTML | Classification | Record |
|---|---|---|---|---|---|
| **flypod** | `POST https://flypod.dev/sites`, zip as the raw body, no credential → **200** | root **200** with the nonce; `assets/app.js` and `assets/app.css` **byte-identical** | injected (+~1070 bytes): the response reports `render.status: pending`, i.e. its own instrumentation is added to the served page | **`independent-public`** (same egress) | `flypod.json` |
| DropCat | `POST https://api.drop.cat/deploy` → **201** with `siteId`, `url`, `expiresAt`, `key`, and the hint "your site is live … no further action needed" | root, HTML and both assets **404**, also after 45 s of polling; the platform's own `screenshot` URL is 404 too; the apex `drop.cat` serves a **"Coming Soon"** page | — | `login-free-upload-only` — in fact a service that only pretends to deploy | `dropcat.json` |
| Sitebin | `POST https://app.sitebin.io/api/sites` → **401** | n/a | n/a | `auth-required` — the documented anonymous-looking `curl` needs a session | `sitebin.json` |

### flypod specifics (worth keeping)

- Anonymous TTL: `expires_at` = 1790492273606 ms → **14 days** after the probe, matching its docs.
- It returns both a `manage_token` (redeploy/rollback/read for that site) and a **`claim_token`**
  (attach the deployment to an account later). These are capability-bearing: the harness masks them in
  the record, and an adapter must store them like every other claim.
- `next_actions` advertises `GET /sites/:id` and `POST /sites/:id/deploys`.
- Its HTML is not byte-identical, so an adapter must declare `htmlExact: false` for the served page
  while the assets remain strictly comparable.

### Dropage and Sitebin, for completeness

- **Dropage** (`dropage.online`, China-oriented): the homepage advertises a copyable "API 使用指南", but
  `/docs` and `/api` both answer **410 Gone** and no endpoint is discoverable, so there is nothing to
  automate yet. It stays in the research catalog, not in the harness.
- **Sitebin**: the anonymous tier is a browser flow; the API answers 401 to an unauthenticated POST.

## Registry decision

- **flypod** is registered **`enabled: false`** with a reason that states exactly what was verified
  (anonymous upload, per-asset byte equality, 14-day TTL, claim/manage tokens) and what is missing
  (a read from a second network). Flipping it on requires one cross-egress run, not more documentation.
- **DropCat** and **Sitebin** are not added to the runtime registry: they are recorded here. A provider
  row exists to describe something a user can deploy to; a dead endpoint and an auth-required endpoint
  are research findings, not hosting options.
