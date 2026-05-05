/**
 * `dash0-lambda validate` (alias: `doctor`) — health-check a function's
 * Dash0 wiring. Returns nonzero exit if any FAIL-level check fails.
 *
 * Checks performed:
 *   1. Layer attached, ARN is a Dash0 extension layer
 *   2. Layer version is current (within 2 versions of latest in region)
 *   3. AWS_LAMBDA_EXEC_WRAPPER set correctly for the family
 *   4. Either DASH0_TOKEN or DASH0_TOKEN_SECRET_ARN present
 *   5. DASH0_ENDPOINT looks well-formed and points at a Dash0 ingress
 *   6. Runtime is in the supported set
 *   7. (Optional, with --check-logs) Recent CloudWatch log group has the
 *      Dash0 extension startup line
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { LambdaWrapper, type FunctionSnapshot } from "../lib/lambda.js";
import {
  buildLayerName,
  CANONICAL_OWNER_ACCOUNT,
  familyForRuntime,
  KNOWN_LATEST_LAYER_VERSION,
  parseDash0LayerArn,
  type RuntimeFamily,
  wrapperPathFor,
} from "../lib/layers.js";
import { c, fail, info, ok, warn } from "../lib/output.js";
import {
  inspectSecret,
  simulateLambdaSecretAccess,
  type InspectSecretResult,
} from "../lib/secrets.js";

export interface ValidateOptions {
  function: string;
  region: string;
  layerOwner?: string;
  /** Tail recent log events to confirm the extension actually started. */
  checkLogs?: boolean;
  /** Lookback window for log check, ms. */
  logsLookbackMs?: number;
  /**
   * When DASH0_TOKEN_SECRET_ARN is set, fetch the secret with the CLI's
   * creds and (best-effort) simulate whether the function's role can
   * read it. Defaults to true.
   */
  checkSecret?: boolean;
  /**
   * Print the resolved token (from DASH0_TOKEN or by reading the secret).
   * Redacted by default; pass revealToken=true for the full value.
   */
  showToken?: boolean;
  revealToken?: boolean;
  lambda?: LambdaWrapper;
  logs?: CloudWatchLogsClient;
}

export interface CheckResult {
  name: string;
  level: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface ValidateResult {
  function: string;
  checks: CheckResult[];
  pass: boolean;
}

export async function validate(opts: ValidateOptions): Promise<ValidateResult> {
  const lambda =
    opts.lambda ?? new LambdaWrapper({ region: opts.region, dryRun: true });
  const fn = await lambda.getFunction(opts.function);
  const checks: CheckResult[] = [];

  // 1. runtime supported?
  const family = familyForRuntime(fn.runtime);
  if (family === "manual" && !fn.runtime.startsWith("provided")) {
    checks.push({
      name: "runtime",
      level: "warn",
      message: `runtime ${fn.runtime} has no auto-instrumentation family; using 'manual'`,
      fix: "ensure your handler explicitly initializes the OTel SDK",
    });
  } else {
    checks.push({
      name: "runtime",
      level: "ok",
      message: `${fn.runtime} → ${family}`,
    });
  }

  // 2. layer attached?
  const dash0Layers = fn.layers
    .map((l) => parseDash0LayerArn(l.Arn ?? ""))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (dash0Layers.length === 0) {
    checks.push({
      name: "layer",
      level: "fail",
      message: "no Dash0 extension layer attached",
      fix: `dash0-lambda install --function ${opts.function} --region ${opts.region} ...`,
    });
  } else if (dash0Layers.length > 1) {
    checks.push({
      name: "layer",
      level: "warn",
      message: `${dash0Layers.length} Dash0 layers attached — should be exactly one`,
      fix: "uninstall and re-install to reset",
    });
  } else {
    const attached = dash0Layers[0]!;
    if (attached.family !== family) {
      checks.push({
        name: "layer-family",
        level: "warn",
        message: `attached family is '${attached.family}' but runtime suggests '${family}'`,
        fix: `re-run install (defaults will pick the right family)`,
      });
    }

    // 2b. layer version current?
    // Compare against the static known-latest baked into this CLI. As a
    // soft secondary, try ListLayerVersions — but only if the user is on
    // a rehosted publisher (where they're likely to have permission). If
    // the dynamic check fails, fall through to the static comparison.
    const ownerAccount = opts.layerOwner ?? attached.ownerAccount;
    const knownLatest = KNOWN_LATEST_LAYER_VERSION[attached.family];
    let latest = knownLatest;
    let dynamicSource: "cli-constant" | "list-api" = "cli-constant";

    if (ownerAccount !== CANONICAL_OWNER_ACCOUNT) {
      const layerName = buildLayerName(attached.family);
      try {
        latest = await lambda.latestLayerVersion(layerName, ownerAccount);
        dynamicSource = "list-api";
      } catch {
        /* fall through to static */
      }
    }

    const drift = latest - (attached.version ?? 0);
    const sourceTag =
      dynamicSource === "cli-constant" ? " (per CLI's known-latest)" : "";
    if (drift <= 0) {
      checks.push({
        name: "layer-version",
        level: "ok",
        message: `layer at latest version (${attached.version})${sourceTag}`,
      });
    } else if (drift <= 2) {
      checks.push({
        name: "layer-version",
        level: "warn",
        message: `layer is ${drift} version(s) behind (current ${attached.version}, latest ${latest})${sourceTag}`,
        fix: "re-run install to pick up the latest",
      });
    } else {
      checks.push({
        name: "layer-version",
        level: "fail",
        message: `layer is ${drift} versions behind (current ${attached.version}, latest ${latest})${sourceTag}`,
        fix: "re-run install to pick up the latest",
      });
    }
  }

  // 3. wrapper env var
  const expectedWrapper = wrapperPathFor(family);
  const actualWrapper = fn.env.AWS_LAMBDA_EXEC_WRAPPER;
  if (expectedWrapper === null) {
    if (actualWrapper) {
      checks.push({
        name: "wrapper",
        level: "warn",
        message: `manual family doesn't expect AWS_LAMBDA_EXEC_WRAPPER, but it's set to ${actualWrapper}`,
      });
    } else {
      checks.push({
        name: "wrapper",
        level: "ok",
        message: "no wrapper expected for manual family",
      });
    }
  } else if (actualWrapper !== expectedWrapper) {
    checks.push({
      name: "wrapper",
      level: "fail",
      message: `AWS_LAMBDA_EXEC_WRAPPER=${actualWrapper ?? "(unset)"}, expected ${expectedWrapper}`,
      fix: `set AWS_LAMBDA_EXEC_WRAPPER=${expectedWrapper}`,
    });
  } else {
    checks.push({
      name: "wrapper",
      level: "ok",
      message: `AWS_LAMBDA_EXEC_WRAPPER=${expectedWrapper}`,
    });
  }

  // 4. token / token-secret
  const hasToken = !!fn.env.DASH0_TOKEN;
  const hasSecret = !!fn.env.DASH0_TOKEN_SECRET_ARN;
  if (hasToken && hasSecret) {
    checks.push({
      name: "auth",
      level: "warn",
      message:
        "both DASH0_TOKEN and DASH0_TOKEN_SECRET_ARN set; per the extension docs DASH0_TOKEN takes precedence",
    });
  } else if (!hasToken && !hasSecret) {
    checks.push({
      name: "auth",
      level: "fail",
      message: "no DASH0_TOKEN or DASH0_TOKEN_SECRET_ARN set",
      fix: "re-run install with --token or --token-secret-arn",
    });
  } else {
    checks.push({
      name: "auth",
      level: "ok",
      message: hasToken ? "DASH0_TOKEN present" : "DASH0_TOKEN_SECRET_ARN present",
    });
  }

  // 4b. Reachability/shape of the Secrets Manager value, if used. This is
  // exactly the failure mode where the env var is set but the function's
  // role can't actually call GetSecretValue (or the secret doesn't exist
  // / is in another region / has a CMK the role can't decrypt).
  let secretInspect: InspectSecretResult | undefined;
  if (hasSecret && opts.checkSecret !== false) {
    const arn = fn.env.DASH0_TOKEN_SECRET_ARN!;
    const key = fn.env.DASH0_TOKEN_SECRET_KEY;
    secretInspect = await inspectSecret({
      region: opts.region,
      arn,
      key,
    });
    if (!secretInspect.exists) {
      checks.push({
        name: "secret-exists",
        level: "fail",
        message:
          secretInspect.errorCode === "NotFound"
            ? `secret ${arn} not found in ${opts.region}`
            : `couldn't describe secret (${secretInspect.errorCode}): ${secretInspect.errorMessage}`,
        fix:
          secretInspect.errorCode === "AccessDenied"
            ? "the CLI's creds can't see the secret — your function's role likely can't either"
            : `verify the ARN and that it lives in ${opts.region}`,
      });
    } else {
      checks.push({
        name: "secret-exists",
        level: "ok",
        message: `secret resolves${secretInspect.kmsKeyId ? ` (CMK: ${secretInspect.kmsKeyId})` : ""}`,
      });

      if (secretInspect.errorCode) {
        // Got past Describe but reading/parsing the value failed.
        checks.push({
          name: "secret-shape",
          level: "fail",
          message: secretInspect.errorMessage ?? secretInspect.errorCode,
          fix:
            secretInspect.errorCode === "DecryptFailure"
              ? "function role likely lacks kms:Decrypt on the CMK"
              : secretInspect.errorCode === "AccessDenied"
                ? "function role likely lacks secretsmanager:GetSecretValue"
                : "rotate the secret with a value the extension can parse",
        });
      } else if (secretInspect.tokenValue) {
        const tokRe = /^auth_[A-Za-z0-9]{32,}$/;
        if (!tokRe.test(secretInspect.tokenValue)) {
          checks.push({
            name: "secret-shape",
            level: "warn",
            message:
              "secret value doesn't match the expected token shape (auth_…)",
          });
        } else {
          checks.push({
            name: "secret-shape",
            level: "ok",
            message: "secret value parses as a Dash0 token",
          });
        }
      }

      // 4c. Best-effort IAM simulation against the function's role.
      if (fn.role) {
        const sim = await simulateLambdaSecretAccess({
          region: opts.region,
          roleArn: fn.role,
          secretArn: arn,
          kmsKeyArn: secretInspect.kmsKeyId,
        });
        if (sim.inconclusive) {
          checks.push({
            name: "secret-iam",
            level: "warn",
            message: `couldn't simulate role access (${sim.reason ?? "unknown"})`,
            fix: "your CLI creds probably lack iam:SimulatePrincipalPolicy; if your function fails to read the secret, attach a policy granting secretsmanager:GetSecretValue on the ARN to the function role",
          });
        } else if (!sim.allowed) {
          const denied = sim.decisions
            .filter((d) => d.decision !== "allowed")
            .map((d) => `${d.action}=${d.decision}`)
            .join(", ");
          checks.push({
            name: "secret-iam",
            level: "fail",
            message: `function role ${fn.role} cannot ${denied}`,
            fix: `attach a policy granting ${sim.decisions
              .filter((d) => d.decision !== "allowed")
              .map((d) => d.action)
              .join(" + ")} on ${arn}${secretInspect.kmsKeyId ? ` and ${secretInspect.kmsKeyId}` : ""} — or set DASH0_TOKEN directly`,
          });
        } else {
          checks.push({
            name: "secret-iam",
            level: "ok",
            message: "function role can read the secret (and decrypt CMK)",
          });
        }
      }
    }
  }

  // 5. endpoint
  const ep = fn.env.DASH0_ENDPOINT;
  if (!ep) {
    checks.push({
      name: "endpoint",
      level: "fail",
      message: "DASH0_ENDPOINT is not set",
      fix: "re-run install with --endpoint",
    });
  } else if (!/^https?:\/\/.+/.test(ep)) {
    checks.push({
      name: "endpoint",
      level: "fail",
      message: `DASH0_ENDPOINT=${ep} is not a valid URL`,
    });
  } else if (!ep.includes("dash0.com")) {
    checks.push({
      name: "endpoint",
      level: "warn",
      message: `DASH0_ENDPOINT=${ep} doesn't point at a dash0.com host`,
    });
  } else {
    checks.push({ name: "endpoint", level: "ok", message: `DASH0_ENDPOINT=${ep}` });
  }

  // 6. logs
  if (opts.checkLogs) {
    const logs = opts.logs ?? new CloudWatchLogsClient({ region: opts.region });
    const lookback = opts.logsLookbackMs ?? 15 * 60 * 1000;
    try {
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: `/aws/lambda/${opts.function}`,
          startTime: Date.now() - lookback,
          filterPattern: '"dash0-extension"',
          limit: 5,
        }),
      );
      const events = out.events ?? [];
      if (events.length > 0) {
        checks.push({
          name: "extension-running",
          level: "ok",
          message: `saw ${events.length} dash0-extension log line(s) in the last ${Math.round(lookback / 60000)}m`,
        });
      } else {
        checks.push({
          name: "extension-running",
          level: "warn",
          message: `no dash0-extension log lines in the last ${Math.round(lookback / 60000)}m`,
          fix: "invoke the function and re-check",
        });
      }
    } catch (err) {
      checks.push({
        name: "extension-running",
        level: "warn",
        message: `couldn't read logs: ${(err as Error).message}`,
      });
    }
  }

  // Print
  console.log(c.bold(`\nDash0 doctor — ${opts.function}`));
  for (const ck of checks) {
    const icon =
      ck.level === "ok" ? c.green("✔") : ck.level === "warn" ? c.yellow("!") : c.red("✘");
    console.log(`  ${icon} ${c.bold(ck.name.padEnd(20))} ${ck.message}`);
    if (ck.fix && ck.level !== "ok") console.log(`      ${c.dim("fix: " + ck.fix)}`);
  }

  // Optional: show the resolved token (from env or fetched secret).
  if (opts.showToken) {
    const tok = hasToken ? fn.env.DASH0_TOKEN : secretInspect?.tokenValue;
    console.log("");
    if (!tok) {
      console.log(c.dim("  token: (could not resolve)"));
    } else {
      const display = opts.revealToken ? tok : redactToken(tok);
      const source = hasToken ? "DASH0_TOKEN" : "Secrets Manager";
      console.log(`  token (${source}): ${display}`);
    }
  }

  const failures = checks.filter((k) => k.level === "fail").length;
  const warns = checks.filter((k) => k.level === "warn").length;
  console.log("");
  if (failures === 0 && warns === 0) ok(`${opts.function} is healthy.`);
  else if (failures === 0) warn(`${opts.function} has ${warns} warning(s).`);
  else fail(`${opts.function} has ${failures} failure(s) and ${warns} warning(s).`);

  return { function: opts.function, checks, pass: failures === 0 };
}

function redactToken(tok: string): string {
  if (tok.length <= 12) return "***";
  return `${tok.slice(0, 8)}…${tok.slice(-4)}`;
}

// keep this so the file referenced by tests has a stable export surface
export type { FunctionSnapshot };
