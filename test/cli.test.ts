/**
 * Wiring tests for the commander program. We import the built program
 * WITHOUT running it (cli.ts only auto-parses when invoked as the binary)
 * and inspect how options resolve their defaults. This lets us assert
 * env-var backing without touching AWS or running an action.
 *
 * Each case sets process.env before a fresh import: commander captures an
 * option's env-backed default at the moment the .option() line executes
 * (program build time), so vi.resetModules() + a fresh import is required
 * to re-evaluate it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

const ENV_ARN =
  "arn:aws:secretsmanager:eu-west-1:211125505488:secret:dash0/token-AbCdEf";

async function loadCommand(name: string): Promise<Command> {
  vi.resetModules();
  const { program } = await import("../src/cli.js");
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

function arnDefault(cmd: Command): unknown {
  const opt = cmd.options.find((o) => o.attributeName() === "tokenSecretArn");
  if (!opt) throw new Error("no --token-secret-arn option");
  return opt.defaultValue;
}

afterEach(() => {
  delete process.env.DASH0_TOKEN_SECRET_ARN;
});

describe("--token-secret-arn env backing", () => {
  it("install defaults --token-secret-arn from DASH0_TOKEN_SECRET_ARN", async () => {
    process.env.DASH0_TOKEN_SECRET_ARN = ENV_ARN;
    expect(arnDefault(await loadCommand("install"))).toBe(ENV_ARN);
  });

  it("migrate defaults --token-secret-arn from DASH0_TOKEN_SECRET_ARN", async () => {
    process.env.DASH0_TOKEN_SECRET_ARN = ENV_ARN;
    expect(arnDefault(await loadCommand("migrate"))).toBe(ENV_ARN);
  });

  it("leaves the default undefined when the env var is unset", async () => {
    delete process.env.DASH0_TOKEN_SECRET_ARN;
    expect(arnDefault(await loadCommand("install"))).toBeUndefined();
  });
});
