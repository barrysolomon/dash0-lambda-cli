/**
 * Shared types for bulk-action screens (install / uninstall / update-layer).
 *
 * The single rule: one target's failure must not abort the rest of the
 * loop. Each target gets its own try/catch and contributes one row to
 * `BulkResult[]`, then the summary view renders counts + per-target
 * outcomes so the user sees exactly what landed and what didn't.
 */

export type BulkOutcome = "pending" | "running" | "ok" | "failed";

export interface BulkResult {
  name: string;
  outcome: BulkOutcome;
  /** Truncated, human-readable error message when outcome === "failed". */
  error?: string;
}

export interface BulkCounts {
  done: number;
  ok: number;
  failed: number;
  pending: number;
  running: number;
}

export function countOutcomes(rows: ReadonlyArray<BulkResult>): BulkCounts {
  const c: BulkCounts = { done: 0, ok: 0, failed: 0, pending: 0, running: 0 };
  for (const r of rows) {
    if (r.outcome === "ok") {
      c.ok++;
      c.done++;
    } else if (r.outcome === "failed") {
      c.failed++;
      c.done++;
    } else if (r.outcome === "running") {
      c.running++;
    } else {
      c.pending++;
    }
  }
  return c;
}

/**
 * Best-effort runner: invokes `op` per name, collecting outcomes.
 * `onUpdate` fires after every row transition (pending→running→ok/failed)
 * so the UI can render live progress.
 *
 * Errors from `op` are caught and recorded; the loop never aborts. The
 * resolved promise carries the final `BulkResult[]`.
 */
export async function runBulk(
  names: ReadonlyArray<string>,
  op: (name: string) => Promise<void>,
  onUpdate: (rows: BulkResult[]) => void,
): Promise<BulkResult[]> {
  const rows: BulkResult[] = names.map((n) => ({ name: n, outcome: "pending" }));
  onUpdate([...rows]);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = { ...rows[i]!, outcome: "running" };
    onUpdate([...rows]);
    try {
      await op(rows[i]!.name);
      rows[i] = { ...rows[i]!, outcome: "ok" };
    } catch (err) {
      rows[i] = {
        ...rows[i]!,
        outcome: "failed",
        error: shortenError(err),
      };
    }
    onUpdate([...rows]);
  }
  return rows;
}

function shortenError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // AWS SDK errors come with prefix-y "ValidationException: ..." text;
  // keep the whole thing but cap length so the summary stays readable.
  return msg.length > 200 ? msg.slice(0, 199) + "…" : msg;
}
