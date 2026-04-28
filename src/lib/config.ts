/**
 * Local config persistence so users don't have to re-enter every flag.
 *
 * Default location: `./.dash0-lambda.json` in the current working directory.
 * Override with `DASH0_LAMBDA_CONFIG=path/to/file.json`. The file stores
 * non-sensitive defaults (region, endpoint, dataset, profile) plus a
 * pointer to where the token lives — either an AWS Secrets Manager ARN
 * or a relative path to a local file containing just the token string.
 *
 * The literal token, if stored locally, lives in a separate file
 * (`./.dash0-lambda.token` by default) at chmod 0600. We never write the
 * literal token into the config JSON so that the JSON is git-friendly
 * (the user can commit it or share it with teammates).
 *
 * On save we also try to add `.dash0-lambda.token` to `./.gitignore` if
 * one exists, so a stray `git add .` doesn't ship the secret.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { warn } from "./output.js";

export const SavedConfigSchema = z.object({
  region: z.string().optional(),
  profile: z.string().optional(),
  endpoint: z.string().url().optional(),
  dataset: z.string().optional(),
  layerOwner: z.string().regex(/^\d{12}$/).optional(),
  /** Pre-pinned layer version (otherwise the CLI's known-current is used). */
  layerVersion: z.number().int().positive().optional(),

  // Token reference — at most one of the three is set.
  /** ARN of an AWS Secrets Manager secret holding the token. */
  tokenSecretArn: z.string().optional(),
  /** JSON key inside the secret (when the secret stores an object). */
  tokenSecretKey: z.string().optional(),
  /** Path (absolute or relative to the config file) to a local file
   *  containing only the token string. */
  tokenLocalFile: z.string().optional(),
});
export type SavedConfig = z.infer<typeof SavedConfigSchema>;

const ENV_OVERRIDE = "DASH0_LAMBDA_CONFIG";

export function configPath(): string {
  if (process.env[ENV_OVERRIDE]) return resolve(process.env[ENV_OVERRIDE]);
  return resolve(process.cwd(), ".dash0-lambda.json");
}

/**
 * Read config from disk. Missing file → empty config (not an error). Bad
 * JSON or schema mismatch → warn and return empty so the CLI never gets
 * stuck on a corrupt file.
 */
export async function loadConfig(): Promise<SavedConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = SavedConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      warn(`Config at ${path} ignored: ${parsed.error.errors[0]?.message}`);
      return {};
    }
    return parsed.data;
  } catch (err) {
    warn(`Config at ${path} ignored (parse error): ${(err as Error).message}`);
    return {};
  }
}

/** Merge the patch into existing config (existing wins for unset patch keys). */
export async function saveConfig(patch: SavedConfig): Promise<string> {
  const path = configPath();
  const existing = await loadConfig();
  const merged = stripUndefined({ ...existing, ...patch });
  const validated = SavedConfigSchema.parse(merged);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return path;
}

export async function clearConfig(): Promise<boolean> {
  try {
    await fs.unlink(configPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the literal token to a local file at chmod 0600. Returns the
 * absolute path written. The path stored in the config is relative to
 * the config file so the pair travels together.
 */
export async function saveTokenLocally(
  token: string,
  filename = ".dash0-lambda.token",
): Promise<{ absolutePath: string; configRelativePath: string }> {
  const cfgPath = configPath();
  const cfgDir = dirname(cfgPath);
  const absolutePath = isAbsolute(filename) ? filename : resolve(cfgDir, filename);
  await fs.writeFile(absolutePath, token + "\n", { mode: 0o600 });
  // re-set mode in case the file already existed with broader perms
  await fs.chmod(absolutePath, 0o600);
  await maybeAddToGitignore(absolutePath);
  return {
    absolutePath,
    configRelativePath: relative(cfgDir, absolutePath) || filename,
  };
}

export async function loadLocalToken(
  configRelativePath: string,
): Promise<string | null> {
  const cfgDir = dirname(configPath());
  const path = isAbsolute(configRelativePath)
    ? configRelativePath
    : resolve(cfgDir, configRelativePath);
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: append `.dash0-lambda.token` to `./.gitignore` if it exists
 * and doesn't already include the file. Never fails the caller.
 */
async function maybeAddToGitignore(tokenAbsolutePath: string): Promise<void> {
  const gitignore = resolve(process.cwd(), ".gitignore");
  let existing: string;
  try {
    existing = await fs.readFile(gitignore, "utf8");
  } catch {
    return; // no .gitignore → don't create one unprompted
  }
  const tokenName = relative(process.cwd(), tokenAbsolutePath) || ".dash0-lambda.token";
  if (existing.split(/\r?\n/).some((l) => l.trim() === tokenName)) return;
  const sep = existing.endsWith("\n") ? "" : "\n";
  await fs.appendFile(
    gitignore,
    `${sep}# dash0-lambda-cli local token (do not commit)\n${tokenName}\n`,
  );
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    if (o[k as keyof T] === undefined) delete (o as Record<string, unknown>)[k];
  }
  return o;
}

/** Pretty-print a config for display. Redacts nothing — none of these are secrets. */
export function describeConfig(c: SavedConfig): string {
  if (Object.keys(c).length === 0) return "  (empty)";
  return Object.entries(c)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

// Compatibility hook for tests that may want to point the resolver elsewhere.
export const _internal = { homedir };
