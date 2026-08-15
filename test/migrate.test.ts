/**
 * Tests for `migrate` — the Lumigo → Dash0 swap.
 *
 * migrate is the highest-risk command in the CLI: destructive, bulk-capable,
 * and the only one that removes one vendor and installs another. Its core
 * contract is ATOMICITY — a single UpdateFunctionConfiguration per function
 * whose one payload both drops Lumigo and adds Dash0, so the function is
 * never observable with neither vendor attached.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListFunctionsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  DescribeSecretCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { migrate } from "../src/commands/migrate.js";
import { KNOWN_LATEST_LAYER_VERSION } from "../src/lib/layers.js";

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

const REGION = "us-west-2";
const ENDPOINT = "https://ingress.us-west-2.aws.dash0.com:4318";
const VALID_TOKEN = "auth_" + "a".repeat(40);
const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AaBb";

const LUMIGO_LAYER =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:312";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";
const dash0Layer = (family = "node", v = KNOWN_LATEST_LAYER_VERSION.node) =>
  `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-${family}:${v}`;

function wrapper(dryRun = false) {
  return new LambdaWrapper({
    region: REGION,
    dryRun,
    client: lambdaMock as unknown as LambdaClient,
  });
}

interface FnSpec {
  name: string;
  runtime?: string;
  layers?: string[];
  env?: Record<string, string>;
}

function fnConfig(spec: FnSpec) {
  return {
    FunctionName: spec.name,
    Runtime: spec.runtime ?? "nodejs20.x",
    Architectures: ["x86_64"],
    PackageType: "Zip" as const,
    Layers: (spec.layers ?? [LUMIGO_LAYER]).map((Arn) => ({ Arn })),
    Environment: {
      Variables: spec.env ?? { LUMIGO_TRACER_TOKEN: "t_abc" },
    },
    Role: `arn:aws:iam::111:role/${spec.name}`,
  };
}

function seedOne(spec: FnSpec) {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves(fnConfig(spec));
  lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
}

function seedFleet(specs: FnSpec[]) {
  lambdaMock
    .on(ListFunctionsCommand)
    .resolves({ Functions: specs.map(fnConfig) });
  lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
}

/** All update calls, keyed by function name. */
function updates() {
  return Object.fromEntries(
    lambdaMock.commandCalls(UpdateFunctionConfigurationCommand).map((call) => {
      const input = call.args[0].input;
      return [
        input.FunctionName,
        {
          layers: input.Layers ?? [],
          env: input.Environment?.Variables ?? {},
        },
      ];
    }),
  );
}

const baseOpts = { region: REGION, endpoint: ENDPOINT, token: VALID_TOKEN };

describe("migrate — the atomic swap", () => {
  it("drops Lumigo and adds Dash0 in a SINGLE update call", async () => {
    seedOne({
      name: "orders-create",
      layers: [LUMIGO_LAYER, CUSTOM_LIB],
      env: {
        LUMIGO_TRACER_TOKEN: "t_abc",
        LUMIGO_ENABLE_LOGS: "true",
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
        DB_URL: "postgres://x",
      },
    });

    const out = await migrate({
      ...baseOpts,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
    });

    expect(out).toEqual([{ function: "orders-create", status: "migrated" }]);

    // Atomicity: exactly one write, carrying both halves of the swap.
    const calls = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand);
    expect(calls).toHaveLength(1);

    const { layers, env } = updates()["orders-create"]!;
    expect(layers).toContain(dash0Layer());
    expect(layers).not.toContain(LUMIGO_LAYER);
    expect(layers).toContain(CUSTOM_LIB); // unrelated layer survives
    expect(env.LUMIGO_TRACER_TOKEN).toBeUndefined();
    expect(env.LUMIGO_ENABLE_LOGS).toBeUndefined();
    expect(env.DASH0_ENDPOINT).toBe(ENDPOINT);
    expect(env.DASH0_TOKEN).toBe(VALID_TOKEN);
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/wrapper");
    expect(env.DB_URL).toBe("postgres://x"); // unrelated env survives
  });

  it("replaces an existing Dash0 layer rather than stacking a duplicate", async () => {
    const oldDash0 =
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:3";
    seedOne({
      name: "orders-create",
      layers: [LUMIGO_LAYER, oldDash0],
    });

    await migrate({
      ...baseOpts,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
    });

    const { layers } = updates()["orders-create"]!;
    expect(layers).toEqual([dash0Layer()]);
  });

  it("still installs Dash0 on a function with no Lumigo footprint", async () => {
    // Documents current behavior: migrate is "land on Dash0", not
    // "only touch Lumigo-traced functions".
    seedOne({ name: "orders-create", layers: [], env: {} });

    const out = await migrate({
      ...baseOpts,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
    });

    expect(out[0]!.status).toBe("migrated");
    expect(updates()["orders-create"]!.layers).toEqual([dash0Layer()]);
  });

  it("maps the manual family to no exec wrapper", async () => {
    seedOne({ name: "custom-rt", runtime: "provided.al2023", layers: [] });

    await migrate({
      ...baseOpts,
      function: "custom-rt",
      yes: true,
      lambda: wrapper(),
    });

    const { layers, env } = updates()["custom-rt"]!;
    expect(layers[0]).toContain("dash0-extension-manual");
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
  });

  it("honors --layer-version and --layer-owner overrides", async () => {
    seedOne({ name: "orders-create", layers: [] });

    await migrate({
      ...baseOpts,
      function: "orders-create",
      layerVersion: 7,
      layerOwner: "999888777666",
      yes: true,
      lambda: wrapper(),
    });

    expect(updates()["orders-create"]!.layers[0]).toBe(
      "arn:aws:lambda:us-west-2:999888777666:layer:dash0-extension-node:7",
    );
  });
});

describe("migrate — preserved configuration", () => {
  it("preserves a customer's own OTEL_RESOURCE_ATTRIBUTES", async () => {
    // buildMigrationPlan drops OTEL_RESOURCE_ATTRIBUTES from envToKeep on the
    // grounds that "install owns this" — but migrate only re-adds what
    // configToEnv emits, which is nothing unless a flag was passed. Without
    // this, a customer's resource attributes vanish silently.
    seedOne({
      name: "orders-create",
      env: {
        LUMIGO_TRACER_TOKEN: "t_abc",
        OTEL_RESOURCE_ATTRIBUTES: "team=payments,tier=critical",
      },
    });

    await migrate({
      ...baseOpts,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
    });

    expect(updates()["orders-create"]!.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "team=payments,tier=critical",
    );
  });
});

describe("migrate — target selection", () => {
  it("rejects --function and --filter together", async () => {
    await expect(
      migrate({
        ...baseOpts,
        function: "orders-create",
        filter: "^orders-",
        lambda: wrapper(),
      }),
    ).rejects.toThrow(/either --function or --filter/);
  });

  it("rejects neither --function nor --filter", async () => {
    await expect(migrate({ ...baseOpts, lambda: wrapper() })).rejects.toThrow(
      /provide --function/,
    );
  });

  it("only touches functions matching the regex", async () => {
    seedFleet([
      { name: "orders-create" },
      { name: "orders-charge" },
      { name: "payments-refund" },
    ]);

    const out = await migrate({
      ...baseOpts,
      filter: "^orders-",
      yes: true,
      lambda: wrapper(),
    });

    expect(out.map((o) => o.function).sort()).toEqual([
      "orders-charge",
      "orders-create",
    ]);
    expect(Object.keys(updates()).sort()).toEqual([
      "orders-charge",
      "orders-create",
    ]);
  });

  it("returns an empty result when the regex matches nothing", async () => {
    seedFleet([{ name: "payments-refund" }]);

    const out = await migrate({
      ...baseOpts,
      filter: "^nope-",
      yes: true,
      lambda: wrapper(),
    });

    expect(out).toEqual([]);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});

describe("migrate — safety gates", () => {
  it("refuses to apply without --yes in a non-interactive session", async () => {
    seedOne({ name: "orders-create" });

    await expect(
      migrate({ ...baseOpts, function: "orders-create", lambda: wrapper() }),
    ).rejects.toThrow(/Refusing to apply without --yes/);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("plans without writing on --dry-run", async () => {
    seedOne({ name: "orders-create" });

    const out = await migrate({
      ...baseOpts,
      function: "orders-create",
      dryRun: true,
      lambda: wrapper(true),
    });

    expect(out).toEqual([{ function: "orders-create", status: "planned" }]);
    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });

  it("validates Dash0 config before making any AWS call", async () => {
    seedOne({ name: "orders-create" });

    await expect(
      migrate({
        region: REGION,
        endpoint: "not-a-url",
        token: VALID_TOKEN,
        function: "orders-create",
        yes: true,
        lambda: wrapper(),
      }),
    ).rejects.toThrow();

    expect(
      lambdaMock.commandCalls(GetFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});

describe("migrate — fan-out", () => {
  it("isolates failures: one bad function doesn't stop the others", async () => {
    seedFleet([
      { name: "orders-create" },
      { name: "orders-charge" },
      { name: "orders-ship" },
    ]);
    lambdaMock
      .on(UpdateFunctionConfigurationCommand, { FunctionName: "orders-charge" })
      .rejects(new Error("ResourceConflictException: update in progress"));

    const out = await migrate({
      ...baseOpts,
      filter: "^orders-",
      yes: true,
      lambda: wrapper(),
    });

    const byName = Object.fromEntries(out.map((o) => [o.function, o]));
    expect(byName["orders-create"]!.status).toBe("migrated");
    expect(byName["orders-ship"]!.status).toBe("migrated");
    expect(byName["orders-charge"]!.status).toBe("failed");
    expect(byName["orders-charge"]!.message).toMatch(/ResourceConflict/);
  });

  it.each([1, 2, 4, 8])(
    "processes every function exactly once at concurrency %i",
    async (concurrency) => {
      const names = Array.from({ length: 7 }, (_, i) => `orders-${i}`);
      seedFleet(names.map((name) => ({ name })));

      const out = await migrate({
        ...baseOpts,
        filter: "^orders-",
        concurrency,
        yes: true,
        lambda: wrapper(),
      });

      expect(out).toHaveLength(names.length);
      expect(out.map((o) => o.function).sort()).toEqual([...names].sort());
      // No function written twice — the shared cursor must not hand the
      // same index to two workers.
      expect(
        lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
      ).toHaveLength(names.length);
    },
  );
});

describe("migrate — unmappable Lumigo settings surface as warnings", () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    [
      "domain scrubbing",
      { LUMIGO_DOMAINS_SCRUBBER: '[".*secret.*"]' },
      /redaction|collector/i,
    ],
    [
      "secret masking",
      { LUMIGO_SECRET_MASKING_REGEX: '[".*pass.*"]' },
      /redaction|collector/i,
    ],
    ["step functions", { LUMIGO_STEP_FUNCTION: "true" }, /Step Functions/i],
    [
      "blacklist regex",
      { LUMIGO_BLACKLIST_REGEX: '[".*health.*"]' },
      /filter processor/i,
    ],
    ["switched off", { LUMIGO_SWITCH_OFF: "true" }, /disabled/i],
  ];

  it.each(cases)("warns about %s", async (_label, env, pattern) => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      seedOne({ name: "orders-create", env: { ...env } });
      await migrate({
        ...baseOpts,
        function: "orders-create",
        yes: true,
        lambda: wrapper(),
      });
    } finally {
      console.log = orig;
    }
    expect(logged.join("\n")).toMatch(pattern);
  });
});

describe("migrate — secret-mode auth", () => {
  it("grants the execution role read access to the token secret", async () => {
    // Without this the migration looks successful but the extension fails
    // at runtime with AccessDenied — `install` already does this grant.
    seedOne({ name: "orders-create" });
    smMock.on(DescribeSecretCommand).resolves({ KmsKeyId: "alias/aws/secretsmanager" });
    iamMock.on(PutRolePolicyCommand).resolves({});

    await migrate({
      region: REGION,
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
      iam: iamMock as unknown as IAMClient,
      secretsManager: smMock as unknown as SecretsManagerClient,
    });

    const calls = iamMock.commandCalls(PutRolePolicyCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.RoleName).toBe("orders-create");
    expect(calls[0]!.args[0].input.PolicyDocument).toContain(
      "secretsmanager:GetSecretValue",
    );
  });

  it("does not touch IAM when using a plaintext token", async () => {
    seedOne({ name: "orders-create" });

    await migrate({
      ...baseOpts,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
      iam: iamMock as unknown as IAMClient,
      secretsManager: smMock as unknown as SecretsManagerClient,
    });

    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it("sets DASH0_TOKEN_SECRET_ARN and no plaintext token", async () => {
    seedOne({ name: "orders-create" });

    await migrate({
      region: REGION,
      endpoint: ENDPOINT,
      tokenSecretArn: SECRET_ARN,
      function: "orders-create",
      yes: true,
      lambda: wrapper(),
    });

    const { env } = updates()["orders-create"]!;
    expect(env.DASH0_TOKEN_SECRET_ARN).toBe(SECRET_ARN);
    expect(env.DASH0_TOKEN).toBeUndefined();
  });
});
