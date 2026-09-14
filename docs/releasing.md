# Releasing

The package has no dependencies and no build step, so a release is a version bump, a green suite and
one registry call. The only part that has ever blocked is authentication — recorded here so it does
not have to be rediscovered.

## Pushing when git authentication blocks (encountered twice)

Two independent things have stopped a push on a workstation, and both are worth checking before
concluding that the remote is broken:

1. **A dead proxy in the repository config.** With `http.proxy` pointing at a local proxy that is no
   longer listening, git fails immediately with
   `Failed to connect to github.com port 443 via 127.0.0.1 … Could not connect to server`. Reads can
   still work if something else resolves them, so the symptom looks like "only pushes fail". Push with
   the proxy cleared:
   ```console
   $ git -c http.proxy= -c https.proxy= push
   ```
2. **A credential manager that cannot answer without a username.** In a non-interactive session,
   `git credential fill` with only `protocol` and `host` returns nothing and git reports
   `Cannot prompt because user interactivity has been disabled` / `unable to get password from user` —
   even when `git credential-manager github list` shows the account. Supplying the username makes the
   stored credential come back:
   ```console
   $ printf 'protocol=https\nhost=github.com\nusername=<account>\n\n' | git credential fill
   ```
   The credential is then usable for a single push without any dialog, for example through a one-shot
   `-c http.extraheader="Authorization: Basic …"`. Never write such a value to a file, a log or a commit.

If neither works, the stored credential genuinely needs re-authorisation; the fixes are an interactive
`git push`, `gh auth login` followed by `gh auth setup-git`, or adding an SSH key to the account.

## Before you publish

```console
$ npm test                 # unit + integration tests, offline
$ node tools/smoke.mjs      # command surface, --json discipline, exit codes
$ node tools/check-imports.mjs
$ npm pack --dry-run        # the exact file list that would be uploaded
```

`npm pack --dry-run` is the honest check that matters: it shows the tarball contents, the packed and
unpacked size, the shasum and the integrity hash. If a file you expect is missing, it is a `files`
entry in `package.json`, not a packaging accident.

## Publishing

```console
$ npm publish            # needs a credential that can satisfy 2FA
```

npm **refuses a non-interactive publish** unless the credential can bypass two-factor
authentication. With an ordinary token the registry answers:

```text
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/vpublish - Two-factor authentication or
granular access token with bypass 2fa enabled is required to publish packages.
```

Two ways through:

1. **A one-time password.** Ask the account holder for the current 6-digit code and publish with
   `npm publish --otp=<code>`. Codes expire in about 30 seconds, so the round trip has to be quick.
2. **A granular access token with 2FA bypass.** npmjs.com → Access Tokens → Generate New Token →
   *Granular Access Token*, permission *Read and write*, packages *All packages* (or just
   `vpublish`), and enable *bypass 2FA*. This is the option that also works from CI.

For an automated release, prefer **Trusted Publishing**: configure the repository and workflow as a
trusted publisher on npm and publish from GitHub Actions with `id-token: write`. That removes the
long-lived secret entirely and attaches a provenance attestation to the published version.
`.github/workflows/ci.yml` already runs the suite on three platforms; a release workflow would add
`npm publish --provenance` on a tag.

## Credential hygiene

Never pass a token as a command-line argument: it lands in the process list and in shell history.
Put it in a config file that is outside the repository and delete it afterwards:

```powershell
$npmrc = Join-Path $env:TEMP ("npmrc-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
Set-Content -Path $npmrc -Value "//registry.npmjs.org/:_authToken=npm_…" -Encoding ascii -NoNewline
$env:NPM_CONFIG_USERCONFIG = $npmrc
npm whoami                  # confirm the credential before publishing anything
npm publish
Remove-Item $npmrc -Force
```

A token that has ever been pasted into a chat, an issue or a log should be revoked and regenerated:
npm → Access Tokens → delete, then create a new one.

## After publishing

```console
$ npm view vpublish version dist.tarball dist.integrity
```

Then check the package page once: the README renders, the version is the intended one, and
`npm install --global vpublish && vpublish --version` works on a clean machine.

There is nothing to unpublish gracefully — npm restricts unpublishing after 72 hours — so the check
before `npm publish` matters more than the check after it.

## Versioning

- `package.json#version` is the CLI version (semver).
- `schemaVersion` (in `src/identity.mjs`) versions the `--json` stdout contract. Bump it only for a
  breaking payload change, and say so in the changelog.
- `capabilitySchema` (in `config/providers.json`) versions the provider capability object. A registry
  declaring a version this build does not understand is refused rather than misread.
