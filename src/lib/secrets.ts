/**
 * AWS Secrets Manager helpers — save the Dash0 token as a managed secret
 * so the Lambda function (and future installs) can reference it by ARN
 * via DASH0_TOKEN_SECRET_ARN.
 *
 * Two storage shapes are supported:
 *   - "string": the secret value IS the token, no key needed.
 *   - "json":   secret value is a JSON object, token under a configurable
 *               key (default: "dash0_token"). Set DASH0_TOKEN_SECRET_KEY.
 */

import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";

export interface SaveTokenOptions {
  region: string;
  /** Secret name. Default: dash0/lambda-extension/<account-or-default>. */
  name: string;
  token: string;
  /** Storage shape — string-only or JSON-with-key. */
  shape?: "string" | "json";
  /** When shape='json'. Default: 'dash0_token'. */
  key?: string;
  /** Optional secret description shown in the Secrets Manager console. */
  description?: string;
  /** Optional KMS key id/ARN. Default: aws/secretsmanager. */
  kmsKeyId?: string;
}

export interface SaveTokenResult {
  arn: string;
  versionId: string;
  shape: "string" | "json";
  key?: string;
  /** True when we created a new secret, false when we put a new version. */
  created: boolean;
}

const TAG_MARKER = { Key: "ManagedBy", Value: "dash0-lambda-cli" };

export async function saveTokenToSecret(
  opts: SaveTokenOptions,
): Promise<SaveTokenResult> {
  const sm = new SecretsManagerClient({ region: opts.region });
  const shape = opts.shape ?? "string";
  const key = opts.key ?? "dash0_token";
  const secretString =
    shape === "string" ? opts.token : JSON.stringify({ [key]: opts.token });

  // First try Describe to learn whether the secret already exists.
  let exists = false;
  let arn: string | undefined;
  try {
    const desc = await sm.send(
      new DescribeSecretCommand({ SecretId: opts.name }),
    );
    exists = true;
    arn = desc.ARN;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  if (exists && arn) {
    const put = await sm.send(
      new PutSecretValueCommand({
        SecretId: arn,
        SecretString: secretString,
      }),
    );
    // Refresh the marker tag in case it was stripped.
    await sm
      .send(new TagResourceCommand({ SecretId: arn, Tags: [TAG_MARKER] }))
      .catch(() => undefined);
    return {
      arn,
      versionId: put.VersionId ?? "",
      shape,
      key: shape === "json" ? key : undefined,
      created: false,
    };
  }

  const created = await sm.send(
    new CreateSecretCommand({
      Name: opts.name,
      Description:
        opts.description ?? "Dash0 Lambda extension auth token, managed by dash0-lambda-cli.",
      SecretString: secretString,
      KmsKeyId: opts.kmsKeyId,
      Tags: [TAG_MARKER],
    }),
  );
  return {
    arn: created.ARN!,
    versionId: created.VersionId ?? "",
    shape,
    key: shape === "json" ? key : undefined,
    created: true,
  };
}

/** Read the token back from Secrets Manager — used by `validate` etc. */
export async function getTokenFromSecret(
  region: string,
  arn: string,
  key?: string,
): Promise<string> {
  const sm = new SecretsManagerClient({ region });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = out.SecretString ?? "";
  if (!key) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Secret ${arn} is not JSON, but a key (${key}) was specified.`,
    );
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>)[key] === "string"
  ) {
    return (parsed as Record<string, string>)[key]!;
  }
  throw new Error(`Secret ${arn} has no string field named "${key}".`);
}

/** Build a sensible default secret name. */
export function defaultSecretName(opts: {
  dataset?: string;
  region: string;
}): string {
  const base = "dash0/lambda-extension";
  return opts.dataset ? `${base}/${opts.dataset}` : base;
}

export interface InspectSecretResult {
  arn: string;
  exists: boolean;
  /** Set when the caller can read the value (or is told the resource is missing). */
  errorCode?: "AccessDenied" | "NotFound" | "DecryptFailure" | "Unknown";
  errorMessage?: string;
  /** KMS key ARN/id from DescribeSecret, if any. */
  kmsKeyId?: string;
  /** True if SecretString parses as JSON. */
  isJson?: boolean;
  /** Top-level keys when isJson — never includes values. */
  jsonKeys?: string[];
  /** The token value, if it could be extracted. */
  tokenValue?: string;
  /** Length of the raw secret string when we couldn't extract a token. */
  rawLength?: number;
}

/**
 * Read a secret and try to extract the token. Never throws — folds AWS
 * errors (NotFound, AccessDenied, KMS decrypt) into the result object so
 * callers can render a graceful diagnostic.
 *
 * @param key  When set, treat the secret as JSON and pull this key. When
 *             unset, return the raw secret string as the token (matching
 *             the extension's "DASH0_TOKEN_SECRET_KEY unset" behavior).
 */
export async function inspectSecret(opts: {
  region: string;
  arn: string;
  key?: string;
  client?: SecretsManagerClient;
}): Promise<InspectSecretResult> {
  const sm = opts.client ?? new SecretsManagerClient({ region: opts.region });
  const out: InspectSecretResult = { arn: opts.arn, exists: false };

  try {
    const desc = await sm.send(
      new DescribeSecretCommand({ SecretId: opts.arn }),
    );
    out.exists = true;
    out.kmsKeyId = desc.KmsKeyId;
  } catch (err) {
    out.errorCode = classifySecretError(err);
    out.errorMessage = (err as Error).message;
    return out;
  }

  let raw: string;
  try {
    const v = await sm.send(new GetSecretValueCommand({ SecretId: opts.arn }));
    raw = v.SecretString ?? "";
  } catch (err) {
    out.errorCode = classifySecretError(err);
    out.errorMessage = (err as Error).message;
    return out;
  }

  out.rawLength = raw.length;
  // Attempt JSON parse so we can report shape + key existence.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      out.isJson = true;
      out.jsonKeys = Object.keys(parsed as Record<string, unknown>);
      if (opts.key) {
        const v = (parsed as Record<string, unknown>)[opts.key];
        if (typeof v === "string") out.tokenValue = v;
        else {
          out.errorCode = "Unknown";
          out.errorMessage = `Secret is JSON but has no string field "${opts.key}".`;
        }
      } else {
        // JSON-shaped secret without a key — extension would treat the raw
        // string as the token, which is almost certainly wrong. Flag it.
        out.errorCode = "Unknown";
        out.errorMessage =
          "Secret value is JSON but DASH0_TOKEN_SECRET_KEY is not set; the extension will treat the entire JSON string as the token.";
      }
    } else {
      out.isJson = false;
      if (!opts.key) out.tokenValue = raw;
    }
  } catch {
    out.isJson = false;
    if (opts.key) {
      out.errorCode = "Unknown";
      out.errorMessage = `Secret is not JSON, but DASH0_TOKEN_SECRET_KEY=${opts.key} expects it to be.`;
    } else {
      out.tokenValue = raw;
    }
  }

  return out;
}

function classifySecretError(
  err: unknown,
): "AccessDenied" | "NotFound" | "DecryptFailure" | "Unknown" {
  if (err instanceof ResourceNotFoundException) return "NotFound";
  const e = err as { name?: string; Code?: string };
  const code = e.name ?? e.Code ?? "";
  if (code === "AccessDeniedException") return "AccessDenied";
  if (code === "DecryptionFailure" || code === "KMSAccessDeniedException")
    return "DecryptFailure";
  return "Unknown";
}

export interface SimulateAccessResult {
  /** True only when simulation explicitly allowed every action. */
  allowed: boolean;
  /** True when we couldn't run the simulation at all (e.g. caller lacks iam:Simulate*). */
  inconclusive: boolean;
  decisions: Array<{
    action: string;
    decision: string;
    matched: string[];
  }>;
  reason?: string;
}

/**
 * Best-effort: simulate whether the function's role can read the secret
 * (and decrypt it if a CMK is in play). When the caller can't run
 * `iam:SimulatePrincipalPolicy`, returns `inconclusive: true` rather
 * than failing — by design (per project policy: if you can't simulate
 * it, the Lambda probably can't read it either, and the user will see
 * that during validation through other signals).
 */
export async function simulateLambdaSecretAccess(opts: {
  region: string;
  roleArn: string;
  secretArn: string;
  kmsKeyArn?: string;
  client?: IAMClient;
}): Promise<SimulateAccessResult> {
  const iam = opts.client ?? new IAMClient({ region: opts.region });
  const actions = ["secretsmanager:GetSecretValue"];
  const resourceArns: string[] = [opts.secretArn];
  if (opts.kmsKeyArn) {
    actions.push("kms:Decrypt");
    resourceArns.push(opts.kmsKeyArn);
  }

  try {
    const out = await iam.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: opts.roleArn,
        ActionNames: actions,
        ResourceArns: resourceArns,
      }),
    );
    const decisions =
      (out.EvaluationResults ?? []).map((r) => ({
        action: r.EvalActionName ?? "?",
        decision: r.EvalDecision ?? "?",
        matched: (r.MatchedStatements ?? []).map(
          (s) => `${s.SourcePolicyId ?? "?"}#${s.SourcePolicyType ?? "?"}`,
        ),
      })) ?? [];
    const allowed = decisions.every((d) => d.decision === "allowed");
    return { allowed, inconclusive: false, decisions };
  } catch (err) {
    return {
      allowed: false,
      inconclusive: true,
      decisions: [],
      reason: (err as Error).message,
    };
  }
}
