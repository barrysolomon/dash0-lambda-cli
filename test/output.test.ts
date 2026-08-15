/**
 * Tests for the terminal-output helpers.
 *
 * Formatting bugs are cosmetic right up until they aren't:
 *   - `renderTable` computes column widths from the data. A width taken from
 *     the header only, or from the first row only, produces a table that
 *     looks fine in the test fixture and shears apart on real function names.
 *   - `fail()` must write to STDERR. Everything else writes to stdout. A
 *     command emitting `--format json` sends its payload to stdout; a
 *     diagnostic on the same stream corrupts `| jq`.
 *   - `emit("yaml")` is exercised here for behavior, but note that its real
 *     regression guard lives in esm-integrity.test.ts — this suite runs under
 *     Vitest's CommonJS interop shim and cannot see an ESM violation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emit,
  fail,
  header,
  info,
  ok,
  renderTable,
  warn,
} from "../src/lib/output.js";

// kleur is disabled on a non-TTY, but strip anyway so the suite can't start
// failing because someone ran it through a pty.
const strip = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\[[0-9;]*m/g, "");

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void stdout.push(a.map(String).join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void stderr.push(a.map(String).join(" ")),
  );
});
afterEach(() => vi.restoreAllMocks());

const outText = () => strip(stdout.join("\n"));
const errText = () => strip(stderr.join("\n"));

describe("status helpers", () => {
  it.each([
    ["ok", ok, "✔"],
    ["info", info, "ℹ"],
    ["warn", warn, "!"],
  ])("%s prefixes the message and writes to stdout", (_n, fn, symbol) => {
    fn("something happened");

    expect(outText()).toBe(`${symbol} something happened`);
    expect(stderr).toEqual([]);
  });

  it("fail writes to stderr so it can't corrupt piped stdout", () => {
    fail("everything is broken");

    expect(errText()).toBe("✘ everything is broken");
    expect(stdout).toEqual([]);
  });

  it("header emits a blank line before the title", () => {
    header("Uninstall plan");

    expect(outText()).toBe("\nUninstall plan");
  });
});

describe("renderTable", () => {
  it("says so explicitly when there are no rows", () => {
    expect(strip(renderTable([]))).toBe("(no rows)");
  });

  it("renders a header, a rule, and one line per row", () => {
    const table = strip(
      renderTable([
        { name: "a", runtime: "nodejs20.x" },
        { name: "b", runtime: "python3.12" },
      ]),
    );

    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^name\s+runtime\s*$/);
    expect(lines[1]).toMatch(/^─+\s+─+$/);
    expect(lines[2]).toMatch(/^a\s+nodejs20\.x\s*$/);
  });

  it("sizes a column to its widest CELL, not just its header", () => {
    const lines = strip(
      renderTable([{ name: "x" }, { name: "a-very-long-function-name" }]),
    ).split("\n");

    // Header, rule and every body row share one width, or the table shears.
    const width = "a-very-long-function-name".length;
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.length)).toEqual([width, width, width, width]);
  });

  it("sizes a column to its HEADER when that is wider than every cell", () => {
    const lines = strip(renderTable([{ description: "x" }])).split("\n");

    expect(lines[1]).toBe("─".repeat("description".length));
  });

  it("takes width from the widest row, not the first one", () => {
    // A first-row-only width calculation passes any fixture whose longest
    // value happens to be first. Put the long value last.
    const lines = strip(renderTable([{ n: "a" }, { n: "bbbbbbbb" }])).split("\n");

    expect(lines[1]).toBe("─".repeat(8));
  });

  it("honors an explicit column list and its ordering", () => {
    const lines = strip(
      renderTable([{ a: 1, b: 2, c: 3 }], ["c", "a"]),
    ).split("\n");

    expect(lines[0]!.trim()).toBe("c  a");
    expect(lines[2]!.trim()).toBe("3  1");
  });

  it("renders a requested column that no row has as blanks", () => {
    const lines = strip(renderTable([{ a: 1 }], ["a", "missing"])).split("\n");

    expect(lines[0]).toMatch(/^a\s+missing\s*$/);
    expect(lines[2]!.trimEnd()).toBe("1");
  });

  it("renders null and undefined cells as empty, not as the words", () => {
    const table = strip(
      renderTable([{ a: null, b: undefined, c: 0, d: false }]),
    );

    expect(table).not.toMatch(/null|undefined/);
    // ...but falsy values that ARE values still print.
    expect(table).toMatch(/0/);
    expect(table).toMatch(/false/);
  });

  it("derives columns from the first row when none are given", () => {
    const lines = strip(renderTable([{ z: 1, a: 2 }])).split("\n");

    expect(lines[0]!.trim()).toBe("z  a");
  });
});

describe("emit", () => {
  it("json pretty-prints with two-space indentation", () => {
    emit("json", { a: 1, b: [2] });

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(JSON.parse(stdout[0]!)).toEqual({ a: 1, b: [2] });
  });

  it("json ignores the table arguments", () => {
    emit("json", { a: 1 }, [{ b: 2 }], ["b"]);

    expect(JSON.parse(stdout[0]!)).toEqual({ a: 1 });
  });

  it("yaml serializes the data argument", () => {
    emit("yaml", { name: "orders-create", layers: ["a"] });

    expect(outText()).toMatch(/name:\s*orders-create/);
    expect(outText()).toMatch(/-\s*a/);
  });

  it("table renders the supplied rows, not the data argument", () => {
    emit("table", { ignored: true }, [{ name: "a" }], ["name"]);

    expect(outText()).toMatch(/^name\s*$/m);
    expect(outText()).not.toMatch(/ignored/);
  });

  it("table falls back to printing data when no rows are supplied", () => {
    emit("table", "plain string");

    expect(outText()).toBe("plain string");
  });
});
