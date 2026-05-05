import { describe, expect, it } from "vitest";
import {
  applyPlan,
  buildSwitchPlan,
  inspectVendor,
} from "../src/lib/vendor.js";
import type { FunctionSnapshot } from "../src/lib/lambda.js";

const DASH0_LAYER =
  "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:6";
const LUMIGO_LAYER =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:128";

function snap(over: Partial<FunctionSnapshot> = {}): FunctionSnapshot {
  return {
    functionName: "fn",
    functionArn: "arn:aws:lambda:us-west-2:111:function:fn",
    runtime: "nodejs20.x",
    architectures: ["x86_64"],
    layers: [],
    env: {},
    role: "arn:aws:iam::111:role/fn",
    raw: {} as never,
    ...over,
  };
}

describe("inspectVendor", () => {
  it("dash0 active when wrapper is /opt/wrapper and dash0 layer present", () => {
    const v = inspectVendor(
      snap({
        layers: [{ Arn: DASH0_LAYER }],
        env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper" },
      }),
    );
    expect(v.active).toBe("dash0");
    expect(v.hasDash0Layer).toBe(true);
    expect(v.hasLumigoLayer).toBe(false);
  });

  it("lumigo active for Java when wrapper is /opt/lumigo_wrapper", () => {
    const v = inspectVendor(
      snap({
        runtime: "java21",
        layers: [{ Arn: LUMIGO_LAYER }],
        env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper" },
      }),
    );
    expect(v.active).toBe("lumigo");
  });

  it("lumigo active for Node with no wrapper (auto-load) when not switched off", () => {
    const v = inspectVendor(
      snap({
        layers: [{ Arn: LUMIGO_LAYER }],
        env: { LUMIGO_TRACER_TOKEN: "t_xxx" },
      }),
    );
    expect(v.active).toBe("lumigo");
  });

  it("returns 'none' when both layers attached but kill-switched", () => {
    const v = inspectVendor(
      snap({
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        env: { LUMIGO_SWITCH_OFF: "true" },
      }),
    );
    expect(v.active).toBe("none");
  });

  it("ambiguous when both layers attached + something weird", () => {
    const v = inspectVendor(
      snap({
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        runtime: "java21",
        env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/some-other-wrapper" },
      }),
    );
    expect(v.active).toBe("ambiguous");
  });
});

describe("buildSwitchPlan — to Dash0", () => {
  it("blocks when no Dash0 layer attached", () => {
    const plan = buildSwitchPlan(
      snap({ layers: [{ Arn: LUMIGO_LAYER }] }),
      "dash0",
    );
    expect(plan.blocker).toMatch(/no Dash0 layer/i);
    expect(plan.envChanges).toEqual([]);
  });

  it("sets the wrapper and adds LUMIGO_SWITCH_OFF=true when Lumigo also present", () => {
    const plan = buildSwitchPlan(
      snap({
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        env: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/lumigo_wrapper",
          LUMIGO_TRACER_TOKEN: "t_xxx",
        },
        runtime: "java21",
      }),
      "dash0",
    );
    expect(plan.blocker).toBeUndefined();
    const keys = plan.envChanges.map((c) => c[0]);
    expect(keys).toContain("AWS_LAMBDA_EXEC_WRAPPER");
    expect(keys).toContain("LUMIGO_SWITCH_OFF");
    expect(plan.targetWrapper).toBe("/opt/wrapper");
  });

  it("is a no-op when already on Dash0", () => {
    const plan = buildSwitchPlan(
      snap({
        layers: [{ Arn: DASH0_LAYER }],
        env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper" },
      }),
      "dash0",
    );
    expect(plan.envChanges).toEqual([]);
  });
});

describe("buildSwitchPlan — to Lumigo", () => {
  it("blocks when no Lumigo layer attached", () => {
    const plan = buildSwitchPlan(
      snap({ layers: [{ Arn: DASH0_LAYER }] }),
      "lumigo",
    );
    expect(plan.blocker).toMatch(/no Lumigo layer/i);
  });

  it("removes the wrapper for Node functions (Lumigo auto-loads)", () => {
    const plan = buildSwitchPlan(
      snap({
        runtime: "nodejs20.x",
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        env: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
          LUMIGO_SWITCH_OFF: "true",
          LUMIGO_TRACER_TOKEN: "t_xxx",
        },
      }),
      "lumigo",
    );
    expect(plan.targetWrapper).toBeUndefined();
    const keys = plan.envChanges.map((c) => c[0]);
    expect(keys).toContain("AWS_LAMBDA_EXEC_WRAPPER");
    expect(keys).toContain("LUMIGO_SWITCH_OFF"); // removed
    // The wrapper change is "remove": after === undefined
    const wrap = plan.envChanges.find((c) => c[0] === "AWS_LAMBDA_EXEC_WRAPPER")!;
    expect(wrap[2]).toBeUndefined();
  });

  it("uses /opt/lumigo_wrapper for Java", () => {
    const plan = buildSwitchPlan(
      snap({
        runtime: "java21",
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        env: {
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper",
          LUMIGO_TRACER_TOKEN: "t_xxx",
        },
      }),
      "lumigo",
    );
    expect(plan.targetWrapper).toBe("/opt/lumigo_wrapper");
  });

  it("warns when no LUMIGO_TRACER_TOKEN is set", () => {
    const plan = buildSwitchPlan(
      snap({
        runtime: "java21",
        layers: [{ Arn: DASH0_LAYER }, { Arn: LUMIGO_LAYER }],
        env: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper" },
      }),
      "lumigo",
    );
    expect(plan.warnings.some((w) => /LUMIGO_TRACER_TOKEN/.test(w))).toBe(true);
  });
});

describe("applyPlan", () => {
  it("applies adds, changes, and removes correctly", () => {
    const env = { AWS_LAMBDA_EXEC_WRAPPER: "/opt/wrapper", DB_URL: "x" };
    const after = applyPlan(env, {
      envChanges: [
        ["AWS_LAMBDA_EXEC_WRAPPER", "/opt/wrapper", undefined], // remove
        ["LUMIGO_SWITCH_OFF", undefined, "true"], // add
      ],
      targetWrapper: undefined,
      warnings: [],
    });
    expect(after).toEqual({ DB_URL: "x", LUMIGO_SWITCH_OFF: "true" });
  });
});
