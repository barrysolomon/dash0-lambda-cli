/**
 * Environment-variable schema applied to a Lambda function when the Dash0
 * extension is installed.
 *
 * Source of truth: the dash0-lambda-extension README. Every key listed
 * below is a real env var the extension reads.
 */

import { z } from "zod";

/**
 * All env var names the extension recognizes. Anything in this list is
 * considered "Dash0-owned": uninstall removes them, validate inspects them.
 */
export const DASH0_ENV_KEYS = [
  // Required wiring
  "AWS_LAMBDA_EXEC_WRAPPER",
  "DASH0_ENDPOINT",
  "DASH0_TOKEN",
  "DASH0_TOKEN_SECRET_ARN",
  "DASH0_TOKEN_SECRET_KEY",

  // Common knobs
  "DASH0_DATASET",
  "DASH0_DISABLE_AUTO_INSTRUMENTATION",
  "DASH0_SEND_ON_INVOCATION_END",
  "DASH0_EXTENSION_LOG_LEVEL",
  "DASH0_DISTRO_DEBUG",
  "DASH0_REQUEST_TIMEOUT",
  "DASH0_CREATE_PAYLOAD_LOG_RECORDS",
  "DASH0_DISABLE_TELEMETRY_LOG_COLLECTION",
  "DASH0_XRAY_TRACES_ENABLED",

  // Secret masking
  "DASH0_MASK_RULES",
  "DASH0_MASK_ENV_VARS",
  "DASH0_MASK_REQUEST_BODY",
  "DASH0_MASK_REQUEST_HEADERS",
  "DASH0_MASK_RESPONSE_BODY",
  "DASH0_MASK_RESPONSE_HEADERS",
  "DASH0_MASK_QUERY_PARAMS",

  // OTel naming — extension reads OTEL_SERVICE_NAME for service.name
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

export type Dash0EnvKey = (typeof DASH0_ENV_KEYS)[number];

const TOKEN_RE = /^auth_[A-Za-z0-9]{32,}$/;
const ENDPOINT_RE = /^https?:\/\/[^\s]+$/;

/**
 * Boolean-ish helper: extension treats "true"/"false" strings.
 * We accept JS booleans on the CLI side and serialize to lowercase strings.
 */
const StringBool = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((v) => (typeof v === "boolean" ? (v ? "true" : "false") : v));

/**
 * Validates the input the user provides on the CLI before we mutate the
 * function. We don't validate the on-function shape — that's the doctor's job.
 */
export const Dash0InstallConfigSchema = z
  .object({
    /** OTLP HTTPS endpoint, e.g. https://ingress.us-west-2.aws.dash0.com:4318 */
    endpoint: z.string().regex(ENDPOINT_RE, {
      message: "endpoint must be a full https:// URL including port",
    }),
    /** Plain auth token. Mutually exclusive with tokenSecretArn. */
    token: z.string().regex(TOKEN_RE).optional(),
    /** Secrets Manager ARN that holds the token; preferred for prod. */
    tokenSecretArn: z
      .string()
      .regex(/^arn:aws:secretsmanager:/, {
        message: "tokenSecretArn must be a Secrets Manager ARN",
      })
      .optional(),
    /** JSON key inside the secret if the secret holds a JSON object. */
    tokenSecretKey: z.string().min(1).optional(),
    /**
     * Optional explicit auth mode. When set, exactly one of token/secret
     * must be provided AND install will clear the other env var on the
     * function so the two can never coexist.
     *
     * Per the extension docs DASH0_TOKEN takes precedence over
     * DASH0_TOKEN_SECRET_ARN; pinning a mode prevents accidental wins.
     */
    authMode: z.enum(["token", "secret"]).optional(),

    /** Routes OTLP exports to the named dataset in Dash0. */
    dataset: z.string().min(1).max(100).optional(),
    /** Service name → emitted as OTEL_SERVICE_NAME. */
    serviceName: z.string().min(1).max(255).optional(),
    /** Extension's own log level. */
    extensionLogLevel: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .optional(),
    /** Verbose distro debug logs (DASH0_DISTRO_DEBUG). */
    distroDebug: StringBool.optional(),
    /** Disable auto-instrumentation (synthetic-only mode). */
    disableAutoInstrumentation: StringBool.optional(),
    /** When true (default), send on invocation end. */
    sendOnInvocationEnd: StringBool.optional(),
    /** When AWS X-Ray active tracing is enabled, set this true. */
    xrayTracesEnabled: StringBool.optional(),
    /** HTTP request timeout in ms. */
    requestTimeoutMs: z.number().int().positive().optional(),
    /** Disable per-invocation request/response payload log records. */
    createPayloadLogRecords: StringBool.optional(),
    /** Disable telemetry log collection (Lambda Telemetry API). */
    disableTelemetryLogCollection: StringBool.optional(),

    /** Custom secret-masking rules. JSON-encoded array of regex patterns. */
    maskRules: z.array(z.string()).optional(),
    maskEnvVars: z.array(z.string()).optional(),
    maskRequestBody: z.array(z.string()).optional(),
    maskRequestHeaders: z.array(z.string()).optional(),
    maskResponseBody: z.array(z.string()).optional(),
    maskResponseHeaders: z.array(z.string()).optional(),
    maskQueryParams: z.array(z.string()).optional(),

    /** Extra OTEL_RESOURCE_ATTRIBUTES key=value pairs to merge. */
    resourceAttributes: z.record(z.string(), z.string()).optional(),

    /** Free-form escape hatch — applied last, can override anything above. */
    extraEnv: z.record(z.string(), z.string()).optional(),
  })
  .refine((c) => !!c.token || !!c.tokenSecretArn, {
    message: "either --token or --token-secret-arn is required",
  })
  .refine((c) => !c.tokenSecretKey || !!c.tokenSecretArn, {
    message: "--token-secret-key requires --token-secret-arn",
  })
  .refine(
    (c) => c.authMode !== "token" || (!!c.token && !c.tokenSecretArn),
    {
      message:
        "--auth-mode token requires --token and forbids --token-secret-arn",
    },
  )
  .refine(
    (c) => c.authMode !== "secret" || (!!c.tokenSecretArn && !c.token),
    {
      message:
        "--auth-mode secret requires --token-secret-arn and forbids --token",
    },
  );

export type Dash0InstallConfig = z.infer<typeof Dash0InstallConfigSchema>;

/**
 * Render an install config into the env-var key/value pairs that go onto
 * the Lambda function. Excludes AWS_LAMBDA_EXEC_WRAPPER — set by install.ts
 * based on the resolved runtime family.
 *
 * Default behavior (no flags beyond endpoint + token): emit ONLY the
 * required vars per the extension README — DASH0_ENDPOINT and one of
 * DASH0_TOKEN / DASH0_TOKEN_SECRET_ARN. Every other env var below is
 * gated on its corresponding option being explicitly set, so we never
 * push extension knobs the operator didn't ask for.
 */
export function configToEnv(c: Dash0InstallConfig): Record<string, string> {
  // Required.
  const env: Record<string, string> = {
    DASH0_ENDPOINT: c.endpoint,
  };
  if (c.token) env.DASH0_TOKEN = c.token;
  if (c.tokenSecretArn) env.DASH0_TOKEN_SECRET_ARN = c.tokenSecretArn;
  if (c.tokenSecretKey) env.DASH0_TOKEN_SECRET_KEY = c.tokenSecretKey;

  // Optional knobs below — only emitted when the operator explicitly
  // passed a flag for them. Anything left undefined is left untouched
  // on the function (mergeEnv preserves existing values).

  if (c.dataset) env.DASH0_DATASET = c.dataset;
  if (c.serviceName) env.OTEL_SERVICE_NAME = c.serviceName;

  if (c.extensionLogLevel) env.DASH0_EXTENSION_LOG_LEVEL = c.extensionLogLevel;
  if (c.distroDebug !== undefined)
    env.DASH0_DISTRO_DEBUG = boolStr(c.distroDebug);
  if (c.disableAutoInstrumentation !== undefined)
    env.DASH0_DISABLE_AUTO_INSTRUMENTATION = boolStr(c.disableAutoInstrumentation);
  if (c.sendOnInvocationEnd !== undefined)
    env.DASH0_SEND_ON_INVOCATION_END = boolStr(c.sendOnInvocationEnd);
  if (c.xrayTracesEnabled !== undefined)
    env.DASH0_XRAY_TRACES_ENABLED = boolStr(c.xrayTracesEnabled);
  if (c.createPayloadLogRecords !== undefined)
    env.DASH0_CREATE_PAYLOAD_LOG_RECORDS = boolStr(c.createPayloadLogRecords);
  if (c.disableTelemetryLogCollection !== undefined)
    env.DASH0_DISABLE_TELEMETRY_LOG_COLLECTION = boolStr(
      c.disableTelemetryLogCollection,
    );
  if (c.requestTimeoutMs !== undefined)
    env.DASH0_REQUEST_TIMEOUT = String(c.requestTimeoutMs);

  if (c.maskRules) env.DASH0_MASK_RULES = JSON.stringify(c.maskRules);
  if (c.maskEnvVars) env.DASH0_MASK_ENV_VARS = JSON.stringify(c.maskEnvVars);
  if (c.maskRequestBody)
    env.DASH0_MASK_REQUEST_BODY = JSON.stringify(c.maskRequestBody);
  if (c.maskRequestHeaders)
    env.DASH0_MASK_REQUEST_HEADERS = JSON.stringify(c.maskRequestHeaders);
  if (c.maskResponseBody)
    env.DASH0_MASK_RESPONSE_BODY = JSON.stringify(c.maskResponseBody);
  if (c.maskResponseHeaders)
    env.DASH0_MASK_RESPONSE_HEADERS = JSON.stringify(c.maskResponseHeaders);
  if (c.maskQueryParams)
    env.DASH0_MASK_QUERY_PARAMS = JSON.stringify(c.maskQueryParams);

  if (c.resourceAttributes && Object.keys(c.resourceAttributes).length > 0) {
    env.OTEL_RESOURCE_ATTRIBUTES = Object.entries(c.resourceAttributes)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  }

  // Extra env wins last — operator escape hatch.
  if (c.extraEnv) Object.assign(env, c.extraEnv);

  return env;
}

/** Normalize a boolean-or-string into "true"/"false". */
function boolStr(v: boolean | "true" | "false" | string): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

/**
 * Merge new Dash0 env into existing function env, preserving anything else
 * the customer set (DB URLs, feature flags, etc.).
 */
export function mergeEnv(
  existing: Record<string, string> | undefined,
  desired: Record<string, string>,
): Record<string, string> {
  return { ...(existing ?? {}), ...desired };
}

/**
 * Strip every key the extension owns. Used by `uninstall` so customers
 * end up clean. Anything else stays.
 */
export function stripDash0Keys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (DASH0_ENV_KEYS.includes(k as Dash0EnvKey)) continue;
    out[k] = v;
  }
  return out;
}

/** Diff of env between current and desired. Used in dry-run output. */
export interface EnvDiff {
  added: Array<[string, string]>;
  changed: Array<[string, string, string]>; // [key, before, after]
  removed: Array<[string, string]>;
  unchanged: number;
}

export function diffEnv(
  before: Record<string, string> | undefined,
  after: Record<string, string>,
): EnvDiff {
  const beforeMap = before ?? {};
  const diff: EnvDiff = {
    added: [],
    changed: [],
    removed: [],
    unchanged: 0,
  };
  const allKeys = new Set([...Object.keys(beforeMap), ...Object.keys(after)]);
  for (const k of allKeys) {
    const b = beforeMap[k];
    const a = after[k];
    if (b === undefined && a !== undefined) diff.added.push([k, a]);
    else if (b !== undefined && a === undefined) diff.removed.push([k, b]);
    else if (b !== a && b !== undefined && a !== undefined)
      diff.changed.push([k, b, a]);
    else diff.unchanged++;
  }
  return diff;
}
