/**
 * Tests for `uninstall` — remove Dash0 from a function.
 *
 * uninstall is destructive and its docstring states the contract precisely:
 * "Leaves everything else (including AWS_LAMBDA_EXEC_WRAPPER if the customer
 * set it for some other reason)."
 *
 * That sentence is the hard part. AWS_LAMBDA_EXEC_WRAPPER is listed in
 * DASH0_ENV_KEYS because *install* owns it, so `stripDash0Keys` deletes it
 * unconditionally. Only a value of exactly "/opt/wrapper" is Dash0's. Any
 * other value belongs to somebody else — Lumigo's Java tracer
 * (/opt/lumigo_wrapper), or a customer's own shim — and deleting it while
 * uninstalling a *different* vendor is the mirror image of the bug
 * `remove-lumigo` was explicitly built to avoid.
 *
 * The rest of the suite covers the layer partition, the no-op path, and the
 * dangling-wrapper warning.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { uninstall } from "../src/commands/uninstall.js";
import { KNOWN_LATEST_LAYER_VERSION } from "../src/lib/layers.js";

const lambdaMock = mockClient(LambdaClient);

let logged: string[];

beforeEach(() => {
  lambdaMock.reset();
  logged = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void logged.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void logged.push(a.join(" ")),
  );
});
afterEach(() => {
  lambdaMock.reset();
  vi.restoreAllMocks();
});

const REGION = "us-west-2";
const DASH0_NODE = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:${KNOWN_LATEST_LAYER_VERSION.node}`;
const DASH0_JAVA = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-java:${KNOWN_LATEST_LAYER_VERSION.java}`;
const LUMIGO_JAVA =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-java-tracer:99";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";

function seed(spec: {
  runtime?: string;
  layers?: string[];
  env?: Record<string, string>;
}) {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves({
    FunctionName: "orders-create",
    Runtime: spec.runtime ?? "nodejs20.x",
    Architectures: ["x86_64"],
    PackageType: "Zip",
    Layers: (spec.layers ?? [DASH0_NODE]).map((Arn) => ({ Arn })),
    Environment: { Variables: spec.env ?? {} },
    Role: "arn:aws:iam::111:role/orders-create",
  });
  lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
}

function wrapper(dryRun = false) {
  return new LambdaWrapper({
    region: REGION,
    dryRun,
    client: lambdaMock as unknown as LambdaClient,
  });
}

function theWrite() {
  const calls = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand);
  expect(calls).toHaveLength(1);
  const input = calls[0]!.args[0].input;
  return {
    layers: input.Layers ?? [],
    env: input.Environment?.Variables ?? {},
  };
}

function writeCount() {
  return lambdaMock.commandCalls(UpdateFunctionConfigurationCommand).length;
}

const base = { function: "orders-create", region: REGION };

describe("uninstall — removes the Dash0 footprint", () => {
  it("detaches the Dash0 layer and deletes every DASH0_* var", async () => {
    seed({
      layers: [DASH0_NODE],
      env: {
        DASH0_ENDPOINT: "https://ingress:4318",
        DASH0_TOKEN: "auth_" + "a".repeat(40),
        DASH0_DATASET: "prod",
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
      },
    });

    const out = await uninstall({
      ...base,
      clearWrapper: true,
      lambda: wrapper(),
    });

    expect(out.applied).toBe(true);
    expect(out.removedLayers).toEqual([DASH0_NODE]);
    const { layers, env } = theWrite();
    expect(layers).toEqual([]);
    expect(env).toEqual({});
  });

  it("keeps unrelated layers and unrelated env vars", async () => {
    seed({
      layers: [CUSTOM_LIB, DASH0_NODE],
      env: { DASH0_ENDPOINT: "https://x:4318", DB_URL: "postgres://x" },
    });

    await uninstall({ ...base, lambda: wrapper() });

    const { layers, env } = theWrite();
    expect(layers).toEqual([CUSTOM_LIB]);
    expect(env).toEqual({ DB_URL: "postgres://x" });
  });

  it("removes every Dash0 layer when more than one is somehow attached", async () => {
    const stale =
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:3";
    seed({ layers: [stale, CUSTOM_LIB, DASH0_NODE], env: {} });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.removedLayers.sort()).toEqual([DASH0_NODE, stale].sort());
    expect(theWrite().layers).toEqual([CUSTOM_LIB]);
  });

  it("reports envBefore and envAfter for the caller", async () => {
    seed({
      layers: [DASH0_NODE],
      env: { DASH0_ENDPOINT: "https://x:4318", KEEP: "1" },
    });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.envBefore).toEqual({
      DASH0_ENDPOINT: "https://x:4318",
      KEEP: "1",
    });
    expect(out.envAfter).toEqual({ KEEP: "1" });
  });
});

describe("uninstall — AWS_LAMBDA_EXEC_WRAPPER belongs to whoever set it", () => {
  it("leaves a Lumigo Java wrapper alone", async () => {
    // Java-on-Lumigo has no preload mechanism: /opt/lumigo_wrapper IS the
    // instrumentation. Deleting it while removing *Dash0* silently untraces
    // the function for a vendor this command was never asked to touch.
    seed({
      runtime: "java21",
      layers: [DASH0_JAVA, LUMIGO_JAVA],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
        LUMIGO_TRACER_TOKEN: "t_abc",
        DASH0_ENDPOINT: "https://x:4318",
      },
    });

    await uninstall({ ...base, lambda: wrapper() });

    const { layers, env } = theWrite();
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/lumigo_wrapper");
    expect(env.LUMIGO_TRACER_TOKEN).toBe("t_abc");
    expect(layers).toEqual([LUMIGO_JAVA]);
    expect(env.DASH0_ENDPOINT).toBeUndefined();
  });

  it("leaves a customer's own wrapper alone", async () => {
    seed({
      layers: [DASH0_NODE],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/my-company-shim",
        DASH0_ENDPOINT: "https://x:4318",
      },
    });

    await uninstall({ ...base, lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/my-company-shim");
  });

  it("does not clear a foreign wrapper even with --clear-wrapper", async () => {
    // --clear-wrapper is documented as "delete it if it points at
    // /opt/wrapper". It is not a licence to delete somebody else's.
    seed({
      runtime: "java21",
      layers: [DASH0_JAVA, LUMIGO_JAVA],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
        DASH0_ENDPOINT: "https://x:4318",
      },
    });

    await uninstall({ ...base, clearWrapper: true, lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/lumigo_wrapper");
  });

  it("clears Dash0's own wrapper when --clear-wrapper is passed", async () => {
    seed({
      layers: [DASH0_NODE],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
        DASH0_ENDPOINT: "https://x:4318",
      },
    });

    await uninstall({ ...base, clearWrapper: true, lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
  });

  it("keeps Dash0's wrapper and warns loudly without --clear-wrapper", async () => {
    // The layer providing /opt/wrapper is going away. Leaving the var set is
    // deliberate (we don't delete what we didn't verify we own) but the
    // function will hard-fail on next invocation, so the warning is the
    // load-bearing part.
    seed({
      layers: [DASH0_NODE],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
        DASH0_ENDPOINT: "https://x:4318",
      },
    });

    await uninstall({ ...base, lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper");
    expect(logged.join("\n")).toMatch(/fail at next invocation/);
    expect(logged.join("\n")).toMatch(/--clear-wrapper/);
  });

  it("does not warn about a dangling wrapper when there isn't one", async () => {
    seed({ layers: [DASH0_NODE], env: { DASH0_ENDPOINT: "https://x:4318" } });

    await uninstall({ ...base, lambda: wrapper() });

    expect(logged.join("\n")).not.toMatch(/fail at next invocation/);
  });
});

describe("uninstall — the no-op path", () => {
  it("writes nothing when there is no Dash0 footprint", async () => {
    seed({ layers: [CUSTOM_LIB], env: { DB_URL: "postgres://x" } });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.applied).toBe(false);
    expect(out.removedLayers).toEqual([]);
    expect(writeCount()).toBe(0);
    expect(logged.join("\n")).toMatch(/No Dash0 footprint/);
  });

  it("writes nothing for a Lumigo-only function", async () => {
    // Nothing here is ours. An update that "cleans up" would be a silent
    // rewrite of somebody else's configuration.
    seed({
      runtime: "java21",
      layers: [LUMIGO_JAVA],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
        LUMIGO_TRACER_TOKEN: "t_abc",
      },
    });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.applied).toBe(false);
    expect(writeCount()).toBe(0);
  });

  it("still writes when only env vars need removing (no layer attached)", async () => {
    seed({ layers: [], env: { DASH0_ENDPOINT: "https://x:4318" } });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.applied).toBe(true);
    expect(theWrite().env).toEqual({});
  });

  it("still writes when only a layer needs removing (no env set)", async () => {
    seed({ layers: [DASH0_NODE], env: { DB_URL: "postgres://x" } });

    const out = await uninstall({ ...base, lambda: wrapper() });

    expect(out.applied).toBe(true);
    expect(theWrite().layers).toEqual([]);
  });
});

describe("uninstall — gates and errors", () => {
  it("plans without writing on --dry-run", async () => {
    seed({
      layers: [DASH0_NODE],
      env: { DASH0_ENDPOINT: "https://x:4318" },
    });

    const out = await uninstall({ ...base, dryRun: true, lambda: wrapper(true) });

    expect(out.applied).toBe(false);
    // The plan is still computed and reported.
    expect(out.removedLayers).toEqual([DASH0_NODE]);
    expect(out.envAfter).toEqual({});
    expect(writeCount()).toBe(0);
  });

  it("wraps a fetch failure with the function name", async () => {
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .rejects(new Error("ResourceNotFoundException"));

    await expect(uninstall({ ...base, lambda: wrapper() })).rejects.toThrow(
      /failed to fetch function orders-create/,
    );
  });

  it("wraps an update failure with the function name", async () => {
    seed({ layers: [DASH0_NODE], env: {} });
    lambdaMock
      .on(UpdateFunctionConfigurationCommand)
      .rejects(new Error("ResourceConflictException"));

    await expect(uninstall({ ...base, lambda: wrapper() })).rejects.toThrow(
      /failed to update function orders-create/,
    );
  });

  it("ignores a layer entry with no ARN instead of writing an empty string", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      PackageType: "Zip",
      Layers: [{ Arn: DASH0_NODE }, {}],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    await uninstall({ ...base, lambda: wrapper() });

    expect(theWrite().layers).toEqual([]);
  });
});
