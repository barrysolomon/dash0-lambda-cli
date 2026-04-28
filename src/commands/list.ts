/**
 * `dash0-lambda list` (alias: `status`) — enumerate Lambda functions in a
 * region and report their Dash0 / Lumigo footprint at a glance.
 *
 * Output formats:
 *   --format table (default): one row per function, fits in 120 cols
 *   --format json: full snapshot, useful for scripting
 *   --format yaml: same as JSON, easier eyes-on
 */

import { LambdaWrapper } from "../lib/lambda.js";
import { parseDash0LayerArn } from "../lib/layers.js";
import { detectLumigo } from "../lib/lumigo.js";
import { c, emit, type OutputFormat } from "../lib/output.js";

export interface ListOptions {
  region: string;
  format?: OutputFormat;
  /** Optional substring filter on function name. */
  filter?: string;
  /** Show only functions that already have Dash0 attached. */
  onlyDash0?: boolean;
  /** Show only functions running Lumigo. */
  onlyLumigo?: boolean;
  lambda?: LambdaWrapper;
}

export interface ListRow {
  name: string;
  runtime: string;
  arch: string;
  dash0: string; // version or "—"
  lumigo: string; // "yes" or "—"
  endpoint: string;
  dataset: string;
}

export async function list(opts: ListOptions): Promise<ListRow[]> {
  const lambda =
    opts.lambda ?? new LambdaWrapper({ region: opts.region, dryRun: true });
  const filter = opts.filter?.toLowerCase();
  const rows: ListRow[] = [];
  for await (const fn of lambda.listFunctions()) {
    if (filter && !fn.functionName.toLowerCase().includes(filter)) continue;

    const dash0Layer = fn.layers
      .map((l) => parseDash0LayerArn(l.Arn ?? ""))
      .find((x) => x !== null);
    const lumigo = detectLumigo(fn);
    const dash0Tag = dash0Layer
      ? `v${dash0Layer.version}/${dash0Layer.family}`
      : "—";

    if (opts.onlyDash0 && !dash0Layer) continue;
    if (opts.onlyLumigo && lumigo.layers.length === 0 && Object.keys(lumigo.env).length === 0)
      continue;

    rows.push({
      name: fn.functionName,
      runtime: fn.runtime,
      arch: fn.architectures.join(",") || "x86_64",
      dash0: dash0Tag,
      lumigo:
        lumigo.layers.length + Object.keys(lumigo.env).length > 0 ? "yes" : "—",
      endpoint: shorten(fn.env.DASH0_ENDPOINT ?? "—", 32),
      dataset: fn.env.DASH0_DATASET ?? "—",
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  // Console output.
  const fmt = opts.format ?? "table";
  if (fmt === "table") {
    console.log(c.bold(`\nLambda functions in ${opts.region}: ${rows.length} match`));
    emit("table", undefined, rows as unknown as Array<Record<string, unknown>>, [
      "name",
      "runtime",
      "arch",
      "dash0",
      "lumigo",
      "endpoint",
      "dataset",
    ]);
  } else {
    emit(fmt, rows);
  }
  return rows;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
