# Limits research, 2026-09-13

Three passes were needed to measure size ceilings honestly, and the files are named so the difference
cannot be misread later.

## Pass 1 — `size-<channel>.json` (NOT a service measurement)

An artifact just over each documented ceiling was submitted through the **CLI**, so the **planner**
refused it first, quoting our own registry values (`accepts at most 26214400 bytes in total`, and so on).
That is a useful check of the registry, but it says nothing about the provider. Treat these files as
evidence about *our data*, not about the services.

## Pass 2 — `size2-<channel>.json` (service answers)

The adapters were called **directly**, bypassing the planner. Three channels refused with their own
errors, which is the measurement we wanted:

| Channel | Attempt | Provider's answer |
|---|---|---|
| shipstatic | 21 MB file | `400 File too large. Maximum 20 MB allowed.` |
| aft-page | 26 MB file | `400 file_too_large max: 26214400` |
| BrewPage | 6 MB file | `400 File 'big.woff2' exceeds maximum size of 5242880 bytes` |

`ship-page` and `show` refused **before sending**: their adapters pre-check `capabilities.maxTotalBytes`
client-side. Good behaviour, but again not a service measurement.

## Pass 3 — `size3-<channel>.json` (client pre-check raised)

Only that one capability value was raised so the request reached the provider:

| Channel | Attempt | Provider's answer |
|---|---|---|
| ship-page | 26 MB | `413 zip too big (25MB max on free plan)`, code `zip_too_large` |
| show | 11 MB | `413 UPLOAD_TOO_LARGE: Upload exceeds 10MB limit` |

**Conclusion: every documented size ceiling is really enforced by the provider.** ship-page's is
specifically a *free-plan* limit, and its error names an upgrade path.

Payload extensions were chosen per channel (`.glb` where accepted, `.woff2` for show and BrewPage) so a
type rule could not be mistaken for a size result.

## File counts — `<channel>.json` and `summary.json`

A 102-file artifact (100 files in one directory, ~2 KB) went to every directory-capable channel:

- ship-page, show and BrewPage refuse it **before upload** with `accepts at most 100 files, artifact has 102`;
- shipstatic served 102/102; aft-page, flypod and shiply verified every file except the page itself,
  which their own rewriting makes presence-checked;
- dropley refused it outright: `File type not allowed: many/f001.txt`;
- here-now answered `502 Application failed to respond` at finalize on the first attempt, then succeeded
  twice with 102/102 verified (97 s and 120 s) — transient, but the slowest channel measured.

**No channel silently dropped a file.** That is the finding this pass existed for.
