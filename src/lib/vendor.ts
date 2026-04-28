/**
 * Vendor toggle: flip a Lambda function's active observability vendor
 * between Dash0 and Lumigo by changing the AWS_LAMBDA_EXEC_WRAPPER
 * (and a couple of related env vars), without touching the layers.
 *
 * Prerequisites
 *   - Both vendor layers must already be attached. The toggle does NOT
 *     install layers; use `install` (Dash0) or your existing Lumigo
 *     mechanism for that. We refuse to switch toward a vendor whose
 *     layer isn't present, so you can't end up running on a wrapper
 *     whose binary isn't on disk.
 *
 * Wrapper rules
 *   Dash0:    AWS_LAMBDA_EXEC_WRAPPER=/opt/wrapper
 *             (every supported runtime — extension binary handles dispatch)
 *   Lumigo:   - Java:        AWS_LAMBDA_EXEC_WRAPPER=/opt/lumigo_wrapper
 *             - Node/Python: AWS_LAMBDA_EXEC_WRAPPER UNSET — the Lumigo
 *               layer auto-loads via NODE_OPTIONS / PYTHONPATH preload.
 *
 * Side-effects
 *   When switching TO Dash0 with a Lumigo layer also present, we set
 *   LUMIGO_SWITCH_OFF=true so Lumigo's auto-loader doesn't double-trace.
 *   When switching TO Lumigo, we remove LUMIGO_SWITCH_OFF (or set it to
 *   "false") so the auto-loader runs again.
 */

import type { FunctionSnapshot } from "./lambda.js";
import { parseDash0LayerArn } from "./layers.js";
import { detectLumigo, hasLumigoFootprint } from "./lumigo.js";

export type Vendor = "dash0" | "lumigo";
export type ActiveVendor = Vendor | "none" | "ambiguous";

export interface VendorState {
  hasDash0Layer: boolean;
  hasLumigoLayer: boolean;
  /** Inferred current active vendor based on env + runtime. */
  active: ActiveVendor;
  /** What's currently in AWS_LAMBDA_EXEC_WRAPPER. */
  currentWrapper?: string;
  /** Whether LUMIGO_SWITCH_OFF=true is set. */
  lumigoDisabled: boolean;
}

export function inspectVendor(fn: FunctionSnapshot): VendorState {
  const hasDash0Layer = fn.layers.some(
    (l) => parseDash0LayerArn(l.Arn ?? "") !== null,
  );
  const lumigo = detectLumigo(fn);
  const hasLumigoLayer = lumigo.layers.length > 0;
  const lumigoDisabled = fn.env.LUMIGO_SWITCH_OFF === "true";
  const wrapper = fn.env.AWS_LAMBDA_EXEC_WRAPPER;

  let active: ActiveVendor = "none";
  if (wrapper === "/opt/wrapper" && hasDash0Layer) {
    active = "dash0";
  } else if (wrapper && wrapper.includes("lumigo") && hasLumigoLayer) {
    active = "lumigo";
  } else if (
    !wrapper &&
    hasLumigoLayer &&
    !lumigoDisabled &&
    isNodeOrPython(fn.runtime)
  ) {
    // Lumigo's Node/Python tracers don't need a wrapper — the layer
    // auto-loads via runtime preload. So an unset wrapper + Lumigo layer
    // present + LUMIGO_SWITCH_OFF unset means Lumigo is the active vendor.
    active = "lumigo";
  } else if (hasDash0Layer && hasLumigoLayer && !wrapper && lumigoDisabled) {
    // Both attached but neither wired up. Operator probably mid-migration.
    active = "none";
  } else if (hasDash0Layer && hasLumigoLayer) {
    active = "ambiguous";
  } else if (hasDash0Layer) {
    active = "dash0";
  } else if (hasLumigoLayer) {
    active = "lumigo";
  }

  return {
    hasDash0Layer,
    hasLumigoLayer,
    active,
    currentWrapper: wrapper,
    lumigoDisabled,
  };
}

export interface SwitchPlan {
  /** Function-name → ordered (key, before, after) tuples. */
  envChanges: Array<[string, string | undefined, string | undefined]>;
  /** Reason this plan is rejected, if any. */
  blocker?: string;
  /** Soft warnings the operator should glance at. */
  warnings: string[];
  /** The target wrapper value (undefined means "remove"). */
  targetWrapper: string | undefined;
}

/**
 * Compute the env-var changes needed to switch a function to `target`.
 * If the target's layer isn't present, returns a blocker — no changes.
 */
export function buildSwitchPlan(
  fn: FunctionSnapshot,
  target: Vendor,
): SwitchPlan {
  const state = inspectVendor(fn);
  const warnings: string[] = [];

  if (target === "dash0" && !state.hasDash0Layer) {
    return {
      envChanges: [],
      blocker:
        "Function has no Dash0 layer attached — run `install` first, then come back to switch.",
      warnings,
      targetWrapper: undefined,
    };
  }
  if (target === "lumigo" && !state.hasLumigoLayer) {
    return {
      envChanges: [],
      blocker:
        "Function has no Lumigo layer attached — re-attach it before switching back.",
      warnings,
      targetWrapper: undefined,
    };
  }

  const env = fn.env;
  const changes: Array<[string, string | undefined, string | undefined]> = [];

  if (target === "dash0") {
    setIfDifferent(changes, env, "AWS_LAMBDA_EXEC_WRAPPER", "/opt/wrapper");
    if (state.hasLumigoLayer) {
      // Stop Lumigo's auto-loader from double-instrumenting alongside Dash0.
      setIfDifferent(changes, env, "LUMIGO_SWITCH_OFF", "true");
    }
    return {
      envChanges: changes,
      warnings,
      targetWrapper: "/opt/wrapper",
    };
  }

  // target === "lumigo"
  const lumigoWrapper = lumigoWrapperFor(fn.runtime);
  setIfDifferent(changes, env, "AWS_LAMBDA_EXEC_WRAPPER", lumigoWrapper);

  // Re-enable Lumigo's auto-loader (Node/Python) and remove the kill-switch.
  if (env.LUMIGO_SWITCH_OFF !== undefined && env.LUMIGO_SWITCH_OFF !== "false") {
    changes.push(["LUMIGO_SWITCH_OFF", env.LUMIGO_SWITCH_OFF, undefined]);
  }

  if (lumigoWrapper === undefined && !hasLumigoFootprint(detectLumigo(fn))) {
    warnings.push(
      "Removing AWS_LAMBDA_EXEC_WRAPPER, but no LUMIGO_TRACER_TOKEN is set on this function — " +
        "the Lumigo tracer will load but won't have a token to ship to.",
    );
  }
  if (lumigoWrapper === "/opt/lumigo_wrapper" && !env.LUMIGO_TRACER_TOKEN) {
    warnings.push(
      "Switching to /opt/lumigo_wrapper but LUMIGO_TRACER_TOKEN is unset — " +
        "the tracer will fail-open and emit warnings until you set it.",
    );
  }

  return {
    envChanges: changes,
    warnings,
    targetWrapper: lumigoWrapper,
  };
}

/**
 * Apply a plan to an env map → return the new env map (immutable).
 */
export function applyPlan(
  env: Record<string, string>,
  plan: SwitchPlan,
): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const [key, , after] of plan.envChanges) {
    if (after === undefined) delete out[key];
    else out[key] = after;
  }
  return out;
}

function setIfDifferent(
  changes: Array<[string, string | undefined, string | undefined]>,
  env: Record<string, string>,
  key: string,
  desired: string | undefined,
): void {
  const before = env[key];
  if (before === desired) return;
  changes.push([key, before, desired]);
}

function lumigoWrapperFor(runtime: string): string | undefined {
  if (runtime.startsWith("java")) return "/opt/lumigo_wrapper";
  // Node, Python, Ruby, custom: Lumigo's layer auto-loads via the runtime's
  // preload mechanism, no AWS_LAMBDA_EXEC_WRAPPER needed.
  return undefined;
}

function isNodeOrPython(runtime: string): boolean {
  return runtime.startsWith("nodejs") || runtime.startsWith("python");
}
