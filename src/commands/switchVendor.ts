/**
 * `dash0-lambda switch` — flip a Lambda function (or many) between
 * Dash0 and Lumigo by changing AWS_LAMBDA_EXEC_WRAPPER. Layers must
 * already be attached for both vendors; this is a wrapper toggle, not
 * an installer.
 */

import { LambdaWrapper } from "../lib/lambda.js";
import { applyPlan, buildSwitchPlan, type Vendor } from "../lib/vendor.js";
import { CliError, asCliError } from "../lib/errors.js";
import { c, fail, info, ok, warn } from "../lib/output.js";

export interface SwitchOptions {
  function: string;
  region: string;
  target: Vendor;
  dryRun?: boolean;
  lambda?: LambdaWrapper;
}

export interface SwitchResult {
  function: string;
  applied: boolean;
  blocker?: string;
  changes: Array<[string, string | undefined, string | undefined]>;
}

export async function switchVendor(opts: SwitchOptions): Promise<SwitchResult> {
  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });

  const fn = await lambda.getFunction(opts.function).catch((err) => {
    throw asCliError(err, `failed to fetch function ${opts.function}`);
  });
  const plan = buildSwitchPlan(fn, opts.target);

  console.log("");
  console.log(c.bold(`Switch plan for ${opts.function}`));
  console.log(`  runtime:        ${fn.runtime}`);
  console.log(`  target vendor:  ${opts.target}`);
  console.log(`  current wrapper: ${fn.env.AWS_LAMBDA_EXEC_WRAPPER ?? "(unset)"}`);
  console.log(
    `  target wrapper:  ${plan.targetWrapper ?? "(unset — Lumigo Node/Python auto-load)"}`,
  );

  if (plan.blocker) {
    fail(plan.blocker);
    throw new CliError(plan.blocker, 6);
  }
  if (plan.envChanges.length === 0) {
    info(`Already on ${opts.target}. Nothing to change.`);
    return { function: opts.function, applied: false, changes: [] };
  }

  console.log(`  env changes:`);
  for (const [k, before, after] of plan.envChanges) {
    if (before === undefined && after !== undefined) {
      console.log(`    ${c.green("+")} ${k}=${after}`);
    } else if (before !== undefined && after === undefined) {
      console.log(`    ${c.red("-")} ${k} (was ${before})`);
    } else {
      console.log(`    ${c.yellow("~")} ${k}: ${before ?? "(unset)"} → ${after ?? "(unset)"}`);
    }
  }
  for (const w of plan.warnings) warn(w);
  console.log("");

  const desiredEnv = applyPlan(fn.env, plan);
  const result = await lambda
    .updateFunctionConfig({
      name: opts.function,
      layerArns: fn.layers.map((l) => l.Arn ?? "").filter(Boolean),
      env: desiredEnv,
    })
    .catch((err) => {
      throw asCliError(err, `failed to update function ${opts.function}`);
    });

  if (result.applied) {
    ok(`Switched ${c.bold(opts.function)} → ${opts.target}`);
  } else {
    warn(`Dry-run: nothing changed.`);
  }
  return {
    function: opts.function,
    applied: result.applied,
    changes: plan.envChanges,
  };
}
