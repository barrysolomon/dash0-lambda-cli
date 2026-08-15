/**
 * Unit tests for `remove-lumigo` — the "untrace Lumigo" path.
 *
 * The load-bearing safety property here is the exec-wrapper guard: the
 * command must clear AWS_LAMBDA_EXEC_WRAPPER only when it points at a
 * *Lumigo* wrapper. A Dash0-traced function carries /opt/wrapper, and
 * clearing that would silently un-instrument Dash0 while claiming to
 * have only removed Lumigo.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListFunctionsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { removeLumigo } from "../src/commands/removeLumigo.js";

const lambdaMock = mockClient(LambdaClient);
beforeEach(() => lambdaMock.reset());
afterEach(() => lambdaMock.reset());

const LUMIGO_LAYER =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:312";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";
const DASH0_LAYER =
  "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:20";

function newWrapper() {
  return new LambdaWrapper({
    region: "us-west-2",
    client: lambdaMock as unknown as LambdaClient,
  });
}

function seed(layers: string[], env: Record<string, string>) {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves({
    FunctionName: "orders-create",
    Runtime: "nodejs20.x",
    Architectures: ["x86_64"],
    Layers: layers.map((Arn) => ({ Arn })),
    Environment: { Variables: env },
    Role: "arn:aws:iam::111:role/orders-create",
  });
  lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
}

/**
 * A three-function fleet for --filter tests. ListFunctions returns full
 * configs, so selectTargets can filter without a per-function Get.
 */
function seedFleet() {
  lambdaMock.on(ListFunctionsCommand).resolves({
    Functions: [
      {
        FunctionName: "orders-create",
        Runtime: "nodejs20.x",
        Layers: [{ Arn: LUMIGO_LAYER }],
        Environment: { Variables: { LUMIGO_TRACER_TOKEN: "t_abc" } },
        Role: "arn:aws:iam::111:role/orders-create",
      },
      {
        FunctionName: "orders-charge",
        Runtime: "nodejs20.x",
        Layers: [{ Arn: LUMIGO_LAYER }],
        Environment: { Variables: { LUMIGO_TRACER_TOKEN: "t_def" } },
        Role: "arn:aws:iam::111:role/orders-charge",
      },
      {
        // Must NOT match /^orders-/ — guards against an over-broad sweep.
        FunctionName: "payments-refund",
        Runtime: "nodejs20.x",
        Layers: [{ Arn: LUMIGO_LAYER }],
        Environment: { Variables: { LUMIGO_TRACER_TOKEN: "t_ghi" } },
        Role: "arn:aws:iam::111:role/payments-refund",
      },
    ],
  });
  lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
}

/** Params actually sent to Lambda on the single update call. */
function sentConfig() {
  const calls = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand);
  expect(calls).toHaveLength(1);
  const input = calls[0]!.args[0].input;
  return {
    layers: input.Layers ?? [],
    env: input.Environment?.Variables ?? {},
  };
}

describe("removeLumigo", () => {
  it("removes the Lumigo layer, LUMIGO_* env vars, and the Lumigo wrapper", async () => {
    seed([LUMIGO_LAYER, CUSTOM_LIB], {
      LUMIGO_TRACER_TOKEN: "t_abc",
      LUMIGO_ENABLE_LOGS: "true",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
      DB_URL: "postgres://x",
    });

    const [r] = await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });

    expect(r!.applied).toBe(true);
    expect(r!.removedLayers).toEqual([LUMIGO_LAYER]);

    const { layers, env } = sentConfig();
    expect(layers).toEqual([CUSTOM_LIB]); // unrelated layer survives
    expect(env.LUMIGO_TRACER_TOKEN).toBeUndefined();
    expect(env.LUMIGO_ENABLE_LOGS).toBeUndefined();
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
    expect(env.DB_URL).toBe("postgres://x"); // unrelated env survives
  });

  it("keeps LUMIGO_* env vars with --keep-env but still drops layer and wrapper", async () => {
    seed([LUMIGO_LAYER], {
      LUMIGO_TRACER_TOKEN: "t_abc",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
    });

    const [r] = await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      keepEnv: true,
      lambda: newWrapper(),
    });

    expect(r!.applied).toBe(true);
    const { layers, env } = sentConfig();
    expect(layers).toEqual([]);
    expect(env.LUMIGO_TRACER_TOKEN).toBe("t_abc");
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
  });

  it("does NOT clear a Dash0 exec wrapper when untracing Lumigo", async () => {
    // Function was switched to Dash0 but still carries the Lumigo layer.
    seed([LUMIGO_LAYER, DASH0_LAYER], {
      LUMIGO_TRACER_TOKEN: "t_abc",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
      DASH0_ENDPOINT: "https://ingress.example:4318",
    });

    await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });

    const { layers, env } = sentConfig();
    expect(layers).toEqual([DASH0_LAYER]); // Dash0 layer untouched
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper"); // preserved
    expect(env.DASH0_ENDPOINT).toBe("https://ingress.example:4318");
    expect(env.LUMIGO_TRACER_TOKEN).toBeUndefined();
  });

  it("is a true no-op when no Lumigo footprint exists", async () => {
    seed([DASH0_LAYER], { DASH0_ENDPOINT: "https://ingress.example:4318" });

    const [r] = await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });

    expect(r!.applied).toBe(false);
    expect(r!.removedLayers).toEqual([]);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("removes an orphaned Lumigo wrapper even with no Lumigo layer attached", async () => {
    seed([], { AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper" });

    const [r] = await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });

    expect(r!.applied).toBe(true);
    expect(sentConfig().env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
  });

  it("rejects --function and --filter together", async () => {
    await expect(
      removeLumigo({
        function: "orders-create",
        filter: "^orders-",
        region: "us-west-2",
        lambda: newWrapper(),
      }),
    ).rejects.toThrow(/either --function or --filter/);
  });

  it("rejects neither --function nor --filter", async () => {
    await expect(
      removeLumigo({ region: "us-west-2", lambda: newWrapper() }),
    ).rejects.toThrow(/provide --function/);
  });

  it("refuses to apply a --filter run without --yes when non-interactive", async () => {
    seedFleet();
    await expect(
      removeLumigo({
        filter: "^orders-",
        region: "us-west-2",
        lambda: newWrapper(),
      }),
    ).rejects.toThrow(/Refusing to apply without --yes/);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("applies nothing on --dry-run", async () => {
    seed([LUMIGO_LAYER], { LUMIGO_TRACER_TOKEN: "t_abc" });

    const [r] = await removeLumigo({
      function: "orders-create",
      region: "us-west-2",
      dryRun: true,
      lambda: new LambdaWrapper({
        region: "us-west-2",
        dryRun: true,
        client: lambdaMock as unknown as LambdaClient,
      }),
    });

    expect(r!.applied).toBe(false);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});

describe("removeLumigo --filter (bulk)", () => {
  it("only touches functions matching the regex", async () => {
    seedFleet();

    const outcomes = await removeLumigo({
      filter: "^orders-",
      region: "us-west-2",
      yes: true,
      lambda: newWrapper(),
    });

    expect(outcomes.map((o) => o.function).sort()).toEqual([
      "orders-charge",
      "orders-create",
    ]);
    expect(outcomes.every((o) => o.applied)).toBe(true);

    const touched = lambdaMock
      .commandCalls(UpdateFunctionConfigurationCommand)
      .map((call) => call.args[0].input.FunctionName);
    expect(touched.sort()).toEqual(["orders-charge", "orders-create"]);
    expect(touched).not.toContain("payments-refund");
  });

  it("plans without applying on --dry-run", async () => {
    seedFleet();

    const outcomes = await removeLumigo({
      filter: "^orders-",
      region: "us-west-2",
      yes: true,
      dryRun: true,
      lambda: new LambdaWrapper({
        region: "us-west-2",
        dryRun: true,
        client: lambdaMock as unknown as LambdaClient,
      }),
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => !o.applied)).toBe(true);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("reports an empty result when the regex matches nothing", async () => {
    seedFleet();

    const outcomes = await removeLumigo({
      filter: "^nothing-matches-",
      region: "us-west-2",
      yes: true,
      lambda: newWrapper(),
    });

    expect(outcomes).toEqual([]);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("keeps going when one function fails, reporting per-function status", async () => {
    seedFleet();
    lambdaMock
      .on(UpdateFunctionConfigurationCommand, { FunctionName: "orders-charge" })
      .rejects(new Error("ResourceConflictException: update in progress"));

    const outcomes = await removeLumigo({
      filter: "^orders-",
      region: "us-west-2",
      yes: true,
      lambda: newWrapper(),
    });

    const byName = Object.fromEntries(outcomes.map((o) => [o.function, o]));
    expect(byName["orders-create"]!.status).toBe("removed");
    expect(byName["orders-charge"]!.status).toBe("failed");
    expect(byName["orders-charge"]!.message).toMatch(/ResourceConflict/);
  });
});
