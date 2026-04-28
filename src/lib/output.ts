/**
 * Terminal output helpers — colors, tables, JSON pretty-print.
 * Kept tiny so the CLI doesn't pull in a heavy table lib.
 */

import kleur from "kleur";

export const c = kleur;

export type OutputFormat = "table" | "json" | "yaml";

export function ok(msg: string): void {
  console.log(`${kleur.green("✔")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${kleur.cyan("ℹ")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${kleur.yellow("!")} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${kleur.red("✘")} ${msg}`);
}

export function header(msg: string): void {
  console.log("\n" + kleur.bold().underline(msg));
}

/**
 * Render an array of records as a left-aligned table.
 * Cells are stringified; nullish cells become empty strings.
 */
export function renderTable(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  if (rows.length === 0) return kleur.dim("(no rows)");
  const cols = columns ?? Object.keys(rows[0]!);
  const widths = cols.map((col) =>
    Math.max(
      col.length,
      ...rows.map((r) => String(r[col] ?? "").length),
    ),
  );
  const head = cols.map((col, i) => kleur.bold(col.padEnd(widths[i]!))).join("  ");
  const sep = cols.map((_, i) => "─".repeat(widths[i]!)).join("  ");
  const body = rows
    .map((r) =>
      cols
        .map((col, i) => String(r[col] ?? "").padEnd(widths[i]!))
        .join("  "),
    )
    .join("\n");
  return [head, sep, body].join("\n");
}

export function emit(
  format: OutputFormat,
  data: unknown,
  tableRows?: Array<Record<string, unknown>>,
  tableColumns?: string[],
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (format === "yaml") {
    // Lazy require so we don't pay the parse cost when not needed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const YAML = require("yaml");
    console.log(YAML.stringify(data));
    return;
  }
  if (tableRows) {
    console.log(renderTable(tableRows, tableColumns));
  } else {
    console.log(data);
  }
}
