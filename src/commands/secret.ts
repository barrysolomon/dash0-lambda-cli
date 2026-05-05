/**
 * `dash0-lambda secret show` — read the Secrets Manager value backing a
 * function's DASH0_TOKEN_SECRET_ARN (or an explicit ARN) and print it,
 * redacted by default. Useful for confirming the function is wired to
 * the token you think it is.
 */

import { LambdaWrapper } from "../lib/lambda.js";
import { CliError, asCliError } from "../lib/errors.js";
import { c, fail, info, warn } from "../lib/output.js";
import { inspectSecret } from "../lib/secrets.js";

export interface SecretShowOptions {
  region: string;
  function?: string;
  secretArn?: string;
  secretKey?: string;
  reveal?: boolean;
  lambda?: LambdaWrapper;
}

export interface SecretShowResult {
  arn: string;
  resolved: boolean;
  token?: string;
}

export async function secretShow(
  opts: SecretShowOptions,
): Promise<SecretShowResult> {
  let arn = opts.secretArn;
  let key = opts.secretKey;

  if (!arn) {
    if (!opts.function) {
      throw new CliError(
        "either --function or --secret-arn is required",
      );
    }
    const lambda =
      opts.lambda ?? new LambdaWrapper({ region: opts.region, dryRun: true });
    const fn = await lambda
      .getFunction(opts.function)
      .catch((err) => {
        throw asCliError(err, `failed to fetch function ${opts.function}`);
      });
    arn = fn.env.DASH0_TOKEN_SECRET_ARN;
    key = key ?? fn.env.DASH0_TOKEN_SECRET_KEY;
    if (!arn) {
      if (fn.env.DASH0_TOKEN) {
        info(
          `${opts.function} authenticates with DASH0_TOKEN (env var), not a secret.`,
        );
        if (opts.reveal) {
          console.log(`  token: ${fn.env.DASH0_TOKEN}`);
        } else {
          console.log(`  token: ${redact(fn.env.DASH0_TOKEN)}`);
        }
        return {
          arn: "",
          resolved: true,
          token: fn.env.DASH0_TOKEN,
        };
      }
      throw new CliError(
        `function ${opts.function} has neither DASH0_TOKEN nor DASH0_TOKEN_SECRET_ARN set`,
      );
    }
  }

  const r = await inspectSecret({ region: opts.region, arn, key });
  console.log("");
  console.log(c.bold("Dash0 token secret"));
  console.log(`  arn:        ${r.arn}`);
  if (r.kmsKeyId) console.log(`  kms key:    ${r.kmsKeyId}`);
  if (typeof r.isJson === "boolean")
    console.log(`  shape:      ${r.isJson ? "json" : "string"}`);
  if (r.jsonKeys && r.jsonKeys.length > 0)
    console.log(`  json keys:  ${r.jsonKeys.join(", ")}`);

  if (!r.exists || r.errorCode) {
    fail(`couldn't resolve token: ${r.errorCode ?? "Unknown"} — ${r.errorMessage ?? ""}`);
    if (r.errorCode === "AccessDenied") {
      warn(
        "the CLI's creds can't read this secret; the function's role may have the same problem.",
      );
    }
    return { arn: r.arn, resolved: false };
  }

  if (!r.tokenValue) {
    warn("secret resolved but no token value extracted");
    return { arn: r.arn, resolved: false };
  }

  const display = opts.reveal ? r.tokenValue : redact(r.tokenValue);
  console.log(`  token:      ${display}`);
  if (!opts.reveal)
    console.log(c.dim("  (re-run with --reveal to print the full value)"));
  return { arn: r.arn, resolved: true, token: r.tokenValue };
}

function redact(tok: string): string {
  if (tok.length <= 12) return "***";
  return `${tok.slice(0, 8)}…${tok.slice(-4)}`;
}
