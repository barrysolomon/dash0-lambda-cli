# CLAUDE.md

Unofficial community CLI/TUI that wraps the [Dash0 Lambda extension](https://github.com/dash0hq/dash0-lambda-extension) — installs, validates, switches between Dash0/Lumigo, migrates, and generates IaC snippets across AWS Lambda functions.

**Author**: Barry Solomon (personal project, not Dash0-affiliated). Apache-2.0.

## Read [README.md](README.md) first

The README is comprehensive and current — covers prerequisites, build, run, dev workflow, AWS auth, and dependency management. This file complements it with the things a fresh Claude session can't infer.

## Build & Test

```bash
npm ci                              # First-time install (use ci, not install — keeps lockfile stable)
npm run build                       # tsc → dist/
npm test                            # vitest run (the test/ directory has 11 suites)
npm run lint                        # tsc --noEmit
npm run dev                         # tsx — run TS directly without building

./dash0-lambda                      # Wrapper that auto-builds if dist/ is stale; use day-to-day
./dash0-lambda --help               # Subcommand list
```

The `./dash0-lambda` wrapper is the canonical entry point — it handles `npm ci` if `node_modules/` is missing AND a stale-`dist/` rebuild check. Don't bypass it casually.

## Architecture

```
src/
├── cli.ts                # entry point, argv parsing, subcommand dispatch
├── menu/                 # full-screen TUI (interactive mode)
├── tui/                  # TUI rendering primitives
├── commands/             # subcommand implementations (install, validate, switch, migrate, etc.)
├── layers/               # Lambda layer ARN resolution + AWS SDK wrappers
├── iac/                  # IaC snippet generators (Terraform, CloudFormation, SAM, CDK)
└── lib/                  # shared utilities (auth, env, prompts, console URLs)

test/                     # vitest suites — one per major lib/command module
scripts/release.sh        # release packaging
```

The flow: user runs `dash0-lambda` → either drops into `menu/` (interactive) or `commands/` (flag-driven). Both call into `layers/` (AWS SDK calls) and `iac/` (offline snippet generation).

## Key conventions

- **Node.js 20+ required.** AWS SDK v3 dropped Node 18 in January 2026. `.nvmrc` pins this.
- **AWS SDK v3, ES modules** (`"type": "module"` in `package.json`). Use `import`, not `require`. Files end in `.js` in imports even though source is `.ts` — that's correct for ESM/TS.
- **Credential chain**: defer to AWS SDK default chain (env vars, `AWS_PROFILE`, IAM Identity Center SSO). Don't add custom credential plumbing.
- **`bin/dash0-lambda`** is in `package.json` as the npm bin. The wrapper script at repo root is for development; the npm bin points at `dist/cli.js` (compiled).

## Gotchas

- **Lumigo support is a first-class peer to Dash0** — this CLI handles both vendors. The `switch` subcommand toggles between them. Don't assume Dash0-only when reading code.
- **The `release/` and `dist/` directories are build outputs** — gitignored, but present locally. Don't edit them.
- **`dash0-lambda-bun.zip` and `dash0-lambda-bun/`** — these are Bun-based experimental builds, not the primary path. The Node 20 toolchain is canonical; Bun is exploratory.
- **`prepack` runs `npm run build && npm test`** — packing for distribution will fail if tests fail. Don't skip with `--ignore-scripts` to "save time" without understanding why a test is failing.

## Releasing

`scripts/release.sh` packages a release. Not on npm — distribution is from-source via `git clone`. Update version in `package.json` before tagging.

## Dependency philosophy

`npm ci` for everyone except the person intentionally bumping versions; that person uses `npm install`, commits both `package.json` AND `package-lock.json`. The README spells this out — follow it.
