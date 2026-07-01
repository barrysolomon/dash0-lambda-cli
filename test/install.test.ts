/**
 * Integration tests for `install` using aws-sdk-client-mock to fake the
 * Lambda API calls. We assert on the params sent to UpdateFunctionConfiguration.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListLayerVersionsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  DescribeSecretCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { install } from "../src/commands/install.js";

const lambdaMock = mockClient(LambdaClient);
const iamMock = mockClient(IAMClient);
const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  lambdaMock.reset();
  iamMock.reset();
  smMock.reset();
});
afterEach(() => {
  lambdaMock.reset();
  iamMock.reset();
  smMock.reset();
});

const VALID_TOKEN = "auth_" + "a".repeat(40);
const ENDPOINT = "https://ingress.us-west-2.aws.dash0.com:4318";
const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb";

describe("install", () => {
  it("attaches the layer at the CLI's known version and sets DASH0_* env vars on a clean Node function", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: { DB_URL: "postgres://x" } },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      lambda: wrapper,
    });

    expect(r.applied).toBe(true);
    // KNOWN_LATEST_LAYER_VERSION.node is 9 — pinned in src/lib/layers.ts.
    expect(r.layerArn).toBe(
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:11",
    );
    expect(r.envAfter.DB_URL).toBe("postgres://x"); // preserved
    expect(r.envAfter.DASH0_ENDPOINT).toBe(ENDPOINT);
    expect(r.envAfter.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper");
    expect(r.envAfter.OTEL_SERVICE_NAME).toBeUndefined();

    // Default install should NOT call ListLayerVersions — that requires a
    // cross-account permission the canonical Dash0 layer doesn't grant.
    expect(
      lambdaMock.commandCalls(ListLayerVersionsCommand),
    ).toHaveLength(0);

    const calls = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand);
    expect(calls).toHaveLength(1);
    const sentLayers = calls[0]!.args[0].input.Layers ?? [];
    expect(sentLayers[0]).toContain("dash0-extension-node:11");
  });

  it("honors an explicit layerVersion override (pinning to an older release)", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      layerVersion: 7,
      lambda: wrapper,
    });

    expect(r.applied).toBe(true);
    expect(r.layerArn).toBe(
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:7",
    );
  });

  it("preserves non-Dash0 layers and pre-existing env", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "python3.12",
      Architectures: ["arm64"],
      Layers: [
        { Arn: "arn:aws:lambda:us-west-2:111:layer:custom-libs:3" },
      ],
      Environment: { Variables: { FEATURE_X: "on" } },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn:
        "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb",
      // Pin a specific version so the test isn't coupled to KNOWN_LATEST.
      layerVersion: 4,
      lambda: wrapper,
    });

    const call = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0]!;
    const layers = call.args[0].input.Layers ?? [];
    expect(layers).toHaveLength(2);
    expect(layers[0]).toContain("dash0-extension-python:4");
    expect(layers[1]).toContain("custom-libs:3");
    const envSent = call.args[0].input.Environment?.Variables ?? {};
    expect(envSent.FEATURE_X).toBe("on");
    expect(envSent.DASH0_TOKEN_SECRET_ARN).toContain("secret:dash0-token-AaBb");
  });

  it("dry-run does not call UpdateFunctionConfiguration", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "fn",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/fn",
    });

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      dryRun: true,
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "fn",
      region: "us-west-2",
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      lambda: wrapper,
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);
  });

  it("authMode=token clears DASH0_TOKEN_SECRET_ARN that pre-existed on the function", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "fn",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: {
        Variables: {
          DASH0_TOKEN_SECRET_ARN:
            "arn:aws:secretsmanager:us-west-2:111:secret:old-AaBb",
          DASH0_TOKEN_SECRET_KEY: "dash0_token",
        },
      },
      Role: "arn:aws:iam::111:role/fn",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    await install({
      function: "fn",
      region: "us-west-2",
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      authMode: "token",
      lambda: wrapper,
    });
    const sent =
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0]!.args[0]
        .input.Environment?.Variables ?? {};
    expect(sent.DASH0_TOKEN).toBe(VALID_TOKEN);
    expect(sent.DASH0_TOKEN_SECRET_ARN).toBeUndefined();
    expect(sent.DASH0_TOKEN_SECRET_KEY).toBeUndefined();
  });

  it("authMode=secret clears a pre-existing DASH0_TOKEN", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "fn",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: { DASH0_TOKEN: "auth_legacy_value" } },
      Role: "arn:aws:iam::111:role/fn",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    await install({
      function: "fn",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn:
        "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb",
      authMode: "secret",
      lambda: wrapper,
    });
    const sent =
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0]!.args[0]
        .input.Environment?.Variables ?? {};
    expect(sent.DASH0_TOKEN).toBeUndefined();
    expect(sent.DASH0_TOKEN_SECRET_ARN).toContain("secret:dash0-token-AaBb");
  });

  it("auto-grants the function role read access when installing with secret auth", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    // Default AWS-managed key → no CMK, so no kms:Decrypt statement expected.
    smMock.on(DescribeSecretCommand).resolves({
      ARN: SECRET_ARN,
      KmsKeyId: "alias/aws/secretsmanager",
    });
    iamMock.on(PutRolePolicyCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      authMode: "secret",
      lambda: wrapper,
    });

    expect(r.applied).toBe(true);
    expect(r.secretGrant?.granted).toBe(true);

    const calls = iamMock.commandCalls(PutRolePolicyCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.RoleName).toBe("orders-create");
    const doc = JSON.parse(calls[0]!.args[0].input.PolicyDocument as string);
    expect(JSON.stringify(doc)).toContain("secretsmanager:GetSecretValue");
    expect(JSON.stringify(doc)).toContain(SECRET_ARN);
    expect(JSON.stringify(doc)).not.toContain("kms:Decrypt");
  });

  it("adds kms:Decrypt when the secret uses a customer-managed key", async () => {
    const KEY = "arn:aws:kms:us-west-2:111:key/abcd-1234";
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    smMock.on(DescribeSecretCommand).resolves({ ARN: SECRET_ARN, KmsKeyId: KEY });
    iamMock.on(PutRolePolicyCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      authMode: "secret",
      lambda: wrapper,
    });

    expect(r.secretGrant?.actions.sort()).toEqual([
      "kms:Decrypt",
      "secretsmanager:GetSecretValue",
    ]);
    const doc = JSON.parse(
      iamMock.commandCalls(PutRolePolicyCommand)[0]!.args[0].input
        .PolicyDocument as string,
    );
    expect(JSON.stringify(doc)).toContain(KEY);
  });

  it("does not touch IAM when --no-grant-secret-access is set", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      authMode: "secret",
      grantSecretAccess: false,
      lambda: wrapper,
    });

    expect(r.applied).toBe(true);
    expect(r.secretGrant).toBeUndefined();
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it("does not grant secret access for plain token auth", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      token: VALID_TOKEN,
      lambda: wrapper,
    });

    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it("still reports the install as applied when the IAM grant is denied", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    smMock.on(DescribeSecretCommand).resolves({ ARN: SECRET_ARN });
    const denied = new Error("not authorized to perform iam:PutRolePolicy");
    (denied as any).name = "AccessDeniedException";
    iamMock.on(PutRolePolicyCommand).rejects(denied);

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      authMode: "secret",
      lambda: wrapper,
    });

    expect(r.applied).toBe(true);
    expect(r.secretGrant?.granted).toBe(false);
    expect(r.secretGrant?.errorCode).toBe("AccessDenied");
  });

  it("does not call PutRolePolicy under dry-run (but plans it)", async () => {
    lambdaMock.on(GetFunctionConfigurationCommand).resolves({
      FunctionName: "orders-create",
      Runtime: "nodejs20.x",
      Architectures: ["x86_64"],
      Layers: [],
      Environment: { Variables: {} },
      Role: "arn:aws:iam::111:role/orders-create",
    });
    smMock.on(DescribeSecretCommand).resolves({ ARN: SECRET_ARN });

    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      dryRun: true,
      client: lambdaMock as unknown as LambdaClient,
    });
    const r = await install({
      function: "orders-create",
      region: "us-west-2",
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      authMode: "secret",
      lambda: wrapper,
      dryRun: true,
    });

    expect(r.applied).toBe(false);
    expect(r.secretGrant?.skipped).toBe("dry-run");
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it("rejects bad config before any AWS calls", async () => {
    const wrapper = new LambdaWrapper({
      region: "us-west-2",
      client: lambdaMock as unknown as LambdaClient,
    });
    await expect(
      install({
        function: "fn",
        region: "us-west-2",
        endpoint: "not-a-url",
        token: "weak",
        lambda: wrapper,
      }),
    ).rejects.toThrow();
    expect(lambdaMock.commandCalls(GetFunctionConfigurationCommand)).toHaveLength(0);
  });
});
