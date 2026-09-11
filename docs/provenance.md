# Origin and licence

`vpublish` is an **independent project**. It is not a component, plugin or sub-tree of another
product, and it is not "the publishing part of" one: its intended role is the reverse, as the
**upstream** that a downstream product depends on.

## Where the code came from

The implementation began inside the **Teacher DSH education edition**, where a classroom product
needed a publishing step that could prove what it had actually put online. That origin explains the
shape of the provider layer, and nothing more:

- **The provider protocols were measured for that use case.** The measurements in
  [`provider-protocols.md`](./provider-protocols.md) and in `config/providers.json`
  (`verification.status`) were taken against the live services on 2026-09-10 and re-probed on
  2026-09-11. They are ordinary evidence about public hosts, not product-specific behaviour.
- **The sector-specific safety rules were removed again.** The code once carried a `teacher` policy
  that refused names such as `grades.csv`. It does not any more: an upstream tool that guesses what a
  given user's data means is wrong for everyone else, and a rule that is wrong teaches people to
  bypass the scan. The core ships one fixed rule set — credentials, private keys and sensitive
  directories — and a downstream product enforces its own rules itself, using the per-path manifest
  that `inspect --json` already returns. [`consuming.md`](./consuming.md) shows how.

The measurements were carried over unchanged when the code became a standalone project. Editing them
to look tidier would have falsified evidence rather than refactored code.

## Relationship to the education edition

```text
vpublish  (this repository, the upstream)
    ↑  pinned dependency, consumed as a process; see consuming.md
Teacher DSH education edition  (downstream)
```

The dependency points **from** the education edition **to** this repository:

- this repository never imports, requires or detects a downstream product;
- a downstream product must not rely on internal paths here (`src/...`, internal function names) —
  only on the documented command surface, the `--json` contract and the policy/registry data files;
- product-specific naming stays downstream. The education edition is expected to ship its own alias
  (for example a `teacher-publish` shim that forwards to `vpublish --policy teacher`) rather than
  asking this repository to carry a product name.

[`consuming.md`](./consuming.md) writes that contract down as a checklist.

## Naming history

For tracing old references: `teacher-publish` (inside the education edition) → `verified-publish`
(the working name while the project was made standalone, and the name the first live probes ran under)
→ **`vpublish`** (the published name: shorter, and free on npm while `deploy-cli` — the repository
name — was already taken).

Compatibility is kept deliberately, and tested:

- environment variables from both earlier names are still read as fallbacks
  (`VERIFIED_PUBLISH_*`, `TEACHER_*`);
- a `gh-pages` branch published under the old commit trailer `X-Verified-Publish` is still recognised
  as ours instead of being reported as a foreign branch.

## Licence

MIT. The original copyright notice is retained in [`LICENSE`](../LICENSE) as the licence requires:

```text
Copyright (c) 2026 Anywhere Labs
Copyright (c) 2026 vpublish contributors
```

Redistribution — including inside a packaged desktop application — only has to keep that notice.
