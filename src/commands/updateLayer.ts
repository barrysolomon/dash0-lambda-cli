/**
 * `dash0-lambda update` — replace an attached Dash0 layer with the
 * CLI's known-current version, leaving env vars and other layers
 * untouched. Useful when v6 ships and you want to bump every
 * function without re-entering tokens.
 *
 * Behavior:
 *   - If no Dash0 layer is attached, returns a clear blocker — use
 *     `install` first, this command only bumps existing installations.
 *   - If the attached version equals the target, it's a no-op.
 *   - Otherwise replaces the layer ARN in-place. Layer order is
 *     preserved (Dash0 stays at whatever index it was at).
 */

import { LambdaWrapper } from "../lib/lambda.js";
import {
  buildLayerArn,
  CANONICAL_OWNER_ACCOUNT,
  KNOWN_LATEST_LAYER_VERSION,
  parseDash0LayerArn,
} from "../lib/layers.js";
import { CliError, asCliError } from "../lib/errors.js";
import { c, fail, info, ok, warn } from "../lib/output.js";

export interface UpdateLayerOptions {
  function: string;
  region: string;
  /** Pin a target version. Default: CLI's KNOWN_LATEST_LAYER_VERSION[family]. */
  layerVersion?: number;
  /** Override publisher account (rehosted layers). */
  layerOwner?: string;
  dryRun?: boolean;
  lambda?: LambdaWrapper;
}

export interface UpdateLayerResult {
  function: string;
  applied: boolean;
  before?: string;
  after?: string;
  reason?: string;
}

export async function updateLayer(
  opts: UpdateLayerOptions,
): Promise<UpdateLayerResult> {
  const lambda =
    opts.lambda ??
    new LambdaWrapper({ region: opts.region, dryRun: opts.dryRun });

  const fn = await lambda.getFunction(opts.function).catch((err) => {
    throw asCliError(err, `failed to fetch function ${opts.function}`);
  });

  // Locate the Dash0 layer. If multiple are attached (shouldn't happen but
  // does), update the first; the second will be dropped because we set
  // Layers to the rebuilt list with one Dash0 entry only.
  const dash0Index = fn.layers.findIndex(
    (l) => parseDash0LayerArn(l.Arn ?? "") !== null,
  );
  const dash0Arn = dash0Index >= 0 ? fn.layers[dash0Index]!.Arn ?? "" : "";
  const current = dash0Arn ? parseDash0LayerArn(dash0Arn) : null;

  if (!current) {
    const msg = `${opts.function} has no Dash0 layer attached — run \`install\` first.`;
    fail(msg);
    throw new CliError(msg, 7);
  }

  const ownerAccount = opts.layerOwner ?? current.ownerAccount;
  const targetVersion =
    opts.layerVersion ?? KNOWN_LATEST_LAYER_VERSION[current.family];
  const newArn = buildLayerArn({
    region: opts.region,
    ownerAccount,
    family: current.family,
    version: targetVersion,
  });

  console.log("");
  console.log(c.bold(`Update plan for ${opts.function}`));
  console.log(`  family:  ${current.family}`);
  console.log(`  current: ${dash0Arn}`);
  console.log(`  target:  ${newArn}`);

  if (dash0Arn === newArn) {
    info(
      `Already on v${targetVersion} (${current.family}). Nothing to change.`,
    );
    return {
      function: opts.function,
      applied: false,
      before: dash0Arn,
      after: dash0Arn,
      reason: "already on target",
    };
  }

  const drift = targetVersion - (current.version ?? 0);
  if (drift < 0) {
    warn(
      `Target v${targetVersion} is older than current v${current.version}. ` +
        `Proceeding only because you asked for it explicitly.`,
    );
  }

  // Build new layer list with the Dash0 entry replaced in-place. Other
  // layers (custom shared libs, instrumentation extensions, etc.) keep
  // their order — important for runtimes where order matters.
  const newLayerArns = fn.layers.map((l) =>
    parseDash0LayerArn(l.Arn ?? "") !== null ? newArn : l.Arn ?? "",
  );

  const result = await lambda
    .updateFunctionConfig({
      name: opts.function,
      layerArns: newLayerArns.filter(Boolean),
      env: fn.env,
    })
    .catch((err) => {
      throw asCliError(err, `failed to update function ${opts.function}`);
    });

  if (result.applied) {
    ok(
      `${opts.function}: ${current.family} layer ${current.version} → ${targetVersion}`,
    );
  } else {
    warn(`Dry-run: nothing changed.`);
  }
  return {
    function: opts.function,
    applied: result.applied,
    before: dash0Arn,
    after: newArn,
  };
}
