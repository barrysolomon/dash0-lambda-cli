/**
 * Tests for `switch` — the Dash0 ↔ Lumigo vendor flip.
 *
 * `switch` is a wrapper toggle, not an installer. Its contract has three
 * halves, and each one fails silently if broken:
 *
 *   1. LAYERS ARE NEVER TOUCHED. The command reads the function's layer list
 *      and writes it back verbatim. A bug here silently uninstalls a vendor.
 *   2. THE FLIP IS A TWO-VARIABLE INVARIANT. Landing on Dash0 means
 *      AWS_LAMBDA_EXEC_WRAPPER=/opt/wrapper *and* LUMIGO_SWITCH_OFF=true
 *      (when a Lumigo layer is present). Getting one right and the other
 *      wrong yields a function that is double-traced or not traced at all —
 *      and AWS reports the update as a success either way.
 *   3. THE TARGET'S LAYER MUST ALREADY BE ATTACHED. Switching toward a
 *      vendor whose binary isn't on disk is refused, not attempted.
 *
 * `buildSwitchPlan` itself is covered by vendor.test.ts; this suite covers
 * the command that wraps it — the gates, the write, and the negatives.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { switchVendor } from "../src/commands/switchVendor.js";
import { KNOWN_LATEST_LAYER_VERSION } from "../src/lib/layers.js";

const lambdaMock = mockClient(LambdaClient);

beforeEach(() => {
  lambdaMock.reset();
  // switch is a chatty command; keep the suite output readable.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  lambdaMock.reset();
  vi.restoreAllMocks();
});

const REGION = "us-west-2";
const LUMIGO_NODE =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:312";
const LUMIGO_JAVA =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-java-tracer:99";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";
const DASH0_NODE = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:${KNOWN_LATEST_LAYER_VERSION.node}`;
const DASH0_JAVA = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-java:${KNOWN_LATEST_LAYER_VERSION.java}`;

interface FnSpec {
  runtime?: string;
  layers?: string[];
  env?: Record<string, string>;
}

function seed(spec: FnSpec) {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves({
    FunctionName: "orders-create",
    Runtime: spec.runtime ?? "nodejs20.x",
    Architectures: ["x86_64"],
    PackageType: "Zip",
    Layers: (spec.layers ?? []).map((Arn) => ({ Arn })),
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

/** The single write this command should make. Throws if there wasn't exactly one. */
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

describe("switch → dash0", () => {
  it("sets the Dash0 wrapper and kills Lumigo's auto-loader in one write", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: { LUMIGO_TRACER_TOKEN: "t_abc" },
    });

    const out = await switchVendor({
      ...base,
      target: "dash0",
      lambda: wrapper(),
    });

    expect(out.applied).toBe(true);
    const { env } = theWrite();
    // The two-variable invariant — both halves, or the flip is broken.
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper");
    expect(env.LUMIGO_SWITCH_OFF).toBe("true");
  });

  it("does not set LUMIGO_SWITCH_OFF when no Lumigo layer is attached", async () => {
    // Nothing to switch off. Writing the var anyway is dead weight against
    // the hard 4KB Lambda env limit.
    seed({ layers: [DASH0_NODE], env: {} });

    await switchVendor({ ...base, target: "dash0", lambda: wrapper() });

    expect(theWrite().env.LUMIGO_SWITCH_OFF).toBeUndefined();
  });

  it("overwrites a Lumigo wrapper rather than appending to it", async () => {
    seed({
      runtime: "java21",
      layers: [DASH0_JAVA, LUMIGO_JAVA],
      env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper" },
    });

    await switchVendor({ ...base, target: "dash0", lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper");
  });

  it("flips LUMIGO_SWITCH_OFF from false to true", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: { LUMIGO_SWITCH_OFF: "false" },
    });

    await switchVendor({ ...base, target: "dash0", lambda: wrapper() });

    expect(theWrite().env.LUMIGO_SWITCH_OFF).toBe("true");
  });
});

describe("switch → lumigo", () => {
  it("unsets the wrapper for Node (the tracer auto-loads via preload)", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
        LUMIGO_SWITCH_OFF: "true",
        LUMIGO_TRACER_TOKEN: "t_abc",
      },
    });

    await switchVendor({ ...base, target: "lumigo", lambda: wrapper() });

    const { env } = theWrite();
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
    // Both halves again: leaving the kill-switch on would silently keep
    // Lumigo dark even though the wrapper says "we're on Lumigo now".
    expect(env.LUMIGO_SWITCH_OFF).toBeUndefined();
  });

  it("sets /opt/lumigo_wrapper for Java (no preload mechanism there)", async () => {
    seed({
      runtime: "java21",
      layers: [DASH0_JAVA, LUMIGO_JAVA],
      env: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
        LUMIGO_TRACER_TOKEN: "t_abc",
      },
    });

    await switchVendor({ ...base, target: "lumigo", lambda: wrapper() });

    expect(theWrite().env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/lumigo_wrapper");
  });

  it("removes the kill-switch even when the wrapper needs no change", async () => {
    // Node function, wrapper already unset — the only thing standing between
    // this function and live Lumigo tracing is LUMIGO_SWITCH_OFF. If the
    // command short-circuits on "wrapper already correct", nothing happens
    // and the operator is told they're on Lumigo when they are not.
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: { LUMIGO_SWITCH_OFF: "true", LUMIGO_TRACER_TOKEN: "t_abc" },
    });

    const out = await switchVendor({
      ...base,
      target: "lumigo",
      lambda: wrapper(),
    });

    expect(out.applied).toBe(true);
    expect(theWrite().env.LUMIGO_SWITCH_OFF).toBeUndefined();
  });

  it("warns when switching to Lumigo without a tracer token", async () => {
    const logged: string[] = [];
    (console.log as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (...a: unknown[]) => void logged.push(a.join(" ")),
    );
    seed({
      runtime: "java21",
      layers: [DASH0_JAVA, LUMIGO_JAVA],
      env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper" },
    });

    await switchVendor({ ...base, target: "lumigo", lambda: wrapper() });

    expect(logged.join("\n")).toMatch(/LUMIGO_TRACER_TOKEN is unset/);
  });
});

describe("switch — layers are never touched", () => {
  it("writes the layer list back byte-for-byte, in order", async () => {
    // The single most dangerous failure mode: switch is a wrapper toggle, but
    // it issues a full UpdateFunctionConfiguration, and Layers is a full
    // replacement field. Dropping one entry uninstalls that vendor for good.
    const layers = [CUSTOM_LIB, DASH0_NODE, LUMIGO_NODE];
    seed({ layers, env: { LUMIGO_TRACER_TOKEN: "t_abc" } });

    await switchVendor({ ...base, target: "dash0", lambda: wrapper() });

    expect(theWrite().layers).toEqual(layers);
  });

  it("preserves unrelated env vars", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: {
        DB_URL: "postgres://x",
        LUMIGO_TRACER_TOKEN: "t_abc",
        FEATURE_FLAG: "on",
      },
    });

    await switchVendor({ ...base, target: "dash0", lambda: wrapper() });

    const { env } = theWrite();
    expect(env.DB_URL).toBe("postgres://x");
    expect(env.FEATURE_FLAG).toBe("on");
    // switch does NOT uninstall the other vendor — only silences it.
    expect(env.LUMIGO_TRACER_TOKEN).toBe("t_abc");
  });
});

describe("switch — gates", () => {
  it("refuses to switch to Dash0 when the Dash0 layer is missing", async () => {
    seed({ layers: [LUMIGO_NODE], env: { LUMIGO_TRACER_TOKEN: "t_abc" } });

    await expect(
      switchVendor({ ...base, target: "dash0", lambda: wrapper() }),
    ).rejects.toThrow(/no Dash0 layer attached/);
    expect(writeCount()).toBe(0);
  });

  it("refuses to switch to Lumigo when the Lumigo layer is missing", async () => {
    seed({ layers: [DASH0_NODE], env: {} });

    await expect(
      switchVendor({ ...base, target: "lumigo", lambda: wrapper() }),
    ).rejects.toThrow(/no Lumigo layer attached/);
    expect(writeCount()).toBe(0);
  });

  it("exits 6 on a blocker so scripts can tell it apart from an AWS failure", async () => {
    seed({ layers: [LUMIGO_NODE] });

    await expect(
      switchVendor({ ...base, target: "dash0", lambda: wrapper() }),
    ).rejects.toMatchObject({ exitCode: 6 });
  });

  it("is a no-op when already on the target vendor", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper", LUMIGO_SWITCH_OFF: "true" },
    });

    const out = await switchVendor({
      ...base,
      target: "dash0",
      lambda: wrapper(),
    });

    expect(out).toEqual({
      function: "orders-create",
      applied: false,
      changes: [],
    });
    expect(writeCount()).toBe(0);
  });

  it("plans without writing on --dry-run", async () => {
    seed({
      layers: [DASH0_NODE, LUMIGO_NODE],
      env: { LUMIGO_TRACER_TOKEN: "t_abc" },
    });

    const out = await switchVendor({
      ...base,
      target: "dash0",
      dryRun: true,
      lambda: wrapper(true),
    });

    expect(out.applied).toBe(false);
    // ...but it still reports what it *would* have changed.
    expect(out.changes.map(([k]) => k).sort()).toEqual([
      "AWS_LAMBDA_EXEC_WRAPPER",
      "LUMIGO_SWITCH_OFF",
    ]);
    expect(writeCount()).toBe(0);
  });
});

describe("switch — error wrapping", () => {
  it("wraps a fetch failure with the function name", async () => {
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .rejects(new Error("ResourceNotFoundException: no such function"));

    await expect(
      switchVendor({ ...base, target: "dash0", lambda: wrapper() }),
    ).rejects.toThrow(/failed to fetch function orders-create/);
  });

  it("wraps an update failure with the function name", async () => {
    seed({ layers: [DASH0_NODE], env: {} });
    lambdaMock
      .on(UpdateFunctionConfigurationCommand)
      .rejects(new Error("ResourceConflictException: update in progress"));

    await expect(
      switchVendor({ ...base, target: "dash0", lambda: wrapper() }),
    ).rejects.toThrow(/failed to update function orders-create/);
  });
});
