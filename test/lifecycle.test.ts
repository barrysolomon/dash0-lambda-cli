/**
 * End-to-end lifecycle tests: install Dash0 → validate → remove-lumigo →
 * uninstall, run against six different starting Lumigo footprints.
 *
 * Unlike the per-command suites, these use a STATEFUL fake Lambda: each
 * UpdateFunctionConfiguration mutates the in-memory function, and the next
 * GetFunctionConfiguration reads it back. That's what makes this a real
 * lifecycle rather than four independent assertions — a command that writes
 * a subtly wrong config breaks the *following* stage, which is exactly the
 * class of bug isolated unit tests miss.
 *
 * The six shapes cover the full cross-product of Lumigo's three artifacts
 * (tracer layer / LUMIGO_* env / exec wrapper), including the orphaned
 * partial states left behind by half-finished manual cleanups.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { install } from "../src/commands/install.js";
import { validate } from "../src/commands/validate.js";
import { removeLumigo } from "../src/commands/removeLumigo.js";
import { uninstall } from "../src/commands/uninstall.js";
import { KNOWN_LATEST_LAYER_VERSION } from "../src/lib/layers.js";

const lambdaMock = mockClient(LambdaClient);

const FN = "orders-create";
const REGION = "us-west-2";
const ENDPOINT = "https://ingress.us-west-2.aws.dash0.com:4318";
const VALID_TOKEN = "auth_" + "a".repeat(40);

const LUMIGO_LAYER =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:312";
const LUMIGO_WRAPPER = "/opt/lumigo_wrapper";
const DASH0_WRAPPER = "/opt/wrapper";
const DASH0_LAYER = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:${KNOWN_LATEST_LAYER_VERSION.node}`;
/** Unrelated layer — must survive every single stage, in every shape. */
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";

interface FnState {
  layers: string[];
  env: Record<string, string>;
}

/**
 * Wire the mock to a mutable state object so writes are observable by
 * subsequent reads.
 */
function statefulLambda(state: FnState) {
  lambdaMock.on(GetFunctionConfigurationCommand).callsFake(() => ({
    FunctionName: FN,
    Runtime: "nodejs20.x",
    Architectures: ["x86_64"],
    PackageType: "Zip",
    Layers: state.layers.map((Arn) => ({ Arn })),
    Environment: { Variables: { ...state.env } },
    Role: `arn:aws:iam::111:role/${FN}`,
  }));
  lambdaMock.on(UpdateFunctionConfigurationCommand).callsFake((input) => {
    state.layers = [...(input.Layers ?? [])];
    state.env = { ...(input.Environment?.Variables ?? {}) };
    return {};
  });
  return new LambdaWrapper({
    region: REGION,
    client: lambdaMock as unknown as LambdaClient,
  });
}

const lumigoEnvKeys = (env: Record<string, string>) =>
  Object.keys(env).filter((k) => k.startsWith("LUMIGO_"));
const dash0EnvKeys = (env: Record<string, string>) =>
  Object.keys(env).filter((k) => k.startsWith("DASH0_"));

/** The six starting Lumigo footprints. */
const SHAPES: Array<{
  name: string;
  layer: boolean;
  env: boolean;
  wrapper: boolean;
}> = [
  { name: "1. clean (no Lumigo at all)", layer: false, env: false, wrapper: false },
  { name: "2. Lumigo layer only", layer: true, env: false, wrapper: false },
  { name: "3. Lumigo layer + LUMIGO_* env", layer: true, env: true, wrapper: false },
  { name: "4. fully traced (layer + env + wrapper)", layer: true, env: true, wrapper: true },
  { name: "5. orphaned LUMIGO_* env, no layer", layer: false, env: true, wrapper: false },
  { name: "6. orphaned Lumigo wrapper, no layer", layer: false, env: false, wrapper: true },
];

beforeEach(() => lambdaMock.reset());
afterEach(() => lambdaMock.reset());

describe("lifecycle: install → validate → remove-lumigo → uninstall", () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      const state: FnState = {
        layers: [CUSTOM_LIB, ...(shape.layer ? [LUMIGO_LAYER] : [])],
        env: {
          DB_URL: "postgres://x",
          ...(shape.env ? { LUMIGO_TRACER_TOKEN: "t_abc" } : {}),
          ...(shape.wrapper ? { AWS_LAMBDA_EXEC_WRAPPER: LUMIGO_WRAPPER } : {}),
        },
      };
      const lambda = statefulLambda(state);

      // ── Stage 1: install Dash0 ────────────────────────────────────
      const inst = await install({
        function: FN,
        region: REGION,
        endpoint: ENDPOINT,
        token: VALID_TOKEN,
        lambda,
      });
      expect(inst.applied).toBe(true);
      expect(state.layers).toContain(DASH0_LAYER);
      expect(state.layers).toContain(CUSTOM_LIB);
      // install is additive for non-Dash0 layers: Lumigo survives it.
      expect(state.layers.includes(LUMIGO_LAYER)).toBe(shape.layer);
      expect(state.env.DASH0_ENDPOINT).toBe(ENDPOINT);
      expect(state.env.DB_URL).toBe("postgres://x");
      // install owns the wrapper — any Lumigo wrapper is replaced here.
      expect(state.env.AWS_LAMBDA_EXEC_WRAPPER).toBe(DASH0_WRAPPER);

      // ── Stage 2: validate ─────────────────────────────────────────
      const val = await validate({
        function: FN,
        region: REGION,
        checkSecret: false,
        lambda,
      });
      expect(val.pass).toBe(true);
      expect(val.checks.find((c) => c.name === "layer-version")?.level).toBe(
        "ok",
      );

      // ── Stage 3: remove-lumigo ────────────────────────────────────
      const [rl] = await removeLumigo({ function: FN, region: REGION, lambda });
      // Only a real Lumigo footprint triggers a write. By this point the
      // wrapper is Dash0's, so shapes 1 and 6 have nothing left to remove.
      const expectedLumigoWork = shape.layer || shape.env;
      expect(rl!.applied).toBe(expectedLumigoWork);
      expect(state.layers).not.toContain(LUMIGO_LAYER);
      expect(lumigoEnvKeys(state.env)).toEqual([]);
      // Dash0 must be completely untouched by the Lumigo removal.
      expect(state.layers).toContain(DASH0_LAYER);
      expect(state.env.AWS_LAMBDA_EXEC_WRAPPER).toBe(DASH0_WRAPPER);
      expect(state.env.DASH0_ENDPOINT).toBe(ENDPOINT);

      // ── Stage 4: uninstall Dash0 ──────────────────────────────────
      const uninst = await uninstall({
        function: FN,
        region: REGION,
        clearWrapper: true,
        lambda,
      });
      expect(uninst.applied).toBe(true);
      expect(state.layers).not.toContain(DASH0_LAYER);
      expect(dash0EnvKeys(state.env)).toEqual([]);
      expect(state.env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();

      // ── End state: back to a clean function ───────────────────────
      // Whatever Lumigo shape we started from, the unrelated layer and env
      // var are intact and both vendors are fully gone.
      expect(state.layers).toEqual([CUSTOM_LIB]);
      expect(state.env).toEqual({ DB_URL: "postgres://x" });
    });
  }
});
