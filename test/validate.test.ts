/**
 * Tests for `validate`'s opt-in IAM auto-remediation. When the doctor
 * detects that the function's role can't read its token secret, passing
 * fixSecretAccess:true (the --fix-secret-access flag) should attach the
 * secret-read policy — but only then. A plain validate run must never
 * write IAM.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  IAMClient,
  PutRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { validate } from "../src/commands/validate.js";

const lambdaMock = mockClient(LambdaClient);
const smMock = mockClient(SecretsManagerClient);
const iamMock = mockClient(IAMClient);

beforeEach(() => {
  lambdaMock.reset();
  smMock.reset();
  iamMock.reset();
});
afterEach(() => {
  lambdaMock.reset();
  smMock.reset();
  iamMock.reset();
});

const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb";
const ROLE = "arn:aws:iam::111:role/orders-create";
const VALID_TOKEN = "auth_" + "a".repeat(40);

/** A function wired to secret auth whose role is denied read access. */
function primeDeniedRole() {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves({
    FunctionName: "orders-create",
    Runtime: "nodejs20.x",
    Architectures: ["x86_64"],
    Layers: [],
    Environment: {
      Variables: {
        DASH0_ENDPOINT: "https://ingress.us-west-2.aws.dash0.com:4318",
        DASH0_TOKEN_SECRET_ARN: SECRET_ARN,
      },
    },
    Role: ROLE,
  });
  smMock.on(DescribeSecretCommand).resolves({ ARN: SECRET_ARN });
  smMock.on(GetSecretValueCommand).resolves({ SecretString: VALID_TOKEN });
  iamMock.on(SimulatePrincipalPolicyCommand).resolves({
    EvaluationResults: [
      {
        EvalActionName: "secretsmanager:GetSecretValue",
        EvalDecision: "implicitDeny",
      },
    ],
  });
}

function wrapper() {
  return new LambdaWrapper({
    region: "us-west-2",
    dryRun: true,
    client: lambdaMock as unknown as LambdaClient,
  });
}

describe("validate --fix-secret-access", () => {
  it("does not write IAM when remediation isn't requested", async () => {
    primeDeniedRole();
    const r = await validate({
      function: "orders-create",
      region: "us-west-2",
      lambda: wrapper(),
    });
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
    const iam = r.checks.find((c) => c.name === "secret-iam");
    expect(iam?.level).toBe("fail");
  });

  it("attaches the secret-read policy and reports ok when fixSecretAccess is set", async () => {
    primeDeniedRole();
    iamMock.on(PutRolePolicyCommand).resolves({});
    const r = await validate({
      function: "orders-create",
      region: "us-west-2",
      fixSecretAccess: true,
      lambda: wrapper(),
    });

    const calls = iamMock.commandCalls(PutRolePolicyCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.RoleName).toBe("orders-create");
    const iam = r.checks.find((c) => c.name === "secret-iam");
    expect(iam?.level).toBe("ok");
    expect(iam?.message).toMatch(/grant/i);
  });

  it("reports a failure when remediation is denied (CLI lacks iam:PutRolePolicy)", async () => {
    primeDeniedRole();
    const denied = new Error("not authorized to perform iam:PutRolePolicy");
    (denied as any).name = "AccessDeniedException";
    iamMock.on(PutRolePolicyCommand).rejects(denied);

    const r = await validate({
      function: "orders-create",
      region: "us-west-2",
      fixSecretAccess: true,
      lambda: wrapper(),
    });

    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(1);
    const iam = r.checks.find((c) => c.name === "secret-iam");
    expect(iam?.level).toBe("fail");
    expect(iam?.message).toMatch(/PutRolePolicy|remediat/i);
  });
});
