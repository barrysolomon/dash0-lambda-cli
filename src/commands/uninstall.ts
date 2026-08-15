/**
 * `dash0-lambda uninstall` — remove the Dash0 extension layer and DASH0_*
 * env vars from a function. Leaves everything else (including
 * AWS_LAMBDA_EXEC_WRAPPER if the customer set it for some other reason).
 */

import { LambdaWrapper } from "../lib/lambda.js";
import { parseDash0LayerArn } from "../lib/layers.js";
import { stripDash0Keys } from "../lib/env.js";
import { asCliError } from "../lib/errors.js";
import { c, info, ok, warn } from "../lib/output.js";

/** The only AWS_LAMBDA_EXEC_WRAPPER value Dash0 owns. */
const DASH0_WRAPPER = "/opt/wrapper";

export interface UninstallOptions {
  function: string;
  region: string;
  dryRun?: boolean;
  /** Also clear AWS_LAMBDA_EXEC_WRAPPER if it points at /opt/wrapper. */
  clearWrapper?: boolean;
  lambda?: LambdaWrapper;
}

export async function uninstall(opts: UninstallOptions): Promise<{
  applied: boolean;
  removedLayers: string[];
  envBefore: Record<string, string>;
  envAfter: Record<string, string>;
}> {
  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });
  const fn = await lambda.getFunction(opts.function).catch((err) => {
    throw asCliError(err, `failed to fetch function ${opts.function}`);
  });

  const removedLayers: string[] = [];
  const remainingLayers: string[] = [];
  for (const l of fn.layers) {
    const arn = l.Arn ?? "";
    if (!arn) continue;
    if (parseDash0LayerArn(arn) !== null) removedLayers.push(arn);
    else remainingLayers.push(arn);
  }

  const envAfter = stripDash0Keys(fn.env);

  // AWS_LAMBDA_EXEC_WRAPPER is in DASH0_ENV_KEYS because *install* owns it,
  // so stripDash0Keys() just deleted it unconditionally. But only the exact
  // value "/opt/wrapper" is Dash0's. Anything else — Lumigo's Java tracer
  // (/opt/lumigo_wrapper) or a customer's own shim — belongs to somebody we
  // were not asked to uninstall. Deleting it would silently un-instrument a
  // vendor this command never touched, so put it back.
  const currentWrapper = fn.env.AWS_LAMBDA_EXEC_WRAPPER;
  const wrapperIsDash0s = currentWrapper === DASH0_WRAPPER;
  const clearingOurWrapper = wrapperIsDash0s && opts.clearWrapper === true;
  if (currentWrapper !== undefined && !clearingOurWrapper) {
    envAfter.AWS_LAMBDA_EXEC_WRAPPER = currentWrapper;
  }
  // Dash0's own wrapper kept while its layer goes away: the function will
  // hard-fail on the next invocation, so say so.
  const danglingWrapper = wrapperIsDash0s && !clearingOurWrapper;

  console.log("");
  console.log(c.bold(`Uninstall plan for ${opts.function}`));
  console.log(`  layers to remove: ${removedLayers.length}`);
  for (const l of removedLayers) console.log(`    - ${l}`);
  const removedEnvKeys = Object.keys(fn.env).filter((k) => !(k in envAfter));
  console.log(`  env vars to remove: ${removedEnvKeys.length}`);
  for (const k of removedEnvKeys) console.log(`    - ${k}`);
  console.log("");

  if (removedLayers.length === 0 && removedEnvKeys.length === 0) {
    info(`No Dash0 footprint found on ${opts.function}. Nothing to do.`);
    return { applied: false, removedLayers, envBefore: fn.env, envAfter };
  }

  if (danglingWrapper) {
    warn(
      "AWS_LAMBDA_EXEC_WRAPPER is still set to /opt/wrapper but the layer " +
        "providing it is being removed. The function will fail at next invocation. " +
        "Re-run with --clear-wrapper to delete this env var as well.",
    );
  }

  const result = await lambda
    .updateFunctionConfig({
      name: opts.function,
      layerArns: remainingLayers,
      env: envAfter,
    })
    .catch((err) => {
      throw asCliError(err, `failed to update function ${opts.function}`);
    });

  if (result.applied) {
    ok(`Dash0 extension removed from ${c.bold(opts.function)}`);
  } else {
    warn(`Dry-run: nothing changed.`);
  }
  return {
    applied: result.applied,
    removedLayers,
    envBefore: fn.env,
    envAfter,
  };
}
