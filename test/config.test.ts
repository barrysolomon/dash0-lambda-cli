import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfig,
  configPath,
  loadConfig,
  loadLocalToken,
  saveConfig,
  saveTokenLocally,
} from "../src/lib/config.js";
import { defaultSecretName } from "../src/lib/secrets.js";

describe("config persistence", () => {
  let dir: string;
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await fs.mkdtemp(join(tmpdir(), "dash0-cfg-"));
    process.chdir(dir);
    delete process.env.DASH0_LAMBDA_CONFIG;
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loadConfig returns empty when no file exists", async () => {
    expect(await loadConfig()).toEqual({});
  });

  it("save then load round-trips fields", async () => {
    const path = await saveConfig({
      region: "us-west-2",
      endpoint: "https://ingress.us-west-2.aws.dash0.com:4318",
      dataset: "prod",
      tokenSecretArn:
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:dash0-token-AbCdEf",
    });
    expect(path).toBe(configPath());
    const loaded = await loadConfig();
    expect(loaded.region).toBe("us-west-2");
    expect(loaded.dataset).toBe("prod");
    expect(loaded.tokenSecretArn).toContain("secret:dash0-token-AbCdEf");
  });

  it("saveConfig merges (existing fields preserved)", async () => {
    await saveConfig({ region: "us-west-2", dataset: "prod" });
    await saveConfig({ endpoint: "https://x.dash0.com:4318" });
    const c = await loadConfig();
    expect(c.region).toBe("us-west-2");
    expect(c.dataset).toBe("prod");
    expect(c.endpoint).toBe("https://x.dash0.com:4318");
  });

  it("clearConfig removes the file", async () => {
    await saveConfig({ region: "us-east-1" });
    expect(await clearConfig()).toBe(true);
    expect(await loadConfig()).toEqual({});
  });

  it("ignores corrupt JSON gracefully", async () => {
    await fs.writeFile(configPath(), "{not json", "utf8");
    expect(await loadConfig()).toEqual({});
  });

  it("rejects unknown schema and returns empty", async () => {
    await fs.writeFile(
      configPath(),
      JSON.stringify({ region: 123 }, null, 2),
      "utf8",
    );
    expect(await loadConfig()).toEqual({});
  });
});

describe("local token file", () => {
  let dir: string;
  let originalCwd: string;
  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await fs.mkdtemp(join(tmpdir(), "dash0-tok-"));
    process.chdir(dir);
    delete process.env.DASH0_LAMBDA_CONFIG;
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the token at chmod 0600 and re-reads it", async () => {
    const token = "auth_" + "a".repeat(40);
    const r = await saveTokenLocally(token);
    expect(r.absolutePath).toMatch(/\.dash0-lambda\.token$/);
    const stat = await fs.stat(r.absolutePath);
    // POSIX: bottom 9 bits should be 0o600
    expect(stat.mode & 0o777).toBe(0o600);
    const back = await loadLocalToken(r.configRelativePath);
    expect(back).toBe(token);
  });

  it("appends to .gitignore if one exists", async () => {
    await fs.writeFile(".gitignore", "node_modules/\n", "utf8");
    const token = "auth_" + "a".repeat(40);
    await saveTokenLocally(token);
    const gi = await fs.readFile(".gitignore", "utf8");
    expect(gi).toMatch(/\.dash0-lambda\.token/);
  });

  it("does not create .gitignore when none exists", async () => {
    const token = "auth_" + "b".repeat(40);
    await saveTokenLocally(token);
    await expect(fs.access(".gitignore")).rejects.toThrow();
  });
});

describe("defaultSecretName", () => {
  it("uses the dataset when provided", () => {
    expect(defaultSecretName({ region: "us-west-2", dataset: "prod" })).toBe(
      "dash0/lambda-extension/prod",
    );
  });
  it("falls back to a stable base", () => {
    expect(defaultSecretName({ region: "us-west-2" })).toBe(
      "dash0/lambda-extension",
    );
  });
});
