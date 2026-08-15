# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.20.0] — 2026-08-14

> **Versioning change.** From this release the CLI's **minor version tracks the
> Dash0 extension layer version it pins by default**: `dash0-lambda 0.20.x`
> installs `dash0-extension-*:20`. Read one number off `--version` and you know
> what your fleet gets. The jump from 0.13 to 0.20 is that alignment, not
> seven releases of changes. A test asserts the two stay in step, so bumping
> the layer pin without bumping the package version now fails CI.

### ⚠️ Action required if you ran `migrate --token-secret-arn` on v0.13.0 or earlier

`migrate` accepted `--token-secret-arn` but never attached the
`secretsmanager:GetSecretValue` policy to the function's execution role — a step
`install` has always performed. The migration reported success and the function
looked correctly configured, but the extension failed to read its token **at
invocation time**, not at migrate time. Telemetry silently stopped.

Repair affected functions in place, no redeploy required:

```bash
dash0-lambda validate -f <function> -r <region> --fix-secret-access
```

Functions migrated with a plaintext `--token` are unaffected.

### Added

- **`remove-lumigo`** (alias `untrace-lumigo`) — removes the Lumigo layer,
  `LUMIGO_*` env vars, and the Lumigo exec wrapper from one function or a whole
  fleet. It does *not* install Dash0; that is still `migrate`. Supports
  `--filter`, `--keep-env`, `--concurrency`, `--dry-run`, and `-y/--yes`.
  `AWS_LAMBDA_EXEC_WRAPPER` is cleared only when it points at a Lumigo wrapper,
  so untracing Lumigo can never un-instrument Dash0.
- Continuous integration on GitHub Actions: typecheck, build, and full test
  suite on Node 20 and 22, a `--help` smoke check for every subcommand, and a
  compiled Bun standalone binary that must report its own version.

### Fixed

- **`uninstall` could un-instrument a different vendor.**
  `AWS_LAMBDA_EXEC_WRAPPER` is listed among the Dash0-owned env keys because
  *install* writes it, so `uninstall` stripped it regardless of its value and
  only restored it when it read exactly `/opt/wrapper`. Any other value —
  Lumigo's `/opt/lumigo_wrapper`, or a customer's own shim — was silently
  deleted. Worst case, running `uninstall` against a Java function traced by
  Lumigo and carrying no Dash0 footprint at all reported `applied: true`, wrote
  to AWS, and killed Lumigo tracing. The wrapper is now preserved unless it is
  positively identified as Dash0's *and* `--clear-wrapper` was passed.

- **`list --format yaml` crashed with `ReferenceError: require is not defined`.**
  The YAML serializer was loaded through a lazy `require()`, which does not
  exist under Node's ESM loader in a `"type": "module"` package. This affected
  every Node-based invocation — `npm run dev`, the `./dash0-lambda` wrapper, and
  the installed npm bin. Bun standalone binaries were unaffected, because Bun
  tolerates `require` in ESM. Now a static import, which both loaders and Bun's
  bundler resolve. A new `esm-integrity` suite runs the compiled output in real
  `node` processes to catch this class of bug, which in-process tests cannot
  see: Vitest injects a CommonJS interop shim that makes the broken code pass.

- **`list --format json` truncated the endpoint.** Display shortening for the
  120-column table leaked into the machine-readable output and the returned
  rows, so `jq -r '.[].endpoint'` yielded a string ending in `…` rather than a
  URL — and two different long endpoints compared equal. Truncation is now
  applied only when rendering the table.

- **`migrate` dropped a customer's `OTEL_RESOURCE_ATTRIBUTES`.** The migration
  plan excluded the variable as "install owns this", but `migrate` re-adds only
  what `configToEnv` emits — nothing unless `--resource-attribute` was passed.
  Operator-set metadata (team, tier, deployment environment) vanished. It is now
  preserved; an explicit `--resource-attribute` still overrides it.

- **`migrate` did not grant the execution role access to the token secret.**
  See the notice above.

### Changed

- Pinned layer version bumped from **v11 to v20** across all four runtime
  families (node, python, java, manual) — and the package version now tracks it. Verified against live AWS: all four
  families exist at `:20`, and `dash0-extension-node:20` is present in all 16
  supported regions.

### Testing

Coverage extended from 181 to 330 tests across 26 suites — the eight previously
untested modules (`commands/switchVendor`, `commands/uninstall`,
`commands/secret`, `commands/list`, `lib/lambda`, `lib/errors`, `lib/features`,
`lib/output`) now each have a suite, plus a cross-cutting `esm-integrity` suite.
Every load-bearing guard was mutation-tested: the invariant was deliberately
broken and the tests confirmed to fail.

## [0.13.0] — earlier

See the git history for releases prior to this changelog.
