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
