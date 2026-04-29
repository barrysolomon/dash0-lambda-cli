/**
 * Resolve the list of function names a downstream screen should act on.
 *
 * Rule:
 *   - If the user has any items selected (state.selected.size >= 1), we use
 *     those — even if it's only one. The selection is the explicit signal
 *     of intent.
 *   - Otherwise fall back to the highlighted/focused function if any.
 *   - Otherwise empty (the screen should refuse to proceed).
 */

import type { AppState } from "../types.js";

export interface ResolvedTargets {
  names: string[];
  bulk: boolean;
}

export function resolveTargets(state: AppState): ResolvedTargets {
  if (state.selected.size > 0) {
    return { names: [...state.selected].sort(), bulk: state.selected.size > 1 };
  }
  if (state.focused) {
    return { names: [state.focused.functionName], bulk: false };
  }
  return { names: [], bulk: false };
}

export function summarizeTargets(names: string[], max = 6): string {
  if (names.length === 0) return "(none)";
  if (names.length <= max) return names.join(", ");
  const rest = names.length - max;
  return names.slice(0, max).join(", ") + ` …and ${rest} more`;
}

/**
 * Filter `names` to only zip-package functions, returning both the kept
 * set and the skipped set so the caller can surface a status message.
 *
 * Used by layer-mutating action shortcuts (install / update-layer /
 * uninstall / migrate / switch-vendor) — image-package functions can't
 * have layers attached, so AWS would reject the UpdateFunctionConfiguration
 * call. Better to filter up-front with a clear notice than to fail mid-loop.
 *
 * If `pool` doesn't include a name (e.g. the function list hasn't loaded
 * yet, or the name was typed in a wizard), we conservatively keep it — the
 * downstream command will catch a true mismatch.
 */
export function filterToZip(
  names: string[],
  pool: ReadonlyArray<{ functionName: string; packageType: "Zip" | "Image" }>,
): { kept: string[]; skipped: string[] } {
  const byName = new Map(pool.map((f) => [f.functionName, f.packageType] as const));
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const n of names) {
    const pt = byName.get(n);
    if (pt === "Image") skipped.push(n);
    else kept.push(n);
  }
  return { kept, skipped };
}
