/**
 * `dash0-lambda install` — attach the Dash0 extension layer and set the
 * required env vars on a target function.
 *
 * The command is idempotent: running it twice is a no-op when nothing
 * changes. With --dry-run it prints the plan and exits.
 */

import { LambdaWrapper } from "../lib/lambda.js";
import {
  buildLayerArn,
  CANONICAL_OWNER_ACCOUNT,
  familyForRuntime,
  KNOWN_LATEST_LAYER_VERSION,
  parseDash0LayerArn,
  type RuntimeFamily,
  wrapperPathFor,
} from "../lib/layers.js";
import {
  configToEnv,
  diffEnv,
  Dash0InstallConfigSchema,
  mergeEnv,
  type Dash0InstallConfig,
} from "../lib/env.js";
import { CliError, ValidationError, asCliError } from "../lib/errors.js";
import { c, fail, info, ok, warn } from "../lib/output.js";

export interface InstallOptions {
  function: string;
  region: string;

  // Auth + endpoint
  endpoint: string;
  token?: string;
  tokenSecretArn?: string;
  tokenSecretKey?: string;
  /** When set, enforce exclusivity and clear the other auth env var. */
  authMode?: "token" | "secret";

  // Common knobs
  dataset?: string;
  serviceName?: string;
  extensionLogLevel?: "trace" | "debug" | "info" | "warn" | "error";
  distroDebug?: boolean;
  disableAutoInstrumentation?: boolean;
  sendOnInvocationEnd?: boolean;
  xrayTracesEnabled?: boolean;
  requestTimeoutMs?: number;
  createPayloadLogRecords?: boolean;
  disableTelemetryLogCollection?: boolean;

  // Masking
  maskRules?: string[];
  maskEnvVars?: string[];
  maskRequestBody?: string[];
  maskRequestHeaders?: string[];
  maskResponseBody?: string[];
  maskResponseHeaders?: string[];
  maskQueryParams?: string[];

  // Free-form
  resourceAttributes?: Record<string, string>;
  extraEnv?: Record<string, string>;

  // Layer overrides
  family?: RuntimeFamily;
  layerVersion?: number;
  layerOwner?: string;

  dryRun?: boolean;
  /** Inject Lambda wrapper for tests. */
  lambda?: LambdaWrapper;
}

export interface InstallResult {
  applied: boolean;
  reason?: string;
  layerArn: string;
  envBefore: Record<string, string>;
  envAfter: Record<string, string>;
  family: RuntimeFamily;
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const cfg = parseConfig(opts);
  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });

  // 1. Inspect the function.
  const fn = await lambda.getFunction(opts.function).catch((err) => {
    throw asCliError(err, `failed to fetch function ${opts.function}`);
  });

  // 2. Resolve the runtime family + wrapper path.
  const family = opts.family ?? familyForRuntime(fn.runtime);
  const wrapperPath = wrapperPathFor(family);

  // 3. Resolve the layer ARN. Default to the version baked into this CLI
  //    (which tracks the current Dash0 release) rather than calling
  //    ListLayerVersions — that requires a cross-account permission the
  //    canonical Dash0 layer doesn't grant. Override with --layer-version.
  const ownerAccount = opts.layerOwner ?? CANONICAL_OWNER_ACCOUNT;
  const version = opts.layerVersion ?? KNOWN_LATEST_LAYER_VERSION[family];
  const layerArn = buildLayerArn({
    region: opts.region,
    ownerAccount,
    family,
    version,
  });

  // 4. Compute the desired layer + env state.
  const otherLayers = fn.layers
    .map((l) => l.Arn ?? "")
    .filter((arn) => arn && parseDash0LayerArn(arn) === null);
  const desiredLayers = [layerArn, ...otherLayers];

  const dash0Env = configToEnv(cfg);
  if (wrapperPath) dash0Env.AWS_LAMBDA_EXEC_WRAPPER = wrapperPath;
  const desiredEnv = mergeEnv(fn.env, dash0Env);

  // Auth-mode exclusivity: when an explicit mode is pinned, scrub the
  // env var for the *other* shape so the two can never coexist on the
  // function. (Per the extension docs DASH0_TOKEN wins silently if both
  // are set — this prevents that footgun.)
  if (cfg.authMode === "token") {
    delete desiredEnv.DASH0_TOKEN_SECRET_ARN;
    delete desiredEnv.DASH0_TOKEN_SECRET_KEY;
  } else if (cfg.authMode === "secret") {
    delete desiredEnv.DASH0_TOKEN;
  }

  // 5. Print plan.
  printPlan({
    function: opts.function,
    runtime: fn.runtime,
    family,
    layerArn,
    currentLayers: fn.layers.map((l) => l.Arn ?? ""),
    envBefore: fn.env,
    envAfter: desiredEnv,
  });

  // 6. Apply (unless dry-run).
  const result = await lambda
    .updateFunctionConfig({
      name: opts.function,
      layerArns: desiredLayers,
      env: desiredEnv,
    })
    .catch((err) => {
      throw asCliError(err, `failed to update function ${opts.function}`);
    });

  if (result.applied) {
    ok(`Dash0 extension installed on ${c.bold(opts.function)}`);
    info(
      `Test the function. Telemetry should appear in Dash0 within seconds.`,
    );
  } else {
    warn(`Dry-run: nothing changed. Re-run without --dry-run to apply.`);
  }

  return {
    applied: result.applied,
    reason: result.reason,
    layerArn,
    envBefore: fn.env,
    envAfter: desiredEnv,
    family,
  };
}

function parseConfig(opts: InstallOptions): Dash0InstallConfig {
  const parsed = Dash0InstallConfigSchema.safeParse({
    endpoint: opts.endpoint,
    token: opts.token,
    tokenSecretArn: opts.tokenSecretArn,
    tokenSecretKey: opts.tokenSecretKey,
    authMode: opts.authMode,
    dataset: opts.dataset,
    serviceName: opts.serviceName,
    extensionLogLevel: opts.extensionLogLevel,
    distroDebug: opts.distroDebug,
    disableAutoInstrumentation: opts.disableAutoInstrumentation,
    sendOnInvocationEnd: opts.sendOnInvocationEnd,
    xrayTracesEnabled: opts.xrayTracesEnabled,
    requestTimeoutMs: opts.requestTimeoutMs,
    createPayloadLogRecords: opts.createPayloadLogRecords,
    disableTelemetryLogCollection: opts.disableTelemetryLogCollection,
    maskRules: opts.maskRules,
    maskEnvVars: opts.maskEnvVars,
    maskRequestBody: opts.maskRequestBody,
    maskRequestHeaders: opts.maskRequestHeaders,
    maskResponseBody: opts.maskResponseBody,
    maskResponseHeaders: opts.maskResponseHeaders,
    maskQueryParams: opts.maskQueryParams,
    resourceAttributes: opts.resourceAttributes,
    extraEnv: opts.extraEnv,
  });
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `${e.path.join(".") || "config"}: ${e.message}`)
      .join("; ");
    throw new ValidationError(msg);
  }
  return parsed.data;
}

function printPlan(p: {
  function: string;
  runtime: string;
  family: RuntimeFamily;
  layerArn: string;
  currentLayers: string[];
  envBefore: Record<string, string>;
  envAfter: Record<string, string>;
}): void {
  console.log("");
  console.log(c.bold(`Plan for ${p.function}`));
  console.log(`  runtime:        ${p.runtime}`);
  console.log(`  detected family: ${p.family}`);
  console.log(`  layer to attach: ${p.layerArn}`);
  if (p.currentLayers.length > 0) {
    console.log(`  existing layers:`);
    for (const l of p.currentLayers) console.log(`    - ${l}`);
  }
  const d = diffEnv(p.envBefore, p.envAfter);
  console.log(
    `  env diff: +${d.added.length} added, ~${d.changed.length} changed, =${d.unchanged} unchanged`,
  );
  for (const [k, v] of d.added) {
    console.log(`    ${c.green("+")} ${k}=${redact(k, v)}`);
  }
  for (const [k, before, after] of d.changed) {
    console.log(
      `    ${c.yellow("~")} ${k}: ${redact(k, before)} → ${redact(k, after)}`,
    );
  }
  console.log("");
}

function redact(key: string, value: string): string {
  if (key === "DASH0_TOKEN" || key === "LUMIGO_TRACER_TOKEN") {
    if (value.length <= 12) return "***";
    return `${value.slice(0, 8)}…${value.slice(-4)}`;
  }
  return value;
}

/** Friendly error filter for the CLI entrypoint. */
export function ensureCliError(err: unknown): never {
  if (err instanceof CliError) {
    fail(err.message);
    process.exit(err.exitCode);
  }
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
