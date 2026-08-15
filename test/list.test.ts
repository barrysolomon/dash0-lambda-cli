/**
 * Tests for `list` (alias `status`) — the fleet-wide footprint report.
 *
 * `list` never writes, so its risk isn't destruction, it's *lying*. Three
 * ways it can lie, all covered here:
 *
 *   - Mis-reporting a footprint: showing "—" for a function that IS traced,
 *     or a Dash0 version that isn't the one attached.
 *   - Silently dropping rows: a filter that excludes more than it claims.
 *   - Corrupting machine-readable output: the docstring promises `--format
 *     json` is a "full snapshot, useful for scripting", so anything the
 *     table shortens for display must not be shortened in JSON.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  LambdaClient,
  ListFunctionsCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LambdaWrapper } from "../src/lib/lambda.js";
import { list } from "../src/commands/list.js";
import { KNOWN_LATEST_LAYER_VERSION } from "../src/lib/layers.js";

const lambdaMock = mockClient(LambdaClient);

let logged: string[];

beforeEach(() => {
  lambdaMock.reset();
  logged = [];
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void logged.push(a.map(String).join(" ")),
  );
});
afterEach(() => {
  lambdaMock.reset();
  vi.restoreAllMocks();
});

const REGION = "us-west-2";
const DASH0_NODE = `arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:${KNOWN_LATEST_LAYER_VERSION.node}`;
const LUMIGO_NODE =
  "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:312";
const CUSTOM_LIB = "arn:aws:lambda:us-west-2:111:layer:custom-libs:7";

interface FnSpec {
  name: string;
  runtime?: string;
  arch?: string[];
  layers?: string[];
  env?: Record<string, string>;
}

function seed(specs: FnSpec[]) {
  lambdaMock.on(ListFunctionsCommand).resolves({
    Functions: specs.map((s) => ({
      FunctionName: s.name,
      Runtime: s.runtime ?? "nodejs20.x",
      Architectures: s.arch ?? ["x86_64"],
      PackageType: "Zip" as const,
      Layers: (s.layers ?? []).map((Arn) => ({ Arn })),
      Environment: { Variables: s.env ?? {} },
      Role: `arn:aws:iam::111:role/${s.name}`,
    })),
  });
}

function wrapper() {
  return new LambdaWrapper({
    region: REGION,
    dryRun: true,
    client: lambdaMock as unknown as LambdaClient,
  });
}

const out = () => logged.join("\n");
const base = { region: REGION };

describe("list — footprint reporting", () => {
  it("reports the Dash0 layer version and runtime family", async () => {
    seed([{ name: "orders-create", layers: [DASH0_NODE] }]);

    const rows = await list({ ...base, lambda: wrapper() });

    expect(rows[0]!.dash0).toBe(`v${KNOWN_LATEST_LAYER_VERSION.node}/node`);
  });

  it("shows an em dash, not an empty cell, for a function with no Dash0", async () => {
    seed([{ name: "orders-create", layers: [CUSTOM_LIB] }]);

    const rows = await list({ ...base, lambda: wrapper() });

    expect(rows[0]!.dash0).toBe("—");
    expect(rows[0]!.lumigo).toBe("—");
  });

  it("detects Lumigo from an attached layer", async () => {
    seed([{ name: "orders-create", layers: [LUMIGO_NODE] }]);

    expect((await list({ ...base, lambda: wrapper() }))[0]!.lumigo).toBe("yes");
  });

  it("detects Lumigo from env vars alone, with no layer attached", async () => {
    // A half-uninstalled Lumigo function still ships config; reporting "—"
    // here is exactly the lie that makes an operator skip it during a
    // migration sweep.
    seed([{ name: "orders-create", env: { LUMIGO_TRACER_TOKEN: "t_abc" } }]);

    expect((await list({ ...base, lambda: wrapper() }))[0]!.lumigo).toBe("yes");
  });

  it("reports both vendors on a mid-migration function", async () => {
    seed([{ name: "orders-create", layers: [DASH0_NODE, LUMIGO_NODE] }]);

    const row = (await list({ ...base, lambda: wrapper() }))[0]!;
    expect(row.dash0).toBe(`v${KNOWN_LATEST_LAYER_VERSION.node}/node`);
    expect(row.lumigo).toBe("yes");
  });

  it("carries runtime, architecture, endpoint and dataset through", async () => {
    seed([
      {
        name: "orders-create",
        runtime: "python3.12",
        arch: ["arm64"],
        env: {
          DASH0_ENDPOINT: "https://ingress.us-west-2.aws.dash0.com:4318",
          DASH0_DATASET: "prod",
        },
      },
    ]);

    const row = (await list({ ...base, lambda: wrapper() }))[0]!;
    expect(row.runtime).toBe("python3.12");
    expect(row.arch).toBe("arm64");
    expect(row.dataset).toBe("prod");
  });

  it("falls back to x86_64 when AWS reports no architectures", async () => {
    seed([{ name: "orders-create", arch: [] }]);

    expect((await list({ ...base, lambda: wrapper() }))[0]!.arch).toBe("x86_64");
  });

  it("sorts rows by name regardless of AWS's ordering", async () => {
    seed([{ name: "zeta" }, { name: "alpha" }, { name: "mid" }]);

    const rows = await list({ ...base, lambda: wrapper() });

    expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns an empty list for an account with no functions", async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({});

    expect(await list({ ...base, lambda: wrapper() })).toEqual([]);
  });
});

describe("list — filters", () => {
  it("matches --filter as a case-insensitive substring", async () => {
    seed([{ name: "OrdersCreate" }, { name: "payments-refund" }]);

    const rows = await list({ ...base, filter: "orders", lambda: wrapper() });

    expect(rows.map((r) => r.name)).toEqual(["OrdersCreate"]);
  });

  it("--only-dash0 drops functions without a Dash0 layer", async () => {
    seed([
      { name: "traced", layers: [DASH0_NODE] },
      { name: "untraced", layers: [CUSTOM_LIB] },
    ]);

    const rows = await list({ ...base, onlyDash0: true, lambda: wrapper() });

    expect(rows.map((r) => r.name)).toEqual(["traced"]);
  });

  it("--only-lumigo keeps a function whose only Lumigo trace is env", async () => {
    seed([
      { name: "env-only", env: { LUMIGO_TRACER_TOKEN: "t" } },
      { name: "clean" },
    ]);

    const rows = await list({ ...base, onlyLumigo: true, lambda: wrapper() });

    expect(rows.map((r) => r.name)).toEqual(["env-only"]);
  });

  it("combines --only-dash0 and --only-lumigo as AND, not OR", async () => {
    // The useful query during a migration: "what is currently double-attached?"
    seed([
      { name: "both", layers: [DASH0_NODE, LUMIGO_NODE] },
      { name: "dash0-only", layers: [DASH0_NODE] },
      { name: "lumigo-only", layers: [LUMIGO_NODE] },
    ]);

    const rows = await list({
      ...base,
      onlyDash0: true,
      onlyLumigo: true,
      lambda: wrapper(),
    });

    expect(rows.map((r) => r.name)).toEqual(["both"]);
  });

  it("stacks --filter with a vendor filter", async () => {
    seed([
      { name: "orders-create", layers: [DASH0_NODE] },
      { name: "orders-charge" },
      { name: "payments-refund", layers: [DASH0_NODE] },
    ]);

    const rows = await list({
      ...base,
      filter: "orders",
      onlyDash0: true,
      lambda: wrapper(),
    });

    expect(rows.map((r) => r.name)).toEqual(["orders-create"]);
  });

  it("returns nothing when the filter matches nothing", async () => {
    seed([{ name: "orders-create" }]);

    expect(
      await list({ ...base, filter: "nope", lambda: wrapper() }),
    ).toEqual([]);
  });
});

describe("list — output formats", () => {
  const LONG_ENDPOINT =
    "https://ingress.us-west-2.aws.dash0.com:4318/v1/traces/extra/path";

  it("emits parseable JSON with --format json", async () => {
    seed([{ name: "orders-create", layers: [DASH0_NODE] }]);

    await list({ ...base, format: "json", lambda: wrapper() });

    const parsed = JSON.parse(out());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("orders-create");
  });

  it("keeps the endpoint intact in JSON output", async () => {
    // The docstring promises --format json is a "full snapshot, useful for
    // scripting". An endpoint truncated with a "…" is not a URL: it breaks
    // `jq -r '.[].endpoint'` piped into anything, and it silently makes two
    // different long endpoints compare equal.
    seed([{ name: "orders-create", env: { DASH0_ENDPOINT: LONG_ENDPOINT } }]);

    await list({ ...base, format: "json", lambda: wrapper() });

    expect(JSON.parse(out())[0].endpoint).toBe(LONG_ENDPOINT);
  });

  it("returns the full endpoint to programmatic callers", async () => {
    seed([{ name: "orders-create", env: { DASH0_ENDPOINT: LONG_ENDPOINT } }]);

    const rows = await list({ ...base, lambda: wrapper() });

    expect(rows[0]!.endpoint).toBe(LONG_ENDPOINT);
  });

  it("shortens the endpoint in the table so rows fit in 120 columns", async () => {
    seed([{ name: "orders-create", env: { DASH0_ENDPOINT: LONG_ENDPOINT } }]);

    await list({ ...base, format: "table", lambda: wrapper() });

    expect(out()).toContain("…");
    expect(out()).not.toContain(LONG_ENDPOINT);
  });

  it("leaves a short endpoint unshortened in the table", async () => {
    seed([{ name: "orders-create", env: { DASH0_ENDPOINT: "https://x:4318" } }]);

    await list({ ...base, format: "table", lambda: wrapper() });

    expect(out()).toContain("https://x:4318");
  });

  it("emits YAML with --format yaml", async () => {
    seed([{ name: "orders-create" }]);

    await list({ ...base, format: "yaml", lambda: wrapper() });

    expect(out()).toMatch(/name:\s*orders-create/);
  });

  it("defaults to the table format and prints a match count", async () => {
    seed([{ name: "a" }, { name: "b" }]);

    await list({ ...base, lambda: wrapper() });

    expect(out()).toMatch(/2 match/);
    expect(out()).toMatch(/runtime/);
  });

  it("counts matches after filtering, not before", async () => {
    seed([{ name: "orders-create" }, { name: "payments-refund" }]);

    await list({ ...base, filter: "orders", lambda: wrapper() });

    expect(out()).toMatch(/1 match/);
  });
});

describe("list — is strictly read-only", () => {
  it("never issues a mutating call", async () => {
    seed([{ name: "orders-create", layers: [DASH0_NODE, LUMIGO_NODE] }]);

    await list({ ...base, lambda: wrapper() });

    expect(
      lambdaMock.commandCalls(UpdateFunctionConfigurationCommand),
    ).toHaveLength(0);
  });
});
