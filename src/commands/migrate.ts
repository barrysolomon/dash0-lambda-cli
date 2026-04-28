/**
 * `dash0-lambda migrate` — replace a Lumigo footprint on one or more
 * functions with the Dash0 extension. Builds on `install` but pre-strips
 * Lumigo layers + env vars so the swap is atomic from the function's POV.
 *
 * Bulk usage:
 *   dash0-lambda migrate --filter '^orders-' --concurrency 4 ...
 *
 * Always prints a plan first. Apply requires --yes (or interactive Y/N
 * if a TTY is attached and --yes wasn't passed).
 */

import { LambdaWrapper } from "../lib/lambda.js";
import {
  buildLayerArn,
  CANONICAL_OWNER_ACCOUNT,
  familyForRuntime,
  KNOWN_LATEST_LAYER_VERSION,
  type RuntimeFamily,
  wrapperPathFor,
} from "../lib/layers.js";
import { configToEnv, Dash0InstallConfigSchema } from "../lib/env.js";
import { buildMigrationPlan, hasLumigoFootprint } from "../lib/lumigo.js";
import { ValidationError, asCliError } from "../lib/errors.js";
import { c, fail, info, ok, warn } from "../lib/output.js";

export interface MigrateOptions {
  region: string;
  endpoint: string;
  token?: string;
  tokenSecretArn?: string;
  dataset?: string;
  /** Single function. Mutually exclusive with --filter. */
  function?: string;
  /** Regex filter applied to function names. */
  filter?: string;
  concurrency?: number;
  yes?: boolean;
  dryRun?: boolean;
  layerVersion?: number;
  layerOwner?: string;
  lambda?: LambdaWrapper;
}

export interface MigrationOutcome {
  function: string;
  status: "migrated" | "skipped" | "failed" | "planned";
  message?: string;
}

export async function migrate(
  opts: MigrateOptions,
): Promise<MigrationOutcome[]> {
  if (opts.function && opts.filter) {
    throw new ValidationError(
      "use either --function or --filter, not both",
    );
  }
  if (!opts.function && !opts.filter) {
    throw new ValidationError("provide --function NAME or --filter REGEX");
  }
  // Validate Dash0 install config up front — fail before touching anything.
  const cfg = Dash0InstallConfigSchema.parse({
    endpoint: opts.endpoint,
    token: opts.token,
    tokenSecretArn: opts.tokenSecretArn,
    dataset: opts.dataset,
  });

  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });

  // 1. Resolve target list.
  const targets = await selectTargets(lambda, opts);
  if (targets.length === 0) {
    info(`No matching functions in ${opts.region}.`);
    return [];
  }

  // 2. Build per-function plans.
  const plans = await Promise.all(
    targets.map(async (fn) => {
      const family = familyForRuntime(fn.runtime);
      const ownerAccount = opts.layerOwner ?? CANONICAL_OWNER_ACCOUNT;
      // Static known version by default; --layer-version to override.
      // See KNOWN_LATEST_LAYER_VERSION docstring for why we don't list.
      const version =
        opts.layerVersion ?? KNOWN_LATEST_LAYER_VERSION[family];
      const layerArn = buildLayerArn({
        region: opts.region,
        ownerAccount,
        family,
        version,
      });
      const plan = buildMigrationPlan(fn);
      return { fn, plan, family, layerArn };
    }),
  );

  // 3. Print summary.
  console.log(c.bold(`\nMigration plan: ${plans.length} function(s)`));
  for (const p of plans) {
    const lumigoLayers = p.plan.lumigo.layers.length;
    const lumigoEnv = Object.keys(p.plan.lumigo.env).length;
    const tag = hasLumigoFootprint(p.plan.lumigo)
      ? c.yellow(`Lumigo: ${lumigoLayers} layer(s), ${lumigoEnv} env var(s)`)
      : c.dim("no Lumigo detected");
    console.log(`  • ${c.bold(p.fn.functionName)} (${p.fn.runtime} → ${p.family}) — ${tag}`);
    for (const w of p.plan.warnings) console.log(`    ${c.yellow("!")} ${w}`);
  }
  console.log("");

  // 4. Confirm.
  if (opts.dryRun) {
    info("Dry-run: nothing will change.");
    return plans.map((p) => ({
      function: p.fn.functionName,
      status: "planned",
    }));
  }
  if (!opts.yes && process.stdin.isTTY) {
    const confirmed = await confirm("Apply this plan?");
    if (!confirmed) {
      info("Aborted.");
      return plans.map((p) => ({ function: p.fn.functionName, status: "skipped" }));
    }
  } else if (!opts.yes && !opts.dryRun) {
    throw new ValidationError(
      "Refusing to apply without --yes in a non-interactive session.",
    );
  }

  // 5. Apply with bounded concurrency.
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const outcomes: MigrationOutcome[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= plans.length) return;
      const { fn, plan, family, layerArn } = plans[i]!;
      const wrapper = wrapperPathFor(family);
      const desiredEnv: Record<string, string> = {
        ...plan.envToKeep,
        ...configToEnv(cfg),
      };
      if (wrapper) desiredEnv.AWS_LAMBDA_EXEC_WRAPPER = wrapper;
      const desiredLayers = [
        layerArn,
        ...plan.layersToKeep.map((l) => l.Arn ?? ""),
      ].filter(Boolean);

      try {
        const result = await lambda.updateFunctionConfig({
          name: fn.functionName,
          layerArns: desiredLayers,
          env: desiredEnv,
        });
        if (result.applied) {
          ok(`migrated ${fn.functionName}`);
          outcomes.push({ function: fn.functionName, status: "migrated" });
        } else {
          outcomes.push({
            function: fn.functionName,
            status: "skipped",
            message: result.reason,
          });
        }
      } catch (err) {
        const msg = (err as Error).message;
        fail(`${fn.functionName}: ${msg}`);
        outcomes.push({
          function: fn.functionName,
          status: "failed",
          message: msg,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const migrated = outcomes.filter((o) => o.status === "migrated").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  console.log("");
  if (failed === 0) ok(`${migrated} function(s) migrated.`);
  else warn(`${migrated} migrated, ${failed} failed.`);
  return outcomes;
}

async function selectTargets(
  lambda: LambdaWrapper,
  opts: MigrateOptions,
) {
  if (opts.function) {
    return [await lambda.getFunction(opts.function)];
  }
  const re = new RegExp(opts.filter!);
  const matches = [];
  for await (const fn of lambda.listFunctions()) {
    if (re.test(fn.functionName)) matches.push(fn);
  }
  return matches;
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(`${prompt} [y/N] `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const ans = chunk.toString().trim().toLowerCase();
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(ans === "y" || ans === "yes");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
