# Troubleshooting

Things that have actually cost time on a real machine. Each entry says what you see, why, and the
one-line fix.

## `git` cannot reach GitHub, but everything else can

**Symptom:** `git push` or `git ls-remote` fails with
`schannel: failed to receive handshake, SSL/TLS connection failed`, while `npm` and plain HTTPS
requests work.

**Why:** a system proxy configured for git (for example `http.proxy=http://127.0.0.1:10808`) that
cannot tunnel TLS to github.com, even though the proxy port is listening.

**Fix:** bypass the proxy for that command:

```console
$ git -c http.proxy= -c https.proxy= push
```

Or remove the broken setting: `git config --global --unset http.proxy`.

Related: do **not** set `GCM_INTERACTIVE=Never` when a stored credential is expected. Git Credential
Manager then refuses to use it in a non-interactive shell and the push fails with
`could not read Username for 'https://github.com': terminal prompts disabled`.

## `Invoke-WebRequest -OutFile` disagrees about file bytes

**Symptom:** a PowerShell download of a deployed file has different bytes and a different SHA-256 than
the local file, while `vpublish verify` and other HTTP clients agree that they match.

**Why:** `Invoke-WebRequest -OutFile` is not a byte-exact oracle — it produced a 644-byte file where two
other clients agreed on 277 bytes for the same URL and headers.

**Fix:** compare bytes with `vpublish verify <url> <dir>`, or with a Node/curl request that sends the
same headers you care about. Do not conclude that a host rewrites content from a PowerShell comparison
alone.

## A host serves different HTML to browsers

**Symptom:** `verification.browserRepresentation.identical` is `false` while the run still passes.

**Why:** an edge network (Cloudflare in front of ship.page, for example) injects a real-time analytics
beacon for browser-like requests. The uploaded bytes are served to a plain `GET`; a browser gets the
upload plus injected markup.

**What to do:** nothing is broken. If the wrapped page is not acceptable, choose a different provider
or host the artifact yourself. The numbers are in the payload (`bytes`, `expectedBytes`, `addedBytes`)
so you can decide rather than guess. See [`verification.md`](./verification.md).

## Requests fail behind a corporate proxy

**Symptom:** every provider fails with a network error, or a provider times out.

**Fix:** set `HTTPS_PROXY` (and `NO_PROXY` for internal hosts), or pass `--proxy <url>`. Requests are
made without compression by default so verification compares origin bytes; a proxy that rewrites bodies
will therefore show up as a verification failure rather than as a silent difference.

## `npm publish` is refused with 403

**Symptom:** `403 Forbidden - PUT https://registry.npmjs.org/… - Two-factor authentication or granular
access token with bypass 2fa enabled is required to publish packages.`

**Why:** an account policy, not a token permission problem.

**Fix:** publish with a one-time password (`npm publish --otp=<code>`), or create a granular access
token with 2FA bypass, or publish from CI with Trusted Publishing. Details and the credential-hygiene
recipe are in [`releasing.md`](./releasing.md).

## A GitHub Pages deploy refuses a branch

**Symptom:** `the remote branch "gh-pages" is not owned by this tool…`

**Why:** the branch exists and its last commit was not written by this tool, so overwriting it would
destroy content (a custom-domain `CNAME`, hand-maintained files, another project's site).

**Fix:** publish to a different branch (`--branch pages-preview`), let a GitHub Actions Pages workflow
deploy instead, or — only if you are certain the branch is disposable — pass `--force-push`. The
`CNAME` file is carried over byte for byte either way.
