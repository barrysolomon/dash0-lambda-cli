import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildLayerArn,
  buildLayerName,
  CANONICAL_OWNER_ACCOUNT,
  familyForRuntime,
  KNOWN_LATEST_LAYER_VERSION,
  parseDash0LayerArn,
  RUNTIME_FAMILIES,
  wrapperPathFor,
} from "../src/lib/layers.js";

describe("familyForRuntime", () => {
  it("maps node runtimes", () => {
    expect(familyForRuntime("nodejs20.x")).toBe("node");
    expect(familyForRuntime("nodejs22.x")).toBe("node");
  });
  it("maps python runtimes", () => {
    expect(familyForRuntime("python3.12")).toBe("python");
  });
  it("maps java runtimes", () => {
    expect(familyForRuntime("java21")).toBe("java");
  });
  it("falls back to manual for unknown runtimes", () => {
    expect(familyForRuntime("provided.al2023")).toBe("manual");
    expect(familyForRuntime("ruby3.2")).toBe("manual");
  });
});

describe("buildLayerArn", () => {
  it("builds canonical ARN", () => {
    expect(
      buildLayerArn({
        region: "us-west-2",
        ownerAccount: CANONICAL_OWNER_ACCOUNT,
        family: "node",
        version: 6,
      }),
    ).toBe("arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:6");
  });
  it("supports rehosted owners", () => {
    expect(
      buildLayerArn({
        region: "us-west-2",
        ownerAccount: "139457818185",
        family: "manual",
        version: 1,
      }),
    ).toBe("arn:aws:lambda:us-west-2:139457818185:layer:dash0-extension-manual:1");
  });
  it("throws when version is missing", () => {
    expect(() =>
      buildLayerArn({
        region: "us-east-1",
        ownerAccount: CANONICAL_OWNER_ACCOUNT,
        family: "node",
      }),
    ).toThrow(/requires a version/);
  });
});

describe("parseDash0LayerArn", () => {
  it("recognizes canonical ARNs", () => {
    const c = parseDash0LayerArn(
      "arn:aws:lambda:us-west-2:115813213817:layer:dash0-extension-node:6",
    );
    expect(c).toEqual({
      region: "us-west-2",
      ownerAccount: CANONICAL_OWNER_ACCOUNT,
      family: "node",
      version: 6,
    });
  });
  it("recognizes rehosted ARNs", () => {
    const c = parseDash0LayerArn(
      "arn:aws:lambda:eu-central-1:139457818185:layer:dash0-extension-manual:2",
    );
    expect(c?.family).toBe("manual");
    expect(c?.ownerAccount).toBe("139457818185");
  });
  it("returns null for non-Dash0 layers", () => {
    expect(
      parseDash0LayerArn(
        "arn:aws:lambda:us-west-2:114300393969:layer:lumigo-node-tracer:30",
      ),
    ).toBeNull();
    expect(parseDash0LayerArn("not-an-arn")).toBeNull();
  });
});

describe("KNOWN_LATEST_LAYER_VERSION", () => {
  it("has an entry for every runtime family", () => {
    for (const fam of RUNTIME_FAMILIES) {
      expect(KNOWN_LATEST_LAYER_VERSION[fam]).toBeGreaterThan(0);
    }
  });
  it("currently pins v20 across the board (bump when Dash0 ships a new release)", () => {
    expect(KNOWN_LATEST_LAYER_VERSION.node).toBe(20);
    expect(KNOWN_LATEST_LAYER_VERSION.python).toBe(20);
    expect(KNOWN_LATEST_LAYER_VERSION.java).toBe(20);
    expect(KNOWN_LATEST_LAYER_VERSION.manual).toBe(20);
  });
});

describe("buildLayerName + wrapperPathFor", () => {
  it("name follows the dash0-extension-<family> pattern", () => {
    expect(buildLayerName("node")).toBe("dash0-extension-node");
    expect(buildLayerName("manual")).toBe("dash0-extension-manual");
  });
  it("wrapper is /opt/wrapper for everything except manual", () => {
    expect(wrapperPathFor("node")).toBe("/opt/wrapper");
    expect(wrapperPathFor("python")).toBe("/opt/wrapper");
    expect(wrapperPathFor("java")).toBe("/opt/wrapper");
    expect(wrapperPathFor("manual")).toBeNull();
  });
});

/**
 * Versioning policy: the CLI's MINOR version tracks the Dash0 extension layer
 * version it pins by default. `dash0-lambda 0.20.x` installs
 * `dash0-extension-*:20`, so an operator can read one number off `--version`
 * and know what their fleet will get — no cross-referencing a changelog.
 *
 * This is a tripwire, not a computation. Bumping the layer pin means bumping
 * the package minor in the same commit, deliberately.
 */
describe("CLI version tracks the pinned layer version", () => {
  it("package.json minor === KNOWN_LATEST_LAYER_VERSION", async () => {
    const pkg = JSON.parse(
      await readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    const minor = Number(pkg.version.split(".")[1]);

    expect(minor).toBe(KNOWN_LATEST_LAYER_VERSION.node);
  });

  it("all four runtime families are pinned to the same version", () => {
    // The policy only has one number to track if the families never diverge.
    // If Dash0 ever ships them out of step, this fails and the policy needs a
    // conscious rethink rather than a silently-wrong --version.
    const versions = new Set(Object.values(KNOWN_LATEST_LAYER_VERSION));
    expect([...versions]).toHaveLength(1);
  });
});
