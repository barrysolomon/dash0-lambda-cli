/**
 * ESM integrity — does the COMPILED output actually run under Node's ESM
 * loader?
 *
 * Why this file exists, and why it spawns real processes instead of just
 * importing things:
 *
 * This package is `"type": "module"`. Node's ESM module scope has no
 * `require`, no `__dirname`, no `module.exports`. But Vitest's module runner
 * transforms modules and injects a CommonJS interop shim, so a stray
 * `require("yaml")` sitting in a source file resolves happily inside the test
 * suite and throws `ReferenceError: require is not defined` the moment a real
 * user runs the real binary. Every in-process test is blind to it — the
 * suite goes green while the shipped CLI is broken.
 *
 * A `--help` smoke check doesn't catch it either: the crash only happens on
 * the code path that touches the CJS-ism.
 *
 * So: build, then run the built artifact in a genuine `node` ESM process and
 * assert it works. This is the only test in the repo that can see this class
 * of bug.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");

/** Run a snippet in a real Node ESM process. Returns stdout; throws on non-zero exit. */
function runEsm(code: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function distUrl(rel: string): string {
  return new URL(`file://${path.join(DIST, rel)}`).href;
}

beforeAll(() => {
  // The suite asserts things about the compiled artifact, so compile it.
  execFileSync("npm", ["run", "build"], {
    cwd: REPO,
    stdio: "ignore",
    timeout: 300_000,
  });
  expect(existsSync(DIST)).toBe(true);
}, 300_000);

describe("compiled output runs under Node's ESM loader", () => {
  it("emit('yaml') does not blow up on a missing `require`", async () => {
    const out = runEsm(`
      const { emit } = await import(${JSON.stringify(distUrl("lib/output.js"))});
      emit("yaml", { name: "orders-create", dash0: "v20/node" });
    `);

    expect(out).toMatch(/name:\s*orders-create/);
    expect(out).toMatch(/dash0:\s*v20\/node/);
  });

  it("emit('json') round-trips", async () => {
    const out = runEsm(`
      const { emit } = await import(${JSON.stringify(distUrl("lib/output.js"))});
      emit("json", [{ name: "orders-create" }]);
    `);

    expect(JSON.parse(out)).toEqual([{ name: "orders-create" }]);
  });

  it("every compiled module imports cleanly in a real ESM process", async () => {
    // Catches top-level CJS-isms (`require`, `__dirname`, `module.exports`)
    // anywhere in the tree, not just the ones we thought to probe. TSX/React
    // screens are excluded: importing them pulls in a terminal renderer.
    const files: string[] = [];
    async function walk(dir: string, rel = "") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const r = path.join(rel, entry.name);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), r);
        else if (entry.name.endsWith(".js")) files.push(r);
      }
    }
    await walk(DIST);

    const modules = files
      .filter((f) => !f.startsWith("tui" + path.sep))
      .filter((f) => !f.startsWith("menu" + path.sep))
      .filter((f) => f !== "cli.js"); // cli.js parses argv on import

    expect(modules.length).toBeGreaterThan(5);

    const imports = modules
      .map((m) => `await import(${JSON.stringify(distUrl(m))});`)
      .join("\n");
    expect(() => runEsm(imports + '\nconsole.log("ok");')).not.toThrow();
  });
});

describe("the built CLI is runnable", () => {
  it("prints its subcommands", () => {
    const out = execFileSync(process.execPath, [path.join(DIST, "cli.js"), "--help"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    });

    for (const cmd of [
      "install",
      "uninstall",
      "remove-lumigo",
      "validate",
      "secret",
      "list",
      "migrate",
      "update",
      "switch",
      "generate",
    ]) {
      expect(out).toContain(cmd);
    }
  });
});
