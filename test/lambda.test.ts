/**
 * Tests for `LambdaWrapper` — the single chokepoint every AWS write in this
 * CLI passes through.
 *
 * Two properties make this file worth more than its line count:
 *
 *   1. `dryRun` is honored in exactly one place — here. Every command's
 *      --dry-run flag is really "construct the wrapper with dryRun: true".
 *      The command suites test their own callers; nothing else tests the
 *      gate itself. If it regressed, all eight commands would start writing
 *      to AWS during a dry run at once.
 *
 *   2. `updateFunctionConfig` and `updateEnvOnly` differ by ONE field, and
 *      the difference is destructive. `UpdateFunctionConfiguration` treats an
 *      omitted `Layers` as "leave alone" but `Layers: []` as "detach every
 *      layer". `updateEnvOnly` must omit it — sending an empty array would
 *      uninstall the extension from any function whose env someone edited in
 *      the TUI.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListFunctionsCommand,
  ListLayerVersionsCommand,
  ListTagsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";

const lambdaMock = mockClient(LambdaClient);

beforeEach(() => lambdaMock.reset());
afterEach(() => lambdaMock.reset());

const REGION = "us-west-2";

function wrapper(dryRun = false) {
  return new LambdaWrapper({
    region: REGION,
    dryRun,
    client: lambdaMock as unknown as LambdaClient,
  });
}

function updateInputs() {
  return lambdaMock
    .commandCalls(UpdateFunctionConfigurationCommand)
    .map((call) => call.args[0].input);
}

describe("LambdaWrapper — construction", () => {
  it("defaults dryRun to false", () => {
    expect(
      new LambdaWrapper({
        region: REGION,
        client: lambdaMock as unknown as LambdaClient,
      }).dryRun,
    ).toBe(false);
  });

  it("exposes the region it was built for", () => {
    expect(wrapper().region).toBe(REGION);
  });
});

describe("LambdaWrapper — the dryRun gate", () => {
  const args = {
    name: "orders-create",
    layerArns: ["arn:aws:lambda:us-west-2:111:layer:x:1"],
    env: { A: "1" },
  };

  it("updateFunctionConfig sends nothing to AWS in dry-run mode", async () => {
    const result = await wrapper(true).updateFunctionConfig(args);

    expect(result).toEqual({ applied: false, reason: "dry-run" });
    // Not "sent and ignored" — never sent at all.
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it("updateEnvOnly sends nothing to AWS in dry-run mode", async () => {
    const result = await wrapper(true).updateEnvOnly({
      name: "orders-create",
      env: { A: "1" },
    });

    expect(result).toEqual({ applied: false, reason: "dry-run" });
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it("does write when dryRun is off", async () => {
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    expect(await wrapper(false).updateFunctionConfig(args)).toEqual({
      applied: true,
    });
    expect(updateInputs()).toHaveLength(1);
  });

  it("does not swallow an AWS failure as a successful apply", async () => {
    lambdaMock
      .on(UpdateFunctionConfigurationCommand)
      .rejects(new Error("ResourceConflictException"));

    await expect(wrapper().updateFunctionConfig(args)).rejects.toThrow(
      /ResourceConflictException/,
    );
  });
});

describe("LambdaWrapper — updateFunctionConfig payload", () => {
  beforeEach(() => lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({}));

  it("sends layers and env together in one call", async () => {
    await wrapper().updateFunctionConfig({
      name: "orders-create",
      layerArns: ["arn:a:1", "arn:b:2"],
      env: { DASH0_ENDPOINT: "https://x:4318" },
    });

    const [input] = updateInputs();
    expect(input!.FunctionName).toBe("orders-create");
    expect(input!.Layers).toEqual(["arn:a:1", "arn:b:2"]);
    expect(input!.Environment).toEqual({
      Variables: { DASH0_ENDPOINT: "https://x:4318" },
    });
  });

  it("forwards revisionId so AWS can reject a stale write", async () => {
    await wrapper().updateFunctionConfig({
      name: "orders-create",
      layerArns: [],
      env: {},
      revisionId: "rev-abc",
    });

    expect(updateInputs()[0]!.RevisionId).toBe("rev-abc");
  });

  it("omits RevisionId entirely when not supplied", async () => {
    await wrapper().updateFunctionConfig({
      name: "orders-create",
      layerArns: [],
      env: {},
    });

    expect(updateInputs()[0]!.RevisionId).toBeUndefined();
  });

  it("passes an empty layer list through — that is how uninstall detaches", async () => {
    await wrapper().updateFunctionConfig({
      name: "orders-create",
      layerArns: [],
      env: { A: "1" },
    });

    expect(updateInputs()[0]!.Layers).toEqual([]);
  });
});

describe("LambdaWrapper — updateEnvOnly must not touch layers", () => {
  beforeEach(() => lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({}));

  it("omits Layers so AWS leaves the attached layers alone", async () => {
    // `Layers: []` would detach every layer, uninstalling the extension.
    // Omitting the field is the only correct encoding of "don't care".
    await wrapper().updateEnvOnly({
      name: "orders-create",
      env: { A: "1" },
    });

    const [input] = updateInputs();
    expect(input!.Layers).toBeUndefined();
    expect("Layers" in input!).toBe(false);
    expect(input!.Environment).toEqual({ Variables: { A: "1" } });
  });

  it("forwards revisionId", async () => {
    await wrapper().updateEnvOnly({
      name: "orders-create",
      env: {},
      revisionId: "rev-xyz",
    });

    expect(updateInputs()[0]!.RevisionId).toBe("rev-xyz");
  });
});

describe("LambdaWrapper — getFunction snapshot mapping", () => {
  it("maps a fully populated configuration", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      FunctionArn: "arn:aws:lambda:us-west-2:111:function:orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["arm64"],
      PackageType: "Zip",
      Layers: [{ Arn: "arn:a:1" }],
      Environment: { Variables: { A: "1" } },
      Role: "arn:aws:iam::111:role/r",
      LastModified: "2026-01-01T00:00:00.000+0000",
      RevisionId: "rev-1",
    });

    const snap = await wrapper().getFunction("orders-create");

    expect(snap.functionName).toBe("orders-create");
    expect(snap.runtime).toBe("nodejs20.x");
    expect(snap.architectures).toEqual(["arm64"]);
    expect(snap.layers).toEqual([{ Arn: "arn:a:1" }]);
    expect(snap.env).toEqual({ A: "1" });
    expect(snap.role).toBe("arn:aws:iam::111:role/r");
    expect(snap.revisionId).toBe("rev-1");
    expect(snap.packageType).toBe("Zip");
    // Tags are NOT fetched here — ListTags is a separate call.
    expect(snap.tags).toBeUndefined();
  });

  it("survives a configuration with every optional field absent", async () => {
    // Old zip-deployed functions omit PackageType; a function with no layers,
    // no env and no tags returns those fields absent rather than empty.
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "bare",
    });

    const snap = await wrapper().getFunction("bare");

    expect(snap.runtime).toBe("unknown");
    expect(snap.architectures).toEqual(["x86_64"]);
    expect(snap.layers).toEqual([]);
    expect(snap.env).toEqual({});
    expect(snap.role).toBe("");
    expect(snap.functionArn).toBe("");
    expect(snap.revisionId).toBeUndefined();
  });

  it("defaults an absent PackageType to Zip, not Image", async () => {
    // Getting this backwards would make every legacy function look like a
    // container image, and layer operations are no-ops on those.
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .resolves({ FunctionName: "legacy" });

    expect((await wrapper().getFunction("legacy")).packageType).toBe("Zip");
  });

  it("reports a container-image function as Image", async () => {
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .resolves({ FunctionName: "img", PackageType: "Image" });

    expect((await wrapper().getFunction("img")).packageType).toBe("Image");
  });

  it("keeps the raw configuration for callers that need more", async () => {
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .resolves({ FunctionName: "orders-create", MemorySize: 512 });

    const snap = await wrapper().getFunction("orders-create");
    expect(snap.raw.MemorySize).toBe(512);
  });
});

describe("LambdaWrapper — listFunctions pagination", () => {
  it("follows NextMarker across pages and yields every function once", async () => {
    lambdaMock
      .on(ListFunctionsCommand, { Marker: undefined })
      .resolves({ Functions: [{ FunctionName: "a" }], NextMarker: "m1" })
      .on(ListFunctionsCommand, { Marker: "m1" })
      .resolves({ Functions: [{ FunctionName: "b" }], NextMarker: "m2" })
      .on(ListFunctionsCommand, { Marker: "m2" })
      .resolves({ Functions: [{ FunctionName: "c" }] });

    const names: string[] = [];
    for await (const fn of wrapper().listFunctions()) names.push(fn.functionName);

    expect(names).toEqual(["a", "b", "c"]);
    expect(lambdaMock.commandCalls(ListFunctionsCommand)).toHaveLength(3);
  });

  it("stops after one page when NextMarker is absent", async () => {
    lambdaMock
      .on(ListFunctionsCommand)
      .resolves({ Functions: [{ FunctionName: "only" }] });

    const names: string[] = [];
    for await (const fn of wrapper().listFunctions()) names.push(fn.functionName);

    expect(names).toEqual(["only"]);
    expect(lambdaMock.commandCalls(ListFunctionsCommand)).toHaveLength(1);
  });

  it("yields nothing for an empty account without hanging", async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({});

    const names: string[] = [];
    for await (const fn of wrapper().listFunctions()) names.push(fn.functionName);

    expect(names).toEqual([]);
  });

  it("tolerates an empty page that still carries a NextMarker", async () => {
    // AWS may return a page with zero functions and a marker when a filter
    // excludes everything on that page. Bailing early would truncate the list.
    lambdaMock
      .on(ListFunctionsCommand, { Marker: undefined })
      .resolves({ Functions: [], NextMarker: "m1" })
      .on(ListFunctionsCommand, { Marker: "m1" })
      .resolves({ Functions: [{ FunctionName: "late" }] });

    const names: string[] = [];
    for await (const fn of wrapper().listFunctions()) names.push(fn.functionName);

    expect(names).toEqual(["late"]);
  });
});

describe("LambdaWrapper — latestLayerVersion", () => {
  it("scopes the query by region and owner account", async () => {
    lambdaMock
      .on(ListLayerVersionsCommand)
      .resolves({ LayerVersions: [{ Version: 20 }] });

    const v = await wrapper().latestLayerVersion(
      "dash0-extension-node",
      "115813213817",
    );

    expect(v).toBe(20);
    const input = lambdaMock.commandCalls(ListLayerVersionsCommand)[0]!.args[0]
      .input;
    // A bare layer name resolves against the CALLER's account and would
    // silently find nothing (or the wrong layer).
    expect(input.LayerName).toBe(
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node",
    );
    expect(input.MaxItems).toBe(1);
  });

  it("explains the two likely causes when no versions come back", async () => {
    lambdaMock.on(ListLayerVersionsCommand).resolves({ LayerVersions: [] });

    await expect(
      wrapper().latestLayerVersion("dash0-extension-node", "115813213817"),
    ).rejects.toThrow(/layer name is wrong|GetLayerVersion permission/);
  });

  it("throws rather than returning 0 when the response omits Version", async () => {
    lambdaMock.on(ListLayerVersionsCommand).resolves({ LayerVersions: [{}] });

    await expect(
      wrapper().latestLayerVersion("dash0-extension-node", "115813213817"),
    ).rejects.toThrow(/No published versions/);
  });
});

describe("LambdaWrapper — passthroughs", () => {
  it("listTags returns an empty map rather than undefined", async () => {
    lambdaMock.on(ListTagsCommand).resolves({});

    expect(await wrapper().listTags("arn:fn")).toEqual({});
  });

  it("listTags returns the tags keyed by the function ARN", async () => {
    lambdaMock.on(ListTagsCommand).resolves({ Tags: { team: "payments" } });

    expect(await wrapper().listTags("arn:fn")).toEqual({ team: "payments" });
    expect(
      lambdaMock.commandCalls(ListTagsCommand)[0]!.args[0].input.Resource,
    ).toBe("arn:fn");
  });

  it("getFunctionFull returns the raw GetFunction response", async () => {
    lambdaMock
      .on(GetFunctionCommand)
      .resolves({ Code: { RepositoryType: "S3" } });

    const out = await wrapper().getFunctionFull("orders-create");
    expect(out.Code?.RepositoryType).toBe("S3");
  });
});
