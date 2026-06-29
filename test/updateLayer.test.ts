/**
 * updateLayer integration tests via aws-sdk-client-mock.
 *
 * Verify:
 *  - replaces the Dash0 ARN in-place when a newer version is requested
 *  - is a no-op when already on target
 *  - blocks (throws) when no Dash0 layer is attached
 *  - preserves non-Dash0 layers and env vars
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { updateLayer } from "../src/commands/updateLayer.js";
import { CliError } from "../src/lib/errors.js";

const lambdaMock = mockClient(LambdaClient);
beforeEach(() => lambdaMock.reset());
afterEach(() => lambdaMock.reset());

const DASH0_OLD =
  "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:3";
const DASH0_CURRENT =
  "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:11";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";

function newWrapper() {
  return new LambdaWrapper({
    region: "us-west-2",
    client: lambdaMock as unknown as LambdaClient,
  });
}

describe("updateLayer", () => {
  it("replaces the old Dash0 ARN with the current one, in place", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [{ Arn: CUSTOM_LIB }, { Arn: DASH0_OLD }],
      Environment: { Variables: { DB_URL: "postgres://x" } },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const r = await updateLayer({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });

    expect(r.applied).toBe(true);
    expect(r.before).toBe(DASH0_OLD);
    expect(r.after).toBe(DASH0_CURRENT);

    const call = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0]!;
    const sentLayers = call.args[0].input.Layers ?? [];
    // Order preserved: custom lib still first, Dash0 still second.
    expect(sentLayers[0]).toBe(CUSTOM_LIB);
    expect(sentLayers[1]).toBe(DASH0_CURRENT);
    // Env preserved verbatim.
    expect(call.args[0].input.Environment?.Variables).toEqual({
      DB_URL: "postgres://x",
    });
  });

  it("is a no-op when already on target version", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [{ Arn: DASH0_CURRENT }],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });

    const r = await updateLayer({
      function: "orders-create",
      region: "us-west-2",
      lambda: newWrapper(),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/already on target/);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("blocks when no Dash0 layer is attached", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [{ Arn: CUSTOM_LIB }],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });

    await expect(
      updateLayer({
        function: "orders-create",
        region: "us-west-2",
        lambda: newWrapper(),
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("respects --layer-version pin (allows downgrade)", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [{ Arn: DASH0_CURRENT }],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const r = await updateLayer({
      function: "orders-create",
      region: "us-west-2",
      layerVersion: 4,
      lambda: newWrapper(),
    });
    expect(r.applied).toBe(true);
    const call = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0]!;
    expect(call.args[0].input.Layers?.[0]).toContain("dash0-extension-node:4");
  });

  it("dry-run does not call UpdateFunctionConfiguration", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [{ Arn: DASH0_OLD }],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      dryRun: true,
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await updateLayer({
      function: "orders-create",
      region: "us-west-2",
      dryRun: true,
      lambda: wrapper,
    });
    expect(r.applied).toBe(false);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});
