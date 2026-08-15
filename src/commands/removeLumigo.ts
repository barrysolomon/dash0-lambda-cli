/**
 * `dash0-lambda remove-lumigo` — untrace Lumigo from one function or a
 * whole fleet: drop the Lumigo tracer layer, the LUMIGO_* env vars, and
 * the Lumigo exec wrapper.
 *
 * Unlike `migrate`, this does NOT install Dash0 — it just removes Lumigo.
 * Use it to decommission Lumigo on functions you've already moved, or to
 * clean up a half-migrated fleet.
 *
 * Detection is delegated wholesale to detectLumigo() so the publisher-account
 * layer regex and the LUMIGO_* key allowlist live in exactly one place.
 *
 * **Why the wrapper is cleared by default** (unlike `uninstall`, where it's
 * behind --clear-wrapper): Lumigo's wrapper exists solely to load Lumigo, so
 * leaving it behind after removing the layer is a guaranteed cold-start
 * failure. Dash0's /opt/wrapper is a different story, which is why
 * detectLumigo only reports a wrapper it can positively identify as Lumigo's.
 *
 * **Why --filter is gated harder than migrate's**: a mis-scoped `migrate`
 * leaves functions instrumented with Dash0, but a mis-scoped `remove-lumigo`
 * leaves them with no tracing at all. Same --yes / TTY guards, but the plan
 * is always printed first.
 */

import { LambdaWrapper } from "../lib/lambda.js";
import type { FunctionSnapshot } from "../lib/lambda.js";
import { detectLumigo } from "../lib/lumigo.js";
import { ValidationError, asCliError } from "../lib/errors.js";
import { c, fail, info, ok, warn } from "../lib/output.js";
import { confirm } from "../lib/prompt.js";

export interface RemoveLumigoOptions {
  region: string;
  /** Single function. Mutually exclusive with --filter. */
  function?: string;
  /** Regex filter applied to function names. */
  filter?: string;
  concurrency?: number;
  yes?: boolean;
  dryRun?: boolean;
  /** Preserve LUMIGO_* env vars (e.g. planning to re-attach Lumigo later). */
  keepEnv?: boolean;
  lambda?: LambdaWrapper;
}

export interface RemoveLumigoOutcome {
  function: string;
  status: "removed" | "skipped" | "failed";
  message?: string;
  applied: boolean;
  removedLayers: string[];
  removedEnvKeys: string[];
  /** The Lumigo wrapper value that was cleared, if any. */
  clearedWrapper?: string;
  envBefore: Record<string, string>;
  envAfter: Record<string, string>;
}

/** Pure planning step — what would change on this one function. */
interface Plan {
  fn: FunctionSnapshot;
  remainingLayers: string[];
  removedLayers: string[];
  removedEnvKeys: string[];
  envAfter: Record<string, string>;
  clearedWrapper?: string;
}

function buildPlan(fn: FunctionSnapshot, keepEnv: boolean): Plan {
  const footprint = detectLumigo(fn);
  const lumigoLayers = new Set(footprint.layers);

  const removedLayers: string[] = [];
  const remainingLayers: string[] = [];
  for (const l of fn.layers) {
    const arn = l.Arn ?? "";
    if (!arn) continue;
    if (lumigoLayers.has(arn)) removedLayers.push(arn);
    else remainingLayers.push(arn);
  }

  const envAfter = { ...fn.env };
  if (!keepEnv) {
    for (const k of Object.keys(footprint.env)) delete envAfter[k];
  }
  // Only ever clears a wrapper detectLumigo positively identified as Lumigo's;
  // a Dash0 /opt/wrapper is reported as undefined and so survives untouched.
  if (footprint.wrapper) delete envAfter.AWS_LAMBDA_EXEC_WRAPPER;

  const removedEnvKeys = Object.keys(fn.env).filter((k) => !(k in envAfter));

  return {
    fn,
    remainingLayers,
    removedLayers,
    removedEnvKeys,
    envAfter,
    clearedWrapper: footprint.wrapper,
  };
}

const hasWork = (p: Plan) =>
  p.removedLayers.length > 0 || p.removedEnvKeys.length > 0;

export async function removeLumigo(
  opts: RemoveLumigoOptions,
): Promise<RemoveLumigoOutcome[]> {
  if (opts.function && opts.filter) {
    throw new ValidationError("use either --function or --filter, not both");
  }
  if (!opts.function && !opts.filter) {
    throw new ValidationError("provide --function NAME or --filter REGEX");
  }

  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });

  // 1. Resolve targets.
  const targets = await selectTargets(lambda, opts);
  if (targets.length === 0) {
    info(`No matching functions in ${opts.region}.`);
    return [];
  }

  // 2. Plan every function before touching anything.
  const plans = targets.map((fn) => buildPlan(fn, opts.keepEnv === true));

  // 3. Print the plan.
  console.log("");
  console.log(
    c.bold(`Remove-Lumigo plan: ${plans.length} function(s) in ${opts.region}`),
  );
  for (const p of plans) {
    const tag = hasWork(p)
      ? c.yellow(
          `${p.removedLayers.length} layer(s), ${p.removedEnvKeys.length} env var(s)`,
        )
      : c.dim("no Lumigo detected");
    console.log(`  ${p.fn.functionName}  ${tag}`);
    for (const l of p.removedLayers) console.log(`    - ${l}`);
    for (const k of p.removedEnvKeys) console.log(`    - ${k}`);
  }
  console.log("");

  const actionable = plans.filter(hasWork);
  if (actionable.length === 0) {
    info("No Lumigo footprint found on any matched function. Nothing to do.");
    return plans.map((p) => toOutcome(p, false, "skipped"));
  }

  if (opts.keepEnv) {
    warn(
      "LUMIGO_* env vars (including LUMIGO_TRACER_TOKEN) are being preserved " +
        "while the tracer layer is removed. Nothing will read them.",
    );
  }

  // 4. Confirm — but only for --filter. A fleet-wide destructive sweep earns
  //    the ceremony; a single -f run does not, matching `uninstall`, which is
  //    equally destructive and prompts for nothing. An unattended --filter
  //    run must pass --yes rather than defaulting to "go ahead".
  if (opts.filter && !opts.yes && !opts.dryRun) {
    if (process.stdin.isTTY) {
      if (!(await confirm("Apply this plan?"))) {
        info("Aborted.");
        return plans.map((p) => toOutcome(p, false, "skipped"));
      }
    } else {
      throw new ValidationError(
        "Refusing to apply without --yes in a non-interactive session.",
      );
    }
  }

  // 5. Apply with bounded concurrency.
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const outcomes: RemoveLumigoOutcome[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= actionable.length) return;
      const p = actionable[i]!;
      try {
        const result = await lambda.updateFunctionConfig({
          name: p.fn.functionName,
          layerArns: p.remainingLayers,
          env: p.envAfter,
        });
        if (result.applied) {
          ok(`Lumigo removed from ${c.bold(p.fn.functionName)}`);
          outcomes.push(toOutcome(p, true, "removed"));
        } else {
          outcomes.push(toOutcome(p, false, "skipped", result.reason));
        }
      } catch (err) {
        const msg = (asCliError(err, "update failed") as Error).message;
        fail(`${p.fn.functionName}: ${msg}`);
        outcomes.push(toOutcome(p, false, "failed", msg));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const removed = outcomes.filter((o) => o.status === "removed").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  console.log("");
  if (opts.dryRun) warn("Dry-run: nothing changed.");
  else if (failed === 0) ok(`${removed} function(s) untraced.`);
  else warn(`${removed} untraced, ${failed} failed.`);

  return outcomes;
}

function toOutcome(
  p: Plan,
  applied: boolean,
  status: RemoveLumigoOutcome["status"],
  message?: string,
): RemoveLumigoOutcome {
  return {
    function: p.fn.functionName,
    status,
    message,
    applied,
    removedLayers: p.removedLayers,
    removedEnvKeys: p.removedEnvKeys,
    clearedWrapper: p.clearedWrapper,
    envBefore: p.fn.env,
    envAfter: p.envAfter,
  };
}

async function selectTargets(
  lambda: LambdaWrapper,
  opts: RemoveLumigoOptions,
): Promise<FunctionSnapshot[]> {
  if (opts.function) {
    return [
      await lambda.getFunction(opts.function).catch((err) => {
        throw asCliError(err, `failed to fetch function ${opts.function}`);
      }),
    ];
  }
  const re = new RegExp(opts.filter!);
  const matches: FunctionSnapshot[] = [];
  for await (const fn of lambda.listFunctions()) {
    if (re.test(fn.functionName)) matches.push(fn);
  }
  return matches;
}
