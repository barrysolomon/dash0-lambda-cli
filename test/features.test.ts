/**
 * Tests for the feature flags.
 *
 * `features.ts` holds compile-time boolean constants, so there is no logic to
 * exercise. What IS worth locking down is the module's stated contract, which
 * has bitten people before:
 *
 *   "CLI flags backing a disabled feature stay silently functional so
 *    scripted users don't break — but we drop them from the install wizard's
 *    chooser UI."
 *
 * SECRETS_DISABLED is read only by TUI screens (Install, Config, EnvManage).
 * Nothing on the CLI path may branch on it, or flipping the flag would break
 * every pipeline using `--token-secret-arn`. That invariant is what the
 * second test enforces — it's a tripwire, deliberately, the same way
 * layers.test.ts pins the layer version.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SECRETS_DISABLED } from "../src/lib/features.js";

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : /\.tsx?$/.test(entry)
        ? [full]
        : [];
  });
}

describe("SECRETS_DISABLED", () => {
  it("is currently OFF — Secrets Manager is an offered option", () => {
    // Tripwire. If you flip the constant, flip this too, on purpose.
    expect(SECRETS_DISABLED).toBe(false);
  });

  it("is read only by the TUI, never by a CLI command or lib", () => {
    // The flag hides *new-configuration affordances* in the wizard. A command
    // or lib that branched on it would silently disable --token-secret-arn
    // for scripted users the day someone flips the constant.
    const readers = walk(SRC)
      .filter((f) => /\bSECRETS_DISABLED\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f))
      .filter((f) => f !== path.join("lib", "features.ts"))
      .map((f) => f.split(path.sep)[0]);

    expect([...new Set(readers)]).toEqual(["tui"]);
  });
});
