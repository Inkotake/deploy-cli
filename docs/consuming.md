# Consuming vpublish from a product

This package is meant to be an **upstream**: a downstream product (for example the Teacher DSH
education edition) depends on it and pins it, instead of vendoring a copy of its source. This file is
the contract for that relationship — what a consumer may rely on, what it must not, and how to wire it
up.

## What a consumer may rely on

| Surface | Stability |
|---|---|
| Command name `vpublish` and the command list (`deploy`, `inspect`, `plan`, `verify`, `detect`, `providers`, `claim`, `doctor`, `tunnel`) | Semver-stable. |
| Flags documented in the README | Semver-stable. |
| `--json` payloads | Every payload starts with `schemaVersion` and `command`. A `schemaVersion` bump is a **breaking** change; treat it as such in the consumer's release notes. |
| Exit codes 0–9 | Stable; the README is the reference. |
| Policy names | There are none. The core ships one fixed safety rule set (credentials, private keys, sensitive directories) and it is not configurable; a consumer with its own rules applies them itself, as step 3 describes. |
| The provider registry **as data** | `capabilities` follow `capabilitySchema`; an unknown version is refused with a message rather than misread. Provider *sets* change as hosts appear and die — never depend on a fixed list. |
| Environment variables | `VPUBLISH_*` names are the contract; the older spellings stay readable as fallbacks. |

## What a consumer must not rely on

- Module paths inside this package (`src/...`) or any function that is not reachable through the CLI.
- The internal shape of `claims.json`, the health cache, or the snapshot directory.
- A specific provider being available. Ask `vpublish plan --json` or `vpublish providers --json`.
- Verification being complete for large artifacts: read `filesRequired` and `filesExpected`, not a
  screenshot of the summary line.

## Wiring it into a product

1. **Pin an exact version** (`"vpublish": "0.1.0"`), or vendor the tarball if the product promises an
   offline installer. Do not float a range: the JSON contract and the registry schema are versioned,
   and a silent minor bump could change a payload.
2. **Rename through an alias, not through this repository.** A product should ship its own shim
   (`teacher-publish` → `vpublish --policy teacher`) generated into a private, per-user command
   directory that is prepended to the process `PATH` only. This package will not carry a
   product-specific command name.
3. **Enforce your own data rules before calling `deploy`.** This package deliberately does not know
   what your users' data means: it blocks credentials and private material, and nothing else. If the
   product must refuse, say, classroom records, do it in the product:

   ```console
   $ vpublish inspect ./dist --json     # every path, size, mime and SHA-256
   ```

   Read `manifest` (the full file list) and apply your own allow/deny list. Refuse the publish, or
   remove the files, and only then call `deploy`. Doing it before the call is what makes the refusal
   binding: `deploy` re-inspects in-process, so anything still in the directory will be uploaded.
   Two patterns work: a deny-list of names the product's users are told about, or an allow-list of
   extensions a lesson artifact may contain (stricter, and easier to explain).
4. **Own the state directory.** Point `VPUBLISH_HOME` at a private per-user directory. In a packaged
   application the installation directory is read-only, and nothing here writes into it.
5. **Call it as a process with an argv array, never through a shell.** A path containing spaces, or a
   filename containing shell metacharacters, must not be able to change the meaning of the command.
6. **Read stdout as JSON and stderr as diagnostics.** The split is a promise: stdout is exactly one
   JSON document under `--json`.
7. **Treat `verification.passed` as the only success signal.** A URL that came back is not a working
   deployment, and this package says so in its own output; a consumer that shortcuts that rule
   reintroduces exactly the bug the tool exists to prevent.
8. **Provide your own tooling for persistent hosts** if the product promises them out of the box
   (`netlify`, `wrangler`, `vercel` CLIs, or `git` credentials for GitHub Pages). This package never
   installs or downloads anything; a missing CLI is reported as unavailable.
9. **Surface the claim credential carefully.** `deploy --json` reports that a claim exists and where
   it was stored, not its value. A GUI should reveal it through its own private channel, and an agent
   transcript must never contain it — that is why the default is hidden.

## Upgrading

Before moving the pin, run the consumer's own smoke against the new version and check:

```console
$ vpublish --version
$ vpublish doctor --json          # registry schema version, policy, region, provider table
$ vpublish deploy <fixture> --dry-run --json
```

If `schemaVersion` or `capabilitySchema` changed, adjust the consumer's parsing before shipping. If the
provider table changed, re-check whatever the product tells its users about hosting lifetime and
expiry.
