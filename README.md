# dash0-lambda-cli

> **Unofficial / community tool by Barry Solomon.** Not affiliated with,
> endorsed by, or published by Dash0 Inc. A personal project that wraps
> the [Dash0 Lambda extension](https://github.com/dash0hq/dash0-lambda-extension)
> with a full-screen TUI and flag-driven CLI for install, update,
> validate, switch (Dash0 ↔ Lumigo), migrate, and IaC snippet generation.
> The extension itself is the official thing — this just drives it.
>
> Apache-2.0 licensed. See [LICENSE](LICENSE).

## Status

Not on npm. Build and run from source.

## Build from source

### Prerequisites

- **Node.js 20+** (AWS SDK v3 dropped Node 18 in January 2026). An
  `.nvmrc` is included — if you use `nvm`, `nvm use` from the project
  root picks it up.
- **AWS credentials** in your environment (the CLI uses the default AWS
  SDK credential chain — env vars, `AWS_PROFILE`, IAM Identity Center
  SSO, etc.).
- The **`aws` CLI** is recommended (only needed if you want the menu's
  "Run aws sso login" remediation flow).

### First run from a fresh clone

```bash
git clone <this-repo>
cd dash0-lambda-cli

# Reproducible install from package-lock.json. Use `npm ci` (not
# `npm install`) the first time — it's faster and won't drift the
# lockfile. If node_modules already exists, npm ci wipes it first.
npm ci

# Compile TypeScript to dist/
npm run build
```

The included `./dash0-lambda` wrapper handles both of those steps for
you — if `node_modules/` is missing it runs `npm ci`, and if any source
file is newer than `dist/cli.js` it runs `npm run build` before
launching. Day-to-day you just do:

```bash
./dash0-lambda                    # interactive menu
./dash0-lambda --help             # subcommand list
./dash0-lambda install -f orders-create -r us-west-2 \
  --endpoint https://ingress.us-west-2.aws.dash0.com:4318
```

### Updating dependencies

Use `npm install` (not `ci`) when you intentionally want to bump or add
a package — that updates `package-lock.json`. Everyone else then runs
`npm ci` to sync.

```bash
npm install some-new-dep        # updates package.json + package-lock.json
git add package.json package-lock.json
git commit -m "deps: add some-new-dep"
```

### PATH-wide access

For convenience, either symlink the wrapper or `npm link`:

```bash
ln -s "$PWD/dash0-lambda" /usr/local/bin/dash0-lambda
# or:
npm link
```

### During development

Run TypeScript directly without building (uses `tsx` from devDependencies):

```bash
npm run dev -- --help
npm run dev -- list --region us-west-2
```

Tests:

```bash
npm test                # one-shot
npm run test:watch      # vitest watch mode
```

## Quickstart

Run with **no arguments** to launch the full-screen TUI — banner with
live AWS identity, persistent footer with hotkeys, and screens that
redraw in place (no scrolling history). What lazygit / k9s / Wrangler
feel like, but for managing the Dash0 Lambda extension.

```bash
./dash0-lambda
```

```
╭───────────────────────────────────────────────────────────────────╮
│ dash0-lambda · interactive TUI (unofficial)            account 139… as barry-dev · profile barry-dev · region us-east-1 │
╰───────────────────────────────────────────────────────────────────╯

  Functions in us-east-1  (21 · 3 selected)              last refresh 4s ago

    name                                  runtime         dash0          lumigo    endpoint
    ❯ ErrorLogWith400                     nodejs18.x      —              yes       —
    ● orders-create                       nodejs20.x      v11/node        —         https://ingress.us-…
    ● orders-charge                       nodejs20.x      v11/node        —         https://ingress.us-…
      payments-refund                     python3.12      —              yes       —

╭ ↑↓ nav   / filter   ␣ select   i install   v validate   u uninstall   o open   r refresh   esc back        a profile   R region   ? help   q quit ╮
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

### Headline features

- **Live function list** with `/` filter, `r` refresh, `space` multi-select,
  and per-row Dash0/Lumigo status. `i`/`v`/`u`/`o`/`s`/`U` act on the
  highlighted row OR the selected set.
- **Live CloudWatch log tailer** in the validate screen — pings the function's
  log group every 2s and highlights `dash0-extension` lines so you see the
  boot output in real time.
- **Update layer in-place** — `U` on a row (or selection) bumps the attached
  Dash0 layer to the CLI's known-current version without touching token,
  dataset, or other env vars. The screen shows current → target per function
  and skips no-ops automatically.
- **Toggle Dash0 ↔ Lumigo** — `s` flips the active vendor by changing
  `AWS_LAMBDA_EXEC_WRAPPER` (and `LUMIGO_SWITCH_OFF` to prevent
  double-instrumentation). Both layers must already be attached; the toggle
  doesn't install layers, it activates one of two that are already there.
- **Account / region switcher hotkeys** — `a` opens an SSO profile picker,
  `R` opens a region picker. Both update global state and re-render every
  screen.
- **SSO remediation built in** — when AWS creds fail, you auto-route to a
  recovery screen with PKCE / device-code login (handles the "browser said
  success but CLI didn't get the token" issue from CLI v2.22), manual
  paste-creds escape hatch, and a "let me into the read-only screens
  anyway" bail-out so you never get trapped.
- **Bulk operations** — select N functions with space, then press `i` to
  install (or `U` to update layer, or `s` to flip vendors) on all of them
  in one go with a shared confirmation.

### Flag-driven mode (scripting / CI)

Every screen is also a flag-driven subcommand:

```bash
./dash0-lambda install -f orders-create -r us-west-2 \
  --endpoint https://ingress.us-west-2.aws.dash0.com:4318 \
  --token "$DASH0_TOKEN"

./dash0-lambda list --region us-west-2 --only-lumigo --format json
```

By default the CLI only sets the **required** env vars (`DASH0_ENDPOINT`,
`DASH0_TOKEN` or `DASH0_TOKEN_SECRET_ARN`, and `AWS_LAMBDA_EXEC_WRAPPER`).
Every other extension knob is opt-in via a flag.


## Commands

| Command                  | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `install`                | Attach the Dash0 layer + set DASH0_* env vars on a function                 |
| `update`                 | Bump the attached Dash0 layer to the CLI's known-current version (no env changes) |
| `uninstall`              | Remove the Dash0 layer + DASH0_* env vars                                   |
| `validate` (`doctor`)    | Health-check a function's wiring; nonzero exit on failure                   |
| `list` (`status`)        | List functions in a region; columns: dash0, lumigo, endpoint, dataset       |
| `migrate`                | Replace Lumigo with Dash0 (single function or `--filter REGEX`)             |
| `switch`                 | Toggle a function between Dash0 and Lumigo by changing `AWS_LAMBDA_EXEC_WRAPPER` |
| `generate <flavor>`      | Emit IaC snippets: `terraform`, `sam`, `cdk-ts`, `serverless`               |
| `menu`                   | Launch the full-screen interactive TUI (default when no subcommand given)   |

Run `dash0-lambda <command> --help` for the full flag list.

Common one-liners:

```bash
# Update layer version in-place across a fleet (script the bulk path):
aws lambda list-functions --region us-west-2 --query 'Functions[?contains(Layers[].Arn, `dash0-extension`)].FunctionName' --output text \
  | xargs -n1 -I{} ./dash0-lambda update -f {} -r us-west-2

# Flip a function from Dash0 → Lumigo (both layers must be attached):
./dash0-lambda switch -f orders-create -r us-west-2 --to lumigo --dry-run
```

## TUI hotkey reference

**Global** — work on every screen:

| Key       | Action                                            |
| --------- | ------------------------------------------------- |
| `q`       | Quit (from home only)                             |
| `Ctrl-C`  | Quit (anywhere)                                   |
| `esc`     | Back / cancel                                     |
| `?`       | Open help overlay                                 |
| `a`       | Switch AWS profile (SSO-aware picker)             |
| `R`       | Switch AWS region                                 |

**Functions screen** — the main worktable:

| Key            | Action                                                     |
| -------------- | ---------------------------------------------------------- |
| `↑` `↓`        | Navigate                                                   |
| `PgUp` `PgDn`  | Page up / page down                                        |
| `g` / `G`      | Jump to top / bottom                                       |
| `/`            | Filter (live; Enter applies, esc clears)                   |
| `space`        | Toggle selection on highlighted row                        |
| `A`            | Select all (filtered set)                                  |
| `x`            | Clear selection                                            |
| `r`            | Refresh list (re-runs `lambda:ListFunctions`)              |
| `enter` or `i` | **Install** Dash0 on the highlighted row or selection      |
| `v`            | **Validate** (run doctor checks)                           |
| `u`            | **Uninstall** Dash0                                        |
| `U`            | **Update** the attached Dash0 layer to current version     |
| `s`            | **Switch** vendor (Dash0 ↔ Lumigo wrapper toggle)          |
| `o`            | Open the function in the AWS console                       |

The hotkey row at the top of the Functions screen also shows a
context-aware hint: with no selection, it lists `␣ select  A all  x clear`;
with a selection, it lists which actions will hit the selected set.

## Authentication

Two ways to give the extension your Dash0 token:

1. **Plain env var** — `--token auth_xxx`. Easy, but the token sits in the
   function's environment configuration in plaintext.
2. **Secrets Manager** — `--token-secret-arn arn:aws:secretsmanager:...`. The
   extension fetches the secret at cold start. Requires the function role
   to have `secretsmanager:GetSecretValue` on that ARN. If your secret
   stores a JSON object, also pass `--token-secret-key dash0_token`.

If both `DASH0_TOKEN` and `DASH0_TOKEN_SECRET_ARN` are set on the function,
the extension uses `DASH0_TOKEN`. The CLI's `validate` command warns when
both are present.

For IaC, prefer `--token-from-ssm /dash0/prod/token` so the token never
ends up in source control.

### A note on AWS SSO caching

`aws sso login` caches access + refresh tokens at `~/.aws/sso/cache/`.
When you re-run it, the CLI **first checks the cache** — if a valid
token is there it returns immediately, even if the browser tab opens
optimistically. That means:

- **Closing the browser tab is fine** when the cache is good. The CLI
  was already done before the page even loaded.
- **The risk**: if the cached token is bound to the wrong account
  (a previous login with a different Google/Azure profile, say), the
  next `aws sso login` may silently reuse it. The TUI's auth-error
  screen has a **"Force fresh login"** option per profile that runs
  `aws sso logout` first to invalidate the cache, then logs in for real.
- The cache is keyed by `sha1(sso_session_name)` — different profiles
  sharing one SSO session share one cache entry.

## Mapped flags → env vars

The install command exposes the Dash0 extension knobs as flags. The full
mapping (run `dash0-lambda install --help` for descriptions):

| Flag                                   | Env var the extension reads                |
| -------------------------------------- | ------------------------------------------ |
| `--endpoint`                           | `DASH0_ENDPOINT`                           |
| `--token`                              | `DASH0_TOKEN`                              |
| `--token-secret-arn`                   | `DASH0_TOKEN_SECRET_ARN`                   |
| `--token-secret-key`                   | `DASH0_TOKEN_SECRET_KEY`                   |
| `--dataset`                            | `DASH0_DATASET`                            |
| `--service-name`                       | `OTEL_SERVICE_NAME`                        |
| `--extension-log-level`                | `DASH0_EXTENSION_LOG_LEVEL`                |
| `--distro-debug`                       | `DASH0_DISTRO_DEBUG=true`                  |
| `--disable-auto-instrumentation`       | `DASH0_DISABLE_AUTO_INSTRUMENTATION=true`  |
| `--no-send-on-invocation-end`          | `DASH0_SEND_ON_INVOCATION_END=false`       |
| `--xray-traces-enabled`                | `DASH0_XRAY_TRACES_ENABLED=true`           |
| `--no-create-payload-log-records`      | `DASH0_CREATE_PAYLOAD_LOG_RECORDS=false`   |
| `--disable-telemetry-log-collection`   | `DASH0_DISABLE_TELEMETRY_LOG_COLLECTION=true` |
| `--request-timeout-ms`                 | `DASH0_REQUEST_TIMEOUT`                    |
| `--mask-rules` (JSON array)            | `DASH0_MASK_RULES`                         |
| `--mask-env-vars` etc.                 | `DASH0_MASK_ENV_VARS`, ...                 |
| `--resource-attribute KEY=VAL` (xN)    | `OTEL_RESOURCE_ATTRIBUTES`                 |
| `--env KEY=VAL` (xN)                   | escape hatch — sets any env var verbatim   |

## Layer publisher account & version

By default the CLI looks up layers in account `115813213817` (the canonical
Dash0 publisher) at the version pinned in
[`src/lib/layers.ts`](src/lib/layers.ts) (currently **v11** for every family).
The CLI does **not** call `lambda:ListLayerVersions` by default — the
canonical Dash0 layers grant you `GetLayerVersion` (so you can attach them)
but not List, so dynamic version discovery would fail with AccessDenied for
most users. Bump `KNOWN_LATEST_LAYER_VERSION` in `layers.ts` when Dash0
cuts a new release.

Override per-invocation:

```bash
./dash0-lambda install ... --layer-version 7           # pin to a specific version
./dash0-lambda install ... --layer-owner 139457818185  # use rehosted layers
# or set the publisher globally:
export DASH0_LAYER_OWNER_ACCOUNT=139457818185

# When Dash0 ships a new release: bump KNOWN_LATEST_LAYER_VERSION in
# src/lib/layers.ts, then update each function's layer in place — no
# token, no env-var changes, just a layer ARN swap:
./dash0-lambda update -f orders-create -r us-west-2
./dash0-lambda update -f orders-create -r us-west-2 --layer-version 7   # pin
```

In the interactive TUI, the **Install** wizard's review screen and the
**Update layer** screen both expose a `v` hotkey to pin a target version
(blank+⏎ clears the pin). The pin is a single number applied to every
runtime family in the selection — matches the CLI flag's semantics.

Layers are published in every supported AWS region under the same version
number, so the same `--layer-version` works regardless of the function's
region.

## Supported runtimes

| Runtime family | AWS Lambda runtimes                                              | Wrapper          |
| -------------- | ----------------------------------------------------------------- | ---------------- |
| `node`         | nodejs18.x, nodejs20.x, nodejs22.x                                | `/opt/wrapper`   |
| `python`       | python3.9 → python3.13                                            | `/opt/wrapper`   |
| `java`         | java11, java17, java21                                            | `/opt/wrapper`   |
| `manual`       | provided.al2023, ruby3.x, anything else (you call the SDK yourself) | _none_         |

Force a family with `--family <name>` if the auto-detect picks wrong (e.g.
custom runtime that hosts a Node.js handler).

## Containerized (Docker) Lambdas

This CLI manages **layer-based** Lambdas. For container-image Lambdas, the
extension ships official Docker images that you `COPY --from` in a
multi-stage build. See the upstream README's
[Dockerized Lambdas](https://github.com/dash0hq/dash0-lambda-extension#dockerized-lambdas)
section. After your container is deployed, this CLI's `validate` command
will still inspect the function's env vars and report wiring issues.

## Output formats

`list` and `validate` both support `--format json` for scripting. Example —
find every Node function in us-west-2 still on Lumigo:

```bash
dash0-lambda list --region us-west-2 --only-lumigo --format json \
  | jq -r '.[] | select(.runtime | startswith("nodejs")) | .name'
```

## Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success                                                  |
| 1    | Generic / unexpected error                               |
| 2    | Invalid CLI input (validation error)                     |
| 3    | AWS API error                                            |
| 4    | `validate` reported one or more FAIL-level checks        |
| 5    | `migrate` had at least one failed function               |

## Contributing

```bash
npm install
npm run dev -- list --region us-west-2     # live-run the CLI under tsx
npm test
npm run build
```

PRs welcome.

## License

Apache-2.0.
