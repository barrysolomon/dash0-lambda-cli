/**
 * Tests for `secret show` — read the Secrets Manager value backing a
 * function's DASH0_TOKEN_SECRET_ARN and print it.
 *
 * This is a read-only, credential-printing command, so its two risks are
 * unusual for this CLI:
 *
 *   1. LEAKING. The token must never reach stdout in full unless --reveal was
 *      passed. Several tests assert the *absence* of the raw value rather
 *      than the presence of the redacted one — a redaction bug that also
 *      printed the original would pass the positive assertion.
 *   2. WRITING. It resolves a function's config to find the ARN. It has no
 *      business issuing a single mutating call, so the suite asserts zero.
 *
 * `inspectSecret` itself is covered by secrets.test.ts; this suite covers
 * argument resolution, the DASH0_TOKEN fallback, and every error branch.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { secretShow } from "../src/commands/secret.js";

const lambdaMock = mockClient(LambdaClient);
const smMock = mockClient(SecretsManagerClient);

let logged: string[];

beforeEach(() => {
  lambdaMock.reset();
  smMock.reset();
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
  smMock.reset();
  vi.restoreAllMocks();
});

const REGION = "us-west-2";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb";
const TOKEN = "auth_" + "a".repeat(40);

function seedFn(env: Record<string, string>) {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves({
    FunctionName: "orders-create",
    Runtime: "nodejs20.x",
    PackageType: "Zip",
    Layers: [],
    Environment: { Variables: env },
    Role: "arn:aws:iam::111:role/orders-create",
  });
}

/** A plain-string secret holding `value`. */
function seedSecretString(value: string) {
  smMock.on(DescribeSecretCommand).resolves({ KmsKeyId: "alias/aws/secretsmanager" });
  smMock.on(GetSecretValueCommand).resolves({ SecretString: value });
}

/** A JSON secret. */
function seedSecretJson(obj: Record<string, unknown>) {
  smMock.on(DescribeSecretCommand).resolves({});
  smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify(obj) });
}

function wrapper() {
  return new LambdaWrapper({
    region: REGION,
    dryRun: true,
    client: lambdaMock as unknown as LambdaClient,
  });
}

const out = () => logged.join("\n");

describe("secret show — argument resolution", () => {
  it("requires either --function or --secret-arn", async () => {
    await expect(secretShow({ region: REGION })).rejects.toThrow(
      /either --function or --secret-arn is required/,
    );
    expect(smMock.calls()).toHaveLength(0);
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it("reads an explicit --secret-arn without looking up any function", async () => {
    seedSecretString(TOKEN);

    const r = await secretShow({
      region: REGION,
      secretArn: SECRET_ARN,
      reveal: true,
    });

    expect(r).toEqual({ arn: SECRET_ARN, resolved: true, token: TOKEN });
    expect(
      lambdaMock.commandCalls(GetFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("resolves the ARN from the function's DASH0_TOKEN_SECRET_ARN", async () => {
    seedFn({ DASH0_TOKEN_SECRET_ARN: SECRET_ARN });
    seedSecretString(TOKEN);

    const r = await secretShow({
      region: REGION,
      function: "orders-create",
      reveal: true,
      lambda: wrapper(),
    });

    expect(r.arn).toBe(SECRET_ARN);
    expect(r.token).toBe(TOKEN);
    expect(
      smMock.commandCalls(DescribeSecretCommand)[0]!.args[0].input.SecretId,
    ).toBe(SECRET_ARN);
  });

  it("inherits DASH0_TOKEN_SECRET_KEY from the function", async () => {
    // Without this the JSON secret is read but no key is extracted, and the
    // command reports "no token value" on a perfectly healthy function.
    seedFn({
      DASH0_TOKEN_SECRET_ARN: SECRET_ARN,
      DASH0_TOKEN_SECRET_KEY: "dash0Token",
    });
    seedSecretJson({ dash0Token: TOKEN, other: "noise" });

    const r = await secretShow({
      region: REGION,
      function: "orders-create",
      reveal: true,
      lambda: wrapper(),
    });

    expect(r.resolved).toBe(true);
    expect(r.token).toBe(TOKEN);
  });

  it("lets an explicit --secret-key win over the function's", async () => {
    seedFn({
      DASH0_TOKEN_SECRET_ARN: SECRET_ARN,
      DASH0_TOKEN_SECRET_KEY: "wrongKey",
    });
    seedSecretJson({ wrongKey: "nope", rightKey: TOKEN });

    const r = await secretShow({
      region: REGION,
      function: "orders-create",
      secretKey: "rightKey",
      reveal: true,
      lambda: wrapper(),
    });

    expect(r.token).toBe(TOKEN);
  });

  it("errors when the function has neither a token nor a secret ARN", async () => {
    seedFn({ DB_URL: "postgres://x" });

    await expect(
      secretShow({
        region: REGION,
        function: "orders-create",
        lambda: wrapper(),
      }),
    ).rejects.toThrow(/neither DASH0_TOKEN nor DASH0_TOKEN_SECRET_ARN/);
  });

  it("wraps a function-fetch failure with the function name", async () => {
    lambdaMock
      .on(GetFunctionConfigurationCommand)
      .rejects(new Error("ResourceNotFoundException"));

    await expect(
      secretShow({
        region: REGION,
        function: "orders-create",
        lambda: wrapper(),
      }),
    ).rejects.toThrow(/failed to fetch function orders-create/);
  });
});

describe("secret show — the DASH0_TOKEN fallback", () => {
  it("reports a plaintext-token function without calling Secrets Manager", async () => {
    seedFn({ DASH0_TOKEN: TOKEN });

    const r = await secretShow({
      region: REGION,
      function: "orders-create",
      lambda: wrapper(),
    });

    expect(r).toEqual({ arn: "", resolved: true, token: TOKEN });
    expect(smMock.calls()).toHaveLength(0);
    expect(out()).toMatch(/authenticates with DASH0_TOKEN/);
  });

  it("redacts the plaintext token by default", async () => {
    seedFn({ DASH0_TOKEN: TOKEN });

    await secretShow({
      region: REGION,
      function: "orders-create",
      lambda: wrapper(),
    });

    expect(out()).not.toContain(TOKEN);
    expect(out()).toContain("auth_aaa…aaaa");
  });

  it("prints the plaintext token in full with --reveal", async () => {
    seedFn({ DASH0_TOKEN: TOKEN });

    await secretShow({
      region: REGION,
      function: "orders-create",
      reveal: true,
      lambda: wrapper(),
    });

    expect(out()).toContain(TOKEN);
  });
});

describe("secret show — redaction", () => {
  it("never prints the raw value without --reveal", async () => {
    seedSecretString(TOKEN);

    const r = await secretShow({ region: REGION, secretArn: SECRET_ARN });

    // The value is still RETURNED — callers like `validate` need it — but it
    // must not reach the terminal.
    expect(r.token).toBe(TOKEN);
    expect(out()).not.toContain(TOKEN);
    expect(out()).toMatch(/--reveal to print the full value/);
  });

  it("shows only the first 8 and last 4 characters", async () => {
    seedSecretString("abcdefghIJKLMNOPqrstuvwx");

    await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(out()).toContain("abcdefgh…uvwx");
    expect(out()).not.toContain("IJKLMNOP");
  });

  it("prints nothing but stars for a value short enough to guess from a prefix", async () => {
    seedSecretString("short-token");

    await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(out()).toContain("***");
    expect(out()).not.toContain("short-token");
  });

  it("omits the --reveal hint when --reveal was already passed", async () => {
    seedSecretString(TOKEN);

    await secretShow({ region: REGION, secretArn: SECRET_ARN, reveal: true });

    expect(out()).not.toMatch(/re-run with --reveal/);
  });
});

describe("secret show — diagnostics", () => {
  it("reports the secret's shape and JSON keys without leaking values", async () => {
    seedSecretJson({ dash0Token: TOKEN, region: "us-west-2" });

    await secretShow({
      region: REGION,
      secretArn: SECRET_ARN,
      secretKey: "dash0Token",
    });

    expect(out()).toMatch(/shape:\s+json/);
    expect(out()).toMatch(/json keys:\s+dash0Token, region/);
    expect(out()).not.toContain(TOKEN);
  });

  it("prints the KMS key when the secret uses a customer-managed one", async () => {
    smMock
      .on(DescribeSecretCommand)
      .resolves({ KmsKeyId: "arn:aws:kms:us-west-2:111:key/abc" });
    smMock.on(GetSecretValueCommand).resolves({ SecretString: TOKEN });

    await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(out()).toMatch(/kms key:\s+arn:aws:kms:us-west-2:111:key\/abc/);
  });

  it("reports resolved: false when the secret does not exist", async () => {
    const err = new Error("Secrets Manager can't find the specified secret.");
    err.name = "ResourceNotFoundException";
    smMock.on(DescribeSecretCommand).rejects(err);

    const r = await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(r).toEqual({ arn: SECRET_ARN, resolved: false });
    expect(out()).toMatch(/couldn't resolve token/);
  });

  it("flags AccessDenied as a likely problem for the function's role too", async () => {
    // The operator's creds and the Lambda execution role are different
    // principals, but in practice a denied secret is usually denied for both.
    const err = new Error("User is not authorized to perform: secretsmanager:DescribeSecret");
    err.name = "AccessDeniedException";
    smMock.on(DescribeSecretCommand).rejects(err);

    const r = await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(r.resolved).toBe(false);
    expect(out()).toMatch(/function's role may have the same problem/);
  });

  it("does not mention the role for a non-permission failure", async () => {
    const err = new Error("Secrets Manager can't find the specified secret.");
    err.name = "ResourceNotFoundException";
    smMock.on(DescribeSecretCommand).rejects(err);

    await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(out()).not.toMatch(/function's role may have the same problem/);
  });

  it("reports resolved: false when the secret is JSON but the key is missing", async () => {
    seedSecretJson({ someOtherKey: TOKEN });

    const r = await secretShow({
      region: REGION,
      secretArn: SECRET_ARN,
      secretKey: "dash0Token",
    });

    expect(r.resolved).toBe(false);
    expect(out()).toMatch(/no string field "dash0Token"/);
  });

  it("reports resolved: false for an empty secret value", async () => {
    smMock.on(DescribeSecretCommand).resolves({});
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "" });

    const r = await secretShow({ region: REGION, secretArn: SECRET_ARN });

    expect(r).toEqual({ arn: SECRET_ARN, resolved: false });
    expect(out()).toMatch(/no token value extracted/);
  });
});

describe("secret show — is strictly read-only", () => {
  it("never issues a mutating Lambda call", async () => {
    seedFn({ DASH0_TOKEN_SECRET_ARN: SECRET_ARN });
    seedSecretString(TOKEN);

    await secretShow({
      region: REGION,
      function: "orders-create",
      lambda: wrapper(),
      reveal: true,
    });

    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});
