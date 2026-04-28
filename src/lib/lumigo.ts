/**
 * Lumigo → Dash0 detection and migration mapping.
 *
 * Lumigo's auto-trace layers live in account 114300393969 and follow the
 * naming pattern `lumigo-<lang>-tracer` (lumigo-node-tracer,
 * lumigo-python-tracer, lumigo-java-tracer-no-tracer-no-w3c, etc.).
 *
 * We don't aim for 100% feature parity — we map the *configuration* the
 * customer set on Lumigo to the closest Dash0 equivalent and preserve
 * everything else. Anything we can't map cleanly is reported back so the
 * operator can decide.
 */

import type { FunctionSnapshot } from "./lambda.js";
import type { Layer } from "@aws-sdk/client-lambda";

const LUMIGO_PUBLISHER_ACCOUNT = "114300393969";
const LUMIGO_LAYER_RE =
  /^arn:aws:lambda:[a-z0-9-]+:114300393969:layer:lumigo-[a-z0-9-]+:\d+$/;

const LUMIGO_ENV_KEYS = [
  "LUMIGO_TRACER_TOKEN",
  "LUMIGO_DEBUG",
  "LUMIGO_ENABLE_LOGS",
  "LUMIGO_AUTO_TAG",
  "LUMIGO_PROPAGATE_W3C",
  "LUMIGO_DOMAINS_SCRUBBER",
  "LUMIGO_SECRET_MASKING_REGEX",
  "LUMIGO_BLACKLIST_REGEX",
  "LUMIGO_REPORT_DEPENDENCIES",
  "LUMIGO_STEP_FUNCTION",
  "LUMIGO_USE_TRACER_EXTENSION",
  "LUMIGO_SWITCH_OFF",
  "LUMIGO_AUTO_INIT",
] as const;

export interface LumigoFootprint {
  /** Lumigo layer ARNs currently attached to the function. */
  layers: string[];
  /** Lumigo-prefixed env vars currently set. */
  env: Record<string, string>;
  /**
   * Lumigo also relies on AWS_LAMBDA_EXEC_WRAPPER (e.g. /opt/lumigo_wrapper
   * for Java). We surface the current wrapper so install can replace it.
   */
  wrapper?: string;
}

export interface MigrationPlan {
  /** Existing Lumigo footprint, for reporting. */
  lumigo: LumigoFootprint;
  /** Other (non-Lumigo, non-Dash0) layers to keep on the function. */
  layersToKeep: Layer[];
  /** Env vars to keep (everything that isn't LUMIGO_* or DASH0_*). */
  envToKeep: Record<string, string>;
  /**
   * Settings we couldn't map automatically. Operator should review.
   * E.g. LUMIGO_DOMAINS_SCRUBBER has no exact OTel-collector equivalent.
   */
  warnings: string[];
}

export function detectLumigo(snapshot: FunctionSnapshot): LumigoFootprint {
  const layers = snapshot.layers
    .map((l) => l.Arn ?? "")
    .filter((a) => LUMIGO_LAYER_RE.test(a));

  const env: Record<string, string> = {};
  for (const k of LUMIGO_ENV_KEYS) {
    const v = snapshot.env[k];
    if (v !== undefined) env[k] = v;
  }

  const wrapper = snapshot.env.AWS_LAMBDA_EXEC_WRAPPER;
  return {
    layers,
    env,
    wrapper: wrapper?.includes("lumigo") ? wrapper : undefined,
  };
}

export function hasLumigoFootprint(fp: LumigoFootprint): boolean {
  return fp.layers.length > 0 || Object.keys(fp.env).length > 0;
}

const DASH0_ENV_KEYS_PREFIX = "DASH0_";

export function buildMigrationPlan(
  snapshot: FunctionSnapshot,
): MigrationPlan {
  const lumigo = detectLumigo(snapshot);
  const lumigoLayerSet = new Set(lumigo.layers);

  const layersToKeep = snapshot.layers.filter((l) => {
    const arn = l.Arn ?? "";
    if (lumigoLayerSet.has(arn)) return false;
    // Strip any existing dash0-extension layer too — install will re-add.
    if (arn.includes(":layer:dash0-extension-")) return false;
    return true;
  });

  const envToKeep: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot.env)) {
    if (k.startsWith(DASH0_ENV_KEYS_PREFIX)) continue;
    if (k === "AWS_LAMBDA_EXEC_WRAPPER") continue; // install owns this
    if (k === "OTEL_RESOURCE_ATTRIBUTES") continue; // install owns this
    if ((LUMIGO_ENV_KEYS as readonly string[]).includes(k)) continue;
    envToKeep[k] = v;
  }

  const warnings: string[] = [];
  if (lumigo.env.LUMIGO_DOMAINS_SCRUBBER || lumigo.env.LUMIGO_SECRET_MASKING_REGEX) {
    warnings.push(
      "Lumigo had domain/secret scrubbing rules set. Dash0 handles redaction " +
        "via the OTel collector config (otel-collector-config.yaml) — port " +
        "any LUMIGO_*_REGEX rules into the collector's transform processor.",
    );
  }
  if (lumigo.env.LUMIGO_STEP_FUNCTION) {
    warnings.push(
      "LUMIGO_STEP_FUNCTION was set. Dash0 traces Step Functions via X-Ray " +
        "Transaction Search; no per-function flag is required.",
    );
  }
  if (lumigo.env.LUMIGO_BLACKLIST_REGEX) {
    warnings.push(
      "LUMIGO_BLACKLIST_REGEX was set. Configure equivalent filtering in " +
        "the OTel collector via the filter processor.",
    );
  }
  if (lumigo.env.LUMIGO_SWITCH_OFF === "true") {
    warnings.push(
      "Lumigo was disabled (LUMIGO_SWITCH_OFF=true) on this function — " +
        "the migration will fully enable Dash0. Confirm this is intentional.",
    );
  }
  return { lumigo, layersToKeep, envToKeep, warnings };
}

export { LUMIGO_PUBLISHER_ACCOUNT, LUMIGO_LAYER_RE, LUMIGO_ENV_KEYS };
