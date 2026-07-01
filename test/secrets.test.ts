/**
 * Tests for inspectSecret and simulateLambdaSecretAccess. These cover
 * the failure modes the doctor (validate.ts) reports back to operators
 * — especially the case where the function's Lambda role can't read
 * DASH0_TOKEN_SECRET_ARN, which is what we're guarding against.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  IAMClient,
  PutRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  grantSecretAccessToRole,
  inspectSecret,
  isCustomerManagedSecretsKey,
  roleNameFromArn,
  SECRET_READ_POLICY_NAME,
  simulateLambdaSecretAccess,
} from "../src/lib/secrets.js";

const sm = mockClient(SecretsManagerClient);
const iam = mockClient(IAMClient);

beforeEach(() => {
  sm.reset();
  iam.reset();
});
afterEach(() => {
  sm.reset();
  iam.reset();
});

const ARN = "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb";
const ROLE = "arn:aws:iam::111:role/orders-create";
const VALID_TOKEN = "auth_" + "a".repeat(40);

describe("inspectSecret", () => {
  it("returns NotFound when the secret doesn't exist", async () => {
    sm.on(DescribeSecretCommand).rejects(
      new ResourceNotFoundException({
        message: "no such secret",
        $metadata: {},
      }),
    );
    const r = await inspectSecret({
      region: "us-west-2",
      arn: ARN,
      client: sm as unknown as SecretsManagerClient,
    });
    expect(r.exists).toBe(false);
    expect(r.errorCode).toBe("NotFound");
  });

  it("classifies AccessDeniedException distinctly", async () => {
    const err = new Error("denied");
    (err as any).name = "AccessDeniedException";
    sm.on(DescribeSecretCommand).rejects(err);
    const r = await inspectSecret({
      region: "us-west-2",
      arn: ARN,
      client: sm as unknown as SecretsManagerClient,
    });
    expect(r.exists).toBe(false);
    expect(r.errorCode).toBe("AccessDenied");
  });

  it("extracts a plain-string token", async () => {
    sm.on(DescribeSecretCommand).resolves({ ARN, KmsKeyId: "alias/aws/secretsmanager" });
    sm.on(GetSecretValueCommand).resolves({ SecretString: VALID_TOKEN });
    const r = await inspectSecret({
      region: "us-west-2",
      arn: ARN,
      client: sm as unknown as SecretsManagerClient,
    });
    expect(r.exists).toBe(true);
    expect(r.isJson).toBe(false);
    expect(r.tokenValue).toBe(VALID_TOKEN);
  });

  it("extracts a JSON-keyed token when key is provided", async () => {
    sm.on(DescribeSecretCommand).resolves({ ARN });
    sm.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ dash0_token: VALID_TOKEN, other: "x" }),
    });
    const r = await inspectSecret({
      region: "us-west-2",
      arn: ARN,
      key: "dash0_token",
      client: sm as unknown as SecretsManagerClient,
    });
    expect(r.exists).toBe(true);
    expect(r.isJson).toBe(true);
    expect(r.jsonKeys).toEqual(["dash0_token", "other"]);
    expect(r.tokenValue).toBe(VALID_TOKEN);
  });

  it("flags JSON secret with no key set (extension would mis-parse it)", async () => {
    sm.on(DescribeSecretCommand).resolves({ ARN });
    sm.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ dash0_token: VALID_TOKEN }),
    });
    const r = await inspectSecret({
      region: "us-west-2",
      arn: ARN,
      client: sm as unknown as SecretsManagerClient,
    });
    expect(r.errorCode).toBe("Unknown");
    expect(r.errorMessage).toMatch(/JSON/);
    expect(r.tokenValue).toBeUndefined();
  });
});

describe("simulateLambdaSecretAccess", () => {
  it("returns allowed=true when every action is allowed", async () => {
    iam.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: [
        {
          EvalActionName: "secretsmanager:GetSecretValue",
          EvalDecision: "allowed",
        },
      ],
    });
    const r = await simulateLambdaSecretAccess({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });
    expect(r.allowed).toBe(true);
    expect(r.inconclusive).toBe(false);
  });

  it("returns allowed=false with action breakdown when denied", async () => {
    iam.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: [
        {
          EvalActionName: "secretsmanager:GetSecretValue",
          EvalDecision: "implicitDeny",
        },
      ],
    });
    const r = await simulateLambdaSecretAccess({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });
    expect(r.allowed).toBe(false);
    expect(r.decisions[0]?.decision).toBe("implicitDeny");
  });

  it("returns inconclusive when caller can't run the simulation", async () => {
    const err = new Error("not authorized to perform iam:SimulatePrincipalPolicy");
    (err as any).name = "AccessDeniedException";
    iam.on(SimulatePrincipalPolicyCommand).rejects(err);
    const r = await simulateLambdaSecretAccess({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });
    expect(r.inconclusive).toBe(true);
    expect(r.allowed).toBe(false);
  });

  it("includes kms:Decrypt when a CMK is supplied", async () => {
    iam.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: [
        { EvalActionName: "secretsmanager:GetSecretValue", EvalDecision: "allowed" },
        { EvalActionName: "kms:Decrypt", EvalDecision: "allowed" },
      ],
    });
    const r = await simulateLambdaSecretAccess({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      kmsKeyArn: "arn:aws:kms:us-west-2:111:key/abcd",
      client: iam as unknown as IAMClient,
    });
    expect(r.allowed).toBe(true);
    expect(r.decisions.map((d) => d.action).sort()).toEqual([
      "kms:Decrypt",
      "secretsmanager:GetSecretValue",
    ]);
  });
});

describe("roleNameFromArn", () => {
  it("extracts the role name from a plain role ARN", () => {
    expect(roleNameFromArn("arn:aws:iam::111:role/orders-create")).toBe(
      "orders-create",
    );
  });

  it("returns the final segment for a role with a path", () => {
    expect(
      roleNameFromArn("arn:aws:iam::111:role/service-role/orders-create"),
    ).toBe("orders-create");
  });

  it("returns empty string for a non-role ARN", () => {
    expect(roleNameFromArn("arn:aws:lambda:us-west-2:111:function:foo")).toBe(
      "",
    );
  });
});

describe("isCustomerManagedSecretsKey", () => {
  it("is false for the default AWS-managed key (absent, alias, or aliased ARN)", () => {
    expect(isCustomerManagedSecretsKey(undefined)).toBe(false);
    expect(isCustomerManagedSecretsKey("")).toBe(false);
    expect(isCustomerManagedSecretsKey("alias/aws/secretsmanager")).toBe(false);
    expect(
      isCustomerManagedSecretsKey(
        "arn:aws:kms:us-west-2:111:alias/aws/secretsmanager",
      ),
    ).toBe(false);
  });

  it("is true for a customer-managed key ARN or id", () => {
    expect(
      isCustomerManagedSecretsKey("arn:aws:kms:us-west-2:111:key/abcd-1234"),
    ).toBe(true);
    expect(isCustomerManagedSecretsKey("abcd-1234")).toBe(true);
  });
});

describe("grantSecretAccessToRole", () => {
  it("attaches an inline policy granting GetSecretValue scoped to the secret ARN", async () => {
    iam.on(PutRolePolicyCommand).resolves({});
    const r = await grantSecretAccessToRole({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });

    expect(r.granted).toBe(true);
    expect(r.roleName).toBe("orders-create");
    expect(r.policyName).toBe(SECRET_READ_POLICY_NAME);
    expect(r.actions).toEqual(["secretsmanager:GetSecretValue"]);

    const call = iam.commandCalls(PutRolePolicyCommand)[0]!;
    expect(call.args[0].input.RoleName).toBe("orders-create");
    expect(call.args[0].input.PolicyName).toBe(SECRET_READ_POLICY_NAME);
    const doc = JSON.parse(call.args[0].input.PolicyDocument as string);
    expect(doc.Statement[0].Action).toContain("secretsmanager:GetSecretValue");
    expect(doc.Statement[0].Resource).toBe(ARN);
    // No CMK supplied → no kms:Decrypt statement.
    expect(JSON.stringify(doc)).not.toContain("kms:Decrypt");
  });

  it("adds a kms:Decrypt statement scoped to a customer-managed key ARN", async () => {
    iam.on(PutRolePolicyCommand).resolves({});
    const KEY = "arn:aws:kms:us-west-2:111:key/abcd-1234";
    const r = await grantSecretAccessToRole({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      kmsKeyArn: KEY,
      client: iam as unknown as IAMClient,
    });

    expect(r.granted).toBe(true);
    expect(r.actions.sort()).toEqual([
      "kms:Decrypt",
      "secretsmanager:GetSecretValue",
    ]);
    const doc = JSON.parse(
      iam.commandCalls(PutRolePolicyCommand)[0]!.args[0].input
        .PolicyDocument as string,
    );
    const kmsStmt = doc.Statement.find((s: any) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("kms:Decrypt"),
    );
    expect(kmsStmt).toBeDefined();
    expect(kmsStmt.Resource).toBe(KEY);
  });

  it("folds AccessDenied into the result without throwing (graceful degradation)", async () => {
    const err = new Error("not authorized to perform iam:PutRolePolicy");
    (err as any).name = "AccessDeniedException";
    iam.on(PutRolePolicyCommand).rejects(err);
    const r = await grantSecretAccessToRole({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });
    expect(r.granted).toBe(false);
    expect(r.errorCode).toBe("AccessDenied");
    // The policy document is still returned so the operator can apply it by hand.
    expect(r.policyDocument).toContain("secretsmanager:GetSecretValue");
  });

  it("plans (but does not apply) the grant under dry-run", async () => {
    iam.on(PutRolePolicyCommand).resolves({});
    const r = await grantSecretAccessToRole({
      region: "us-west-2",
      roleArn: ROLE,
      secretArn: ARN,
      dryRun: true,
      client: iam as unknown as IAMClient,
    });
    expect(r.granted).toBe(false);
    expect(r.skipped).toBe("dry-run");
    expect(iam.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
    expect(r.policyDocument).toContain("secretsmanager:GetSecretValue");
  });

  it("reports InvalidRole (without an AWS call) when the role ARN can't be parsed", async () => {
    const r = await grantSecretAccessToRole({
      region: "us-west-2",
      roleArn: "not-an-arn",
      secretArn: ARN,
      client: iam as unknown as IAMClient,
    });
    expect(r.granted).toBe(false);
    expect(r.errorCode).toBe("InvalidRole");
    expect(iam.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });
});
