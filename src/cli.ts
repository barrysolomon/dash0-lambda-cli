#!/usr/bin/env node
// dash0-lambda-cli · © 2026 Barry Solomon · Apache-2.0
// Unofficial; not affiliated with Dash0 Inc.
/**
 * dash0-lambda — manage the Dash0 Lambda extension across your AWS account.
 *
 * Subcommands:
 *   install      attach the layer + set env vars on a function
 *   uninstall    remove the layer + DASH0_* env vars
 *   validate     health-check a function (alias: doctor)
 *   list         list functions and their Dash0/Lumigo footprint (alias: status)
 *   migrate      replace Lumigo with Dash0 on one or many functions
 *   generate     emit IaC snippets (terraform | cloudformation | sam | cdk-ts | serverless)
 *
 * Global flags resolve from (in order): explicit --flag → env var → default.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { validate } from "./commands/validate.js";
import { list } from "./commands/list.js";
import { migrate } from "./commands/migrate.js";
import { generate, type IacFlavor } from "./commands/generate.js";
import { switchVendor } from "./commands/switchVendor.js";
import { updateLayer } from "./commands/updateLayer.js";
import { secretShow } from "./commands/secret.js";
import type { Vendor } from "./lib/vendor.js";
import { CliError } from "./lib/errors.js";
import { fail, info } from "./lib/output.js";
import {
  KNOWN_LATEST_LAYER_VERSION,
  RUNTIME_FAMILIES,
  type RuntimeFamily,
} from "./lib/layers.js";
import { promptDash0Token } from "./lib/prompt.js";
import { negatableFlag } from "./lib/env.js";
import { runTui } from "./tui/index.js";

export const program = new Command();

program
  .name("dash0-lambda")
  .description(
    "Manage the Dash0 Lambda extension: install, update, validate, migrate from Lumigo, " +
      "switch vendors, and generate IaC. Run with no arguments to launch the interactive TUI.",
  )
  .version(pkg.version)
  .showHelpAfterError("(use --help for command usage)");

// ─────────────────────────── menu ───────────────────────────
program
  .command("menu", { isDefault: true })
  .description("Launch the interactive menu (default when no subcommand given)")
  .action(async () => {
    await runTui();
  });

// ─────────────────────────── install ───────────────────────────
program
  .command("install")
  .description("Attach the Dash0 layer and set DASH0_* env vars on a function")
  .requiredOption("-f, --function <name>", "Lambda function name or ARN")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .requiredOption(
    "-e, --endpoint <url>",
    "Dash0 OTLP endpoint (e.g. https://ingress.us-west-2.aws.dash0.com:4318)",
    process.env.DASH0_ENDPOINT,
  )
  // Auth
  .option("-t, --token <token>", "Dash0 auth token", process.env.DASH0_TOKEN)
  .option(
    "--token-secret-arn <arn>",
    "Secrets Manager ARN holding the token (preferred for prod)",
    process.env.DASH0_TOKEN_SECRET_ARN,
  )
  .option(
    "--token-secret-key <key>",
    "JSON key inside the secret if it holds an object",
  )
  .addOption(
    new Option(
      "--auth-mode <mode>",
      "Pin auth mode and clear the other env var on the function (token wins silently if both are set)",
    ).choices(["token", "secret"]),
  )
  .option(
    "--no-grant-secret-access",
    "With secret auth, don't attach the secretsmanager:GetSecretValue policy to the function's execution role",
  )
  // Common
  .option("-d, --dataset <name>", "Routes telemetry to a Dash0 dataset")
  .option(
    "--service-name <name>",
    "Sets OTEL_SERVICE_NAME on the function",
  )
  .addOption(
    new Option(
      "--extension-log-level <level>",
      "Extension log level (DASH0_EXTENSION_LOG_LEVEL)",
    ).choices(["trace", "debug", "info", "warn", "error"]),
  )
  .option("--distro-debug", "Enable verbose distro debug logs")
  .option(
    "--disable-auto-instrumentation",
    "Disable auto-instrumentation; the extension only emits synthetic traces",
  )
  .option(
    "--no-send-on-invocation-end",
    "Send telemetry on next invocation instead of on invocation end",
  )
  .option(
    "--xray-traces-enabled",
    "Set when AWS X-Ray active tracing is enabled on the function",
  )
  .option(
    "--no-create-payload-log-records",
    "Disable per-invocation request/response payload log records",
  )
  .option(
    "--disable-telemetry-log-collection",
    "Stop collecting logs from the Lambda Telemetry API",
  )
  .option(
    "--request-timeout-ms <ms>",
    "HTTP request timeout for OTLP exports",
    (v) => parseInt(v, 10),
  )
  // Masking
  .option(
    "--mask-rules <json>",
    "JSON array of regex patterns; replaces the default mask rules",
    parseJsonArray,
  )
  .option("--mask-env-vars <json>", "JSON array of regex patterns", parseJsonArray)
  .option("--mask-request-body <json>", "JSON array", parseJsonArray)
  .option("--mask-request-headers <json>", "JSON array", parseJsonArray)
  .option("--mask-response-body <json>", "JSON array", parseJsonArray)
  .option("--mask-response-headers <json>", "JSON array", parseJsonArray)
  .option("--mask-query-params <json>", "JSON array", parseJsonArray)
  // Resource & escape hatches
  .option(
    "--resource-attribute <key=value...>",
    "Extra OTEL_RESOURCE_ATTRIBUTES (repeatable)",
  )
  .option(
    "--env <key=value...>",
    "Set arbitrary env vars on the function (repeatable). Applied last; can override anything above.",
  )
  // Layer overrides
  .addOption(
    new Option(
      "--family <family>",
      "Force a runtime family (skip auto-detect)",
    ).choices([...RUNTIME_FAMILIES]),
  )
  .option("--layer-version <n>", "Pin a layer version", parseInt)
  .option(
    "--layer-owner <account>",
    "Override the layer publisher account (12 digits)",
    process.env.DASH0_LAYER_OWNER_ACCOUNT,
  )
  .option("--dry-run", "Print plan without applying")
  .action(async (rawOpts) => {
    // If neither --token nor --token-secret-arn given, prompt interactively.
    let token = rawOpts.token as string | undefined;
    if (!token && !rawOpts.tokenSecretArn) {
      info(
        "No token or --token-secret-arn provided. Enter a Dash0 token (input will be hidden):",
      );
      token = await promptDash0Token();
    }
    await install({
      function: rawOpts.function,
      region: rawOpts.region,
      endpoint: rawOpts.endpoint,
      token,
      tokenSecretArn: rawOpts.tokenSecretArn,
      tokenSecretKey: rawOpts.tokenSecretKey,
      authMode: rawOpts.authMode as "token" | "secret" | undefined,
      dataset: rawOpts.dataset,
      serviceName: rawOpts.serviceName,
      extensionLogLevel: rawOpts.extensionLogLevel,
      distroDebug: rawOpts.distroDebug,
      disableAutoInstrumentation: rawOpts.disableAutoInstrumentation,
      // These are --no-* negatable flags. Commander defaults them to `true`
      // when absent, which would emit a redundant env var equal to the
      // extension's own default (wasting the 4KB env budget). negatableFlag
      // forwards `false` only when the user explicitly opted out.
      sendOnInvocationEnd: negatableFlag(rawOpts.sendOnInvocationEnd),
      xrayTracesEnabled: rawOpts.xrayTracesEnabled,
      createPayloadLogRecords: negatableFlag(rawOpts.createPayloadLogRecords),
      disableTelemetryLogCollection: rawOpts.disableTelemetryLogCollection,
      requestTimeoutMs: rawOpts.requestTimeoutMs,
      maskRules: rawOpts.maskRules,
      maskEnvVars: rawOpts.maskEnvVars,
      maskRequestBody: rawOpts.maskRequestBody,
      maskRequestHeaders: rawOpts.maskRequestHeaders,
      maskResponseBody: rawOpts.maskResponseBody,
      maskResponseHeaders: rawOpts.maskResponseHeaders,
      maskQueryParams: rawOpts.maskQueryParams,
      resourceAttributes: parseKeyValues(rawOpts.resourceAttribute),
      extraEnv: parseKeyValues(rawOpts.env),
      family: rawOpts.family as RuntimeFamily | undefined,
      layerVersion: rawOpts.layerVersion,
      layerOwner: rawOpts.layerOwner,
      // Commander sets grantSecretAccess=true unless --no-grant-secret-access
      // is passed. Only relevant when installing with secret auth.
      grantSecretAccess: rawOpts.grantSecretAccess,
      dryRun: rawOpts.dryRun,
    });
  });

// ─────────────────────────── uninstall ───────────────────────────
program
  .command("uninstall")
  .description("Remove the Dash0 layer and DASH0_* env vars from a function")
  .requiredOption("-f, --function <name>", "Lambda function name or ARN")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .option(
    "--clear-wrapper",
    "Also delete AWS_LAMBDA_EXEC_WRAPPER if it points at /opt/wrapper",
  )
  .option("--dry-run", "Print plan without applying")
  .action(async (rawOpts) => {
    await uninstall({
      function: rawOpts.function,
      region: rawOpts.region,
      clearWrapper: rawOpts.clearWrapper,
      dryRun: rawOpts.dryRun,
    });
  });

// ─────────────────────────── validate / doctor ───────────────────────────
program
  .command("validate")
  .alias("doctor")
  .description("Health-check a function's Dash0 wiring")
  .requiredOption("-f, --function <name>", "Lambda function name or ARN")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .option(
    "--check-logs",
    "Also tail recent CloudWatch logs to confirm the extension started",
  )
  .option(
    "--logs-lookback <minutes>",
    "How far back to look at logs",
    (v) => parseInt(v, 10) * 60_000,
    15 * 60_000,
  )
  .option("--layer-owner <account>", "Override the layer publisher account")
  .option(
    "--no-check-secret",
    "Skip Secrets Manager / IAM reachability checks for DASH0_TOKEN_SECRET_ARN",
  )
  .option(
    "--show-token",
    "Print the resolved token (redacted) — pass --reveal-token to see it in full",
  )
  .option("--reveal-token", "When --show-token is set, print the full token")
  .option(
    "--fix-secret-access",
    "If the function role can't read its token secret, attach the secretsmanager:GetSecretValue policy to it (writes IAM)",
  )
  .action(async (rawOpts) => {
    const result = await validate({
      function: rawOpts.function,
      region: rawOpts.region,
      checkLogs: rawOpts.checkLogs,
      logsLookbackMs: rawOpts.logsLookback,
      layerOwner: rawOpts.layerOwner,
      checkSecret: rawOpts.checkSecret,
      fixSecretAccess: rawOpts.fixSecretAccess,
      showToken: rawOpts.showToken,
      revealToken: rawOpts.revealToken,
    });
    if (!result.pass) process.exitCode = 4;
  });

// ─────────────────────────── secret show ───────────────────────────
const secret = program
  .command("secret")
  .description("Inspect Secrets Manager values backing DASH0_TOKEN_SECRET_ARN");

secret
  .command("show")
  .description("Read and print the Dash0 token from a function's secret")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .option("-f, --function <name>", "Function whose DASH0_TOKEN_SECRET_ARN to read")
  .option("--secret-arn <arn>", "Read this secret directly (skip the function lookup)")
  .option("--secret-key <key>", "JSON key inside the secret (default: from function env)")
  .option("--reveal", "Print the full token instead of a redacted preview")
  .action(async (rawOpts) => {
    await secretShow({
      region: rawOpts.region,
      function: rawOpts.function,
      secretArn: rawOpts.secretArn,
      secretKey: rawOpts.secretKey,
      reveal: rawOpts.reveal,
    });
  });

// ─────────────────────────── list / status ───────────────────────────
program
  .command("list")
  .alias("status")
  .description("List functions and their Dash0/Lumigo footprint")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .option("--filter <substr>", "Substring filter on function name")
  .option("--only-dash0", "Only functions with Dash0 attached")
  .option("--only-lumigo", "Only functions running Lumigo")
  .addOption(
    new Option("--format <fmt>", "Output format")
      .choices(["table", "json", "yaml"])
      .default("table"),
  )
  .action(async (rawOpts) => {
    await list({
      region: rawOpts.region,
      filter: rawOpts.filter,
      onlyDash0: rawOpts.onlyDash0,
      onlyLumigo: rawOpts.onlyLumigo,
      format: rawOpts.format,
    });
  });

// ─────────────────────────── migrate ───────────────────────────
program
  .command("migrate")
  .description("Replace Lumigo with Dash0 on one or many functions")
  .option("-f, --function <name>", "Single function (mutually exclusive with --filter)")
  .option("--filter <regex>", "Regex of function names to migrate")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .requiredOption(
    "-e, --endpoint <url>",
    "Dash0 OTLP endpoint",
    process.env.DASH0_ENDPOINT,
  )
  .option("-t, --token <token>", "Dash0 auth token", process.env.DASH0_TOKEN)
  .option(
    "--token-secret-arn <arn>",
    "Secrets Manager ARN holding the token",
    process.env.DASH0_TOKEN_SECRET_ARN,
  )
  .option("-d, --dataset <name>", "Dash0 dataset")
  .option(
    "-c, --concurrency <n>",
    "Max concurrent updates",
    (v) => parseInt(v, 10),
    4,
  )
  .option("--layer-version <n>", "Pin a layer version", parseInt)
  .option("--layer-owner <account>", "Override the layer publisher account")
  .option("-y, --yes", "Skip the confirmation prompt")
  .option("--dry-run", "Print plan without applying")
  .action(async (rawOpts) => {
    let token = rawOpts.token as string | undefined;
    if (!token && !rawOpts.tokenSecretArn) {
      info(
        "No token or --token-secret-arn provided. Enter a Dash0 token (input will be hidden):",
      );
      token = await promptDash0Token();
    }
    const outcomes = await migrate({
      function: rawOpts.function,
      filter: rawOpts.filter,
      region: rawOpts.region,
      endpoint: rawOpts.endpoint,
      token,
      tokenSecretArn: rawOpts.tokenSecretArn,
      dataset: rawOpts.dataset,
      concurrency: rawOpts.concurrency,
      layerVersion: rawOpts.layerVersion,
      layerOwner: rawOpts.layerOwner,
      yes: rawOpts.yes,
      dryRun: rawOpts.dryRun,
    });
    const failed = outcomes.filter((o) => o.status === "failed").length;
    if (failed > 0) process.exitCode = 5;
  });



// ─────────────────────────── update (layer-only) ──────────────────
program
  .command("update")
  .description(
    "Bump the attached Dash0 layer to the CLI's known-current version (env vars and other layers untouched)",
  )
  .requiredOption("-f, --function <name>", "Lambda function name or ARN")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .option("--layer-version <n>", "Pin a target version", parseInt)
  .option("--layer-owner <account>", "Override the layer publisher account")
  .option("--dry-run", "Print plan without applying")
  .action(async (rawOpts) => {
    await updateLayer({
      function: rawOpts.function,
      region: rawOpts.region,
      layerVersion: rawOpts.layerVersion,
      layerOwner: rawOpts.layerOwner,
      dryRun: rawOpts.dryRun,
    });
  });

// ─────────────────────────── switch (Dash0 ↔ Lumigo) ──────────────
program
  .command("switch")
  .description(
    "Toggle a function between Dash0 and Lumigo by changing AWS_LAMBDA_EXEC_WRAPPER (no layer changes)",
  )
  .requiredOption("-f, --function <name>", "Lambda function name or ARN")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .addOption(
    new Option(
      "-t, --to <vendor>",
      "Target vendor — both layers must already be attached",
    )
      .choices(["dash0", "lumigo"])
      .makeOptionMandatory(),
  )
  .option("--dry-run", "Print plan without applying")
  .action(async (rawOpts) => {
    await switchVendor({
      function: rawOpts.function,
      region: rawOpts.region,
      target: rawOpts.to as Vendor,
      dryRun: rawOpts.dryRun,
    });
  });

// ─────────────────────────── generate ───────────────────────────
program
  .command("generate <flavor>")
  .description("Emit IaC snippets: terraform | cloudformation | sam | cdk-ts | serverless")
  .requiredOption("-r, --region <region>", "AWS region", process.env.AWS_REGION)
  .addOption(
    new Option("--family <family>", "Runtime family")
      .choices([...RUNTIME_FAMILIES])
      .default("node"),
  )
  .option(
    "--layer-version <n>",
    "Layer version to pin (defaults to the CLI's known-latest)",
    parseInt,
  )
  .option("--layer-owner <account>", "Override the layer publisher account")
  .requiredOption("-e, --endpoint <url>", "Dash0 OTLP endpoint")
  .option("--token-from-ssm <path>", "SSM parameter path holding the token")
  .option("-t, --token <token>", "Literal token (discouraged)")
  .option("-d, --dataset <name>", "Dash0 dataset")
  .action(async (flavor: string, rawOpts) => {
    const family = rawOpts.family as RuntimeFamily;
    const out = generate({
      flavor: flavor as IacFlavor,
      region: rawOpts.region,
      family,
      layerVersion:
        rawOpts.layerVersion ?? KNOWN_LATEST_LAYER_VERSION[family],
      layerOwner: rawOpts.layerOwner,
      endpoint: rawOpts.endpoint,
      tokenFromSsm: rawOpts.tokenFromSsm,
      token: rawOpts.token,
      dataset: rawOpts.dataset,
    });
    process.stdout.write(out);
  });

// ─────────────────────────── helpers ───────────────────────────
function parseKeyValues(arr?: string[]): Record<string, string> | undefined {
  if (!arr || arr.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of arr) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error("expected a JSON array of strings");
    }
    return v;
  } catch (err) {
    throw new Error(
      `invalid JSON array: ${(err as Error).message}. Example: '[".*token.*"]'`,
    );
  }
}

// ─────────────────────────── main ───────────────────────────
/**
 * Only auto-run when invoked as the binary, not when imported (e.g. by
 * tests inspecting option wiring).
 *
 * Bun single-file executables (our primary distribution artifact) mount the
 * source in a virtual filesystem at /$bunfs/..., so process.argv[1] can't be
 * realpath'd — realpathSync throws ENOENT and the old comparison always
 * returned false, leaving the compiled binary inert. import.meta.main is the
 * reliable signal there (Bun always sets it; Node exposes it from v24). We
 * keep the realpathSync comparison as the fallback for Node < 24, where it
 * still resolves the npm bin symlink for a globally-installed CLI.
 */
function isDirectRun(): boolean {
  const metaMain = (import.meta as { main?: boolean }).main;
  if (typeof metaMain === "boolean") return metaMain;

  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  program.parseAsync(process.argv).catch((err) => {
    if (err instanceof CliError) {
      fail(err.message);
      process.exit(err.exitCode);
    }
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
