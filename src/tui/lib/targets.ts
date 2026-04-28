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
