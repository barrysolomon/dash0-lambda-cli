import { describe, expect, it } from "vitest";
import {
  configToEnv,
  Dash0InstallConfigSchema,
  diffEnv,
  mergeEnv,
  stripDash0Keys,
} from "../src/lib/env.js";

const VALID_TOKEN = "auth_" + "a".repeat(40);
const ENDPOINT = "https://ingress.us-west-2.aws.dash0.com:4318";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:123456789012:secret:dash0-token-AbCdEf";

describe("Dash0InstallConfigSchema", () => {
  it("accepts a token-based config", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
    });
    expect(r.success).toBe(true);
  });
  it("accepts a secret-based config", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
    });
    expect(r.success).toBe(true);
  });
  it("accepts a secret + key config (when secret is JSON)", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      tokenSecretKey: "dash0_token",
    });
    expect(r.success).toBe(true);
  });
  it("rejects --token-secret-key without --token-secret-arn", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      tokenSecretKey: "dash0_token",
    });
    expect(r.success).toBe(false);
  });
  it("rejects when neither token nor secret provided", () => {
    const r = Dash0InstallConfigSchema.safeParse({ endpoint: ENDPOINT });
    expect(r.success).toBe(false);
  });
  it("ALLOWS both token and secret (extension docs: DASH0_TOKEN takes precedence)", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      tokenSecretArn: SECRET_ARN,
    });
    expect(r.success).toBe(true);
  });
  it("rejects malformed endpoint", () => {
    const r = Dash0InstallConfigSchema.safeParse({
      endpoint: "ingress.us-west-2.aws.dash0.com",
      token: VALID_TOKEN,
    });
    expect(r.success).toBe(false);
  });
});

describe("configToEnv", () => {
  it("by default emits ONLY the required env vars (endpoint + token)", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
    });
    expect(Object.keys(env).sort()).toEqual([
      "DASH0_ENDPOINT",
      "DASH0_TOKEN",
    ]);
  });
  it("emits only set fields", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
    });
    expect(env.DASH0_ENDPOINT).toBe(ENDPOINT);
    expect(env.DASH0_TOKEN).toBeDefined();
    expect(env.DASH0_DATASET).toBeUndefined();
    expect(env.OTEL_SERVICE_NAME).toBeUndefined();
  });
  it("uses real env var names for log level and service name", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      extensionLogLevel: "debug",
      serviceName: "orders-create",
    });
    expect(env.DASH0_EXTENSION_LOG_LEVEL).toBe("debug");
    expect(env.OTEL_SERVICE_NAME).toBe("orders-create");
    // not these:
    expect(env.DASH0_LOG_LEVEL).toBeUndefined();
    expect(env.DASH0_SERVICE_NAME).toBeUndefined();
  });
  it("flattens resourceAttributes into OTEL_RESOURCE_ATTRIBUTES", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      resourceAttributes: { team: "orders", env: "prod" },
    });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toMatch(/team=orders/);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toMatch(/env=prod/);
  });
  it("serializes mask rules as JSON arrays", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      maskRules: [".*token.*", ".*auth.*"],
      maskQueryParams: [".*api_key.*"],
    });
    expect(env.DASH0_MASK_RULES).toBe('[".*token.*",".*auth.*"]');
    expect(env.DASH0_MASK_QUERY_PARAMS).toBe('[".*api_key.*"]');
  });
  it("emits boolean knobs as 'true'/'false' strings", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      disableAutoInstrumentation: true,
      sendOnInvocationEnd: false,
      xrayTracesEnabled: true,
    });
    expect(env.DASH0_DISABLE_AUTO_INSTRUMENTATION).toBe("true");
    expect(env.DASH0_SEND_ON_INVOCATION_END).toBe("false");
    expect(env.DASH0_XRAY_TRACES_ENABLED).toBe("true");
  });
  it("extraEnv wins last and can override anything", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      dataset: "preprod",
      extraEnv: { DASH0_DATASET: "production" },
    });
    expect(env.DASH0_DATASET).toBe("production");
  });
  it("includes DASH0_TOKEN_SECRET_KEY when set", () => {
    const env = configToEnv({
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      tokenSecretKey: "dash0_token",
    });
    expect(env.DASH0_TOKEN_SECRET_KEY).toBe("dash0_token");
  });
});

describe("mergeEnv", () => {
  it("preserves caller env, overlays Dash0 env", () => {
    const merged = mergeEnv(
      { LOG_LEVEL: "info", DB_URL: "postgres://..." },
      { DASH0_TOKEN: "x", DASH0_ENDPOINT: "y" },
    );
    expect(merged.LOG_LEVEL).toBe("info");
    expect(merged.DB_URL).toBeDefined();
    expect(merged.DASH0_TOKEN).toBe("x");
  });
  it("desired wins on conflict", () => {
    const merged = mergeEnv({ A: "1" }, { A: "2" });
    expect(merged.A).toBe("2");
  });
});

describe("stripDash0Keys", () => {
  it("removes every Dash0-owned key", () => {
    const out = stripDash0Keys({
      DASH0_TOKEN: "x",
      DASH0_ENDPOINT: "y",
      DASH0_EXTENSION_LOG_LEVEL: "debug",
      DASH0_MASK_RULES: "[]",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
      OTEL_RESOURCE_ATTRIBUTES: "team=a",
      OTEL_SERVICE_NAME: "fn",
      DB_URL: "kept",
    });
    expect(out).toEqual({ DB_URL: "kept" });
  });
  it("handles undefined", () => {
    expect(stripDash0Keys(undefined)).toEqual({});
  });
});

describe("diffEnv", () => {
  it("classifies adds, changes, removes, unchanged", () => {
    const d = diffEnv(
      { A: "1", B: "2", C: "3" },
      { A: "1", B: "x", D: "4" },
    );
    expect(d.unchanged).toBe(1);
    expect(d.changed).toEqual([["B", "2", "x"]]);
    expect(d.added).toEqual([["D", "4"]]);
    expect(d.removed).toEqual([["C", "3"]]);
  });
});
