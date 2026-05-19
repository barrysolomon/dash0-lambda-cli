/**
 * Feature flags. Flip a constant here to gate UI affordances across the
 * CLI/TUI without hunting for scattered conditionals.
 *
 * Conventions:
 *   - Flags are boolean constants, not env vars or runtime config — they're
 *     deliberate code-level decisions that ship with the build.
 *   - "Disabling" a feature means hiding *new-configuration* affordances
 *     (pickers, prompts, menu options). Read-only / inspection paths
 *     (validate, secret show, EnvManage display) stay functional so users
 *     can audit existing deployments that already use the disabled feature.
 *   - CLI flags backing a disabled feature stay silently functional so
 *     scripted users don't break — but we drop them from the install
 *     wizard's chooser UI.
 */

/**
 * When true, hide AWS Secrets Manager as an option for *creating* new
 * Dash0 token configurations. The literal `DASH0_TOKEN` env var becomes
 * the only offered choice. Existing functions wired to a secret still
 * read/display correctly via `validate` and `secret show`.
 */
export const SECRETS_DISABLED = true;
