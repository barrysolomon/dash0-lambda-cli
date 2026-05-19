/**
 * Dash0 Lambda extension layer registry.
 *
 * The Dash0 native extension publishes one layer per language family:
 *   dash0-extension-manual   — language-agnostic, you call the OTel SDK yourself
 *   dash0-extension-node     — auto-instruments Node.js handlers
 *   dash0-extension-python   — auto-instruments Python handlers
 *   dash0-extension-java     — auto-instruments JVM handlers
 *
 * Layers are regional. The same logical version is published into every
 * supported region from the canonical publisher account.
 *
 * If you need to override the publisher account (e.g. you've rehosted the
 * layers into your own account for cross-account access), set
 * DASH0_LAYER_OWNER_ACCOUNT in the environment, or pass --layer-owner.
 */

import { z } from "zod";

/** The runtime families the Dash0 extension supports. */
export const RUNTIME_FAMILIES = ["manual", "node", "python", "java"] as const;
export type RuntimeFamily = (typeof RUNTIME_FAMILIES)[number];

/** Map AWS Lambda runtime strings to Dash0 extension families. */
const RUNTIME_TO_FAMILY: Record<string, RuntimeFamily> = {
  // Node.js
  "nodejs18.x": "node",
  "nodejs20.x": "node",
  "nodejs22.x": "node",
  // Python
  "python3.9": "python",
  "python3.10": "python",
  "python3.11": "python",
  "python3.12": "python",
  "python3.13": "python",
  // Java
  "java11": "java",
  "java17": "java",
  "java21": "java",
};

export function familyForRuntime(runtime: string): RuntimeFamily {
  return RUNTIME_TO_FAMILY[runtime] ?? "manual";
}

/** Canonical Dash0 publisher account — same in every supported region. */
export const CANONICAL_OWNER_ACCOUNT = "115813213817";

/**
 * Known-current Dash0 extension layer versions, by family.
 *
 * The Dash0 publisher account (`CANONICAL_OWNER_ACCOUNT`) publishes the
 * same version number across every supported region simultaneously, so
 * this is a global constant per-family — no per-region table needed.
 *
 * **How to update**
 * Bump these when Dash0 cuts a new release. Cross-check with the GitHub
 * releases at https://github.com/dash0hq/dash0-lambda-extension/releases.
 *
 * **Why static instead of ListLayerVersions**
 * Cross-account `lambda:ListLayerVersions` requires the publisher account
 * to have granted you that action via a resource-based policy. The
 * canonical Dash0 layers grant `lambda:GetLayerVersion` to all principals
 * (so you can attach them) but not List, so dynamic version discovery
 * only works for users who rehost the layers into their own account.
 * Hardcoding the current version avoids a needless permission requirement
 * for the common case.
 */
export const KNOWN_LATEST_LAYER_VERSION: Record<RuntimeFamily, number> = {
  manual: 9,
  node: 9,
  python: 9,
  java: 9,
};

/** AWS regions where Dash0 publishes the extension layers. */
export const SUPPORTED_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
] as const;
export type SupportedRegion = (typeof SUPPORTED_REGIONS)[number];

export interface LayerCoordinate {
  region: string;
  ownerAccount: string;
  family: RuntimeFamily;
  /** When undefined, callers should resolve "latest" via the Lambda API. */
  version?: number;
}

export function buildLayerName(family: RuntimeFamily): string {
  return `dash0-extension-${family}`;
}

export function buildLayerArn(coord: LayerCoordinate): string {
  if (coord.version === undefined) {
    throw new Error(
      `buildLayerArn requires a version. Resolve latest first via lambda.listLayerVersions().`,
    );
  }
  return `arn:aws:lambda:${coord.region}:${coord.ownerAccount}:layer:${buildLayerName(coord.family)}:${coord.version}`;
}

const LAYER_ARN_RE =
  /^arn:aws:lambda:([a-z0-9-]+):(\d{12}):layer:dash0-extension-([a-z]+):(\d+)$/;

/**
 * Returns coordinates if `arn` is a Dash0 extension layer, else null.
 * Recognizes both canonical-owner and rehosted-owner ARNs.
 */
export function parseDash0LayerArn(arn: string): LayerCoordinate | null {
  const m = LAYER_ARN_RE.exec(arn);
  if (!m) return null;
  const [, region, ownerAccount, familyRaw, versionStr] = m;
  if (!RUNTIME_FAMILIES.includes(familyRaw as RuntimeFamily)) return null;
  return {
    region: region!,
    ownerAccount: ownerAccount!,
    family: familyRaw as RuntimeFamily,
    version: Number(versionStr),
  };
}

export const LayerOptionsSchema = z.object({
  region: z.string().min(1),
  ownerAccount: z.string().regex(/^\d{12}$/).default(CANONICAL_OWNER_ACCOUNT),
  family: z.enum(RUNTIME_FAMILIES).optional(),
});

export type LayerOptions = z.infer<typeof LayerOptionsSchema>;

/**
 * Wrapper path to put in AWS_LAMBDA_EXEC_WRAPPER for each family.
 * Dash0 extension publishes a single `/opt/wrapper` entrypoint that the
 * extension binary handles regardless of language; manual mode skips this.
 */
export function wrapperPathFor(family: RuntimeFamily): string | null {
  return family === "manual" ? null : "/opt/wrapper";
}
