import { describe, expect, it } from "vitest";
import {
  buildMigrationPlan,
  detectLumigo,
  hasLumigoFootprint,
} from "../src/lib/lumigo.js";
import type { FunctionSnapshot } from "../src/lib/lambda.js";

const snapshotWithLumigo: FunctionSnapshot = {
  functionName: "orders-create",
  functionArn: "arn:aws:lambda:us-west-2:111:function:orders-create",
  runtime: "nodejs20.x",
  architectures: ["x86_64"],
  layers: [
    {
      Arn: "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:128",
    },
    {
      Arn: "arn:aws:lambda:us-west-2:111:layer:custom-shared-utils:7",
    },
  ],
  env: {
    LUMIGO_TRACER_TOKEN: "t_abcdefghijklmnop",
    LUMIGO_DEBUG: "false",
    LUMIGO_DOMAINS_SCRUBBER: '[".*\\\\.amazonaws\\\\.com.*"]',
    DB_URL: "postgres://users",
    AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
  },
  role: "arn:aws:iam::111:role/orders-create",
  raw: {} as never,
};

describe("detectLumigo", () => {
  it("finds Lumigo layers + env", () => {
    const fp = detectLumigo(snapshotWithLumigo);
    expect(fp.layers).toHaveLength(1);
    expect(fp.env.LUMIGO_TRACER_TOKEN).toBeDefined();
    expect(fp.wrapper).toBe("/opt/lumigo_wrapper");
  });
  it("hasLumigoFootprint returns true when either layers or env present", () => {
    expect(hasLumigoFootprint(detectLumigo(snapshotWithLumigo))).toBe(true);
  });
  it("returns empty footprint for clean function", () => {
    const clean: FunctionSnapshot = {
      ...snapshotWithLumigo,
      layers: [],
      env: { DB_URL: "x" },
    };
    expect(hasLumigoFootprint(detectLumigo(clean))).toBe(false);
  });
});

describe("buildMigrationPlan", () => {
  it("preserves non-Lumigo layers", () => {
    const plan = buildMigrationPlan(snapshotWithLumigo);
    expect(plan.layersToKeep).toHaveLength(1);
    expect(plan.layersToKeep[0]?.Arn).toMatch(/custom-shared-utils/);
  });
  it("preserves non-Lumigo, non-Dash0 env vars", () => {
    const plan = buildMigrationPlan(snapshotWithLumigo);
    expect(plan.envToKeep.DB_URL).toBe("postgres://users");
    expect(plan.envToKeep.LUMIGO_TRACER_TOKEN).toBeUndefined();
    expect(plan.envToKeep.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
  });
  it("warns when domain scrubber was set", () => {
    const plan = buildMigrationPlan(snapshotWithLumigo);
    expect(
      plan.warnings.some((w) => w.includes("scrubbing")),
    ).toBe(true);
  });
  it("strips existing dash0-extension layers (so install can re-add fresh)", () => {
    const snap: FunctionSnapshot = {
      ...snapshotWithLumigo,
      layers: [
        ...snapshotWithLumigo.layers,
        {
          Arn: "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:3",
        },
      ],
    };
    const plan = buildMigrationPlan(snap);
    expect(
      plan.layersToKeep.some((l) =>
        (l.Arn ?? "").includes("dash0-extension-"),
      ),
    ).toBe(false);
  });
});
