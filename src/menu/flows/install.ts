/**
 * Guided install flow:
 *   load saved config → region → function → endpoint → auth (with persistence)
 *   → optional knobs → confirm → apply → optionally save defaults for next run
 *
 * Pre-fills aggressively from the local config file (`./.dash0-lambda.json`)
 * and from env (AWS_REGION, DASH0_ENDPOINT, DASH0_TOKEN). The "optional
 * knobs" page is opt-in — by default we only set required vars.
 */

import {
  checkbox,
  confirm,
  input,
  password,
  select,
} from "@inquirer/prompts";
import kleur from "kleur";
import { install } from "../../commands/install.js";
import { pickRegion } from "../regions.js";
import { pickFunction } from "../function-picker.js";
import {
  loadConfig,
  loadLocalToken,
  saveConfig,
  saveTokenLocally,
} from "../../lib/config.js";
import {
  defaultSecretName,
  getTokenFromSecret,
  saveTokenToSecret,
} from "../../lib/secrets.js";
import { offerOpenInConsole } from "./open-console.js";
import { c, info, ok, warn } from "../../lib/output.js";

export async function installFlow(): Promise<void> {
  const cfg = await loadConfig();

  const region = await pickRegion(
    cfg.region ?? process.env.AWS_REGION,
  );
  const fnName = await pickFunction({ region });

  const endpoint = await input({
    message: "Dash0 OTLP endpoint:",
    default:
      cfg.endpoint ??
      process.env.DASH0_ENDPOINT ??
      `https://ingress.${dash0Region(region)}.aws.dash0.com:4318`,
    validate: (v) =>
      /^https?:\/\/.+:\d+$/.test(v.trim()) ||
      "must be a full https://host:port URL",
  });

  // ─── Auth: load or prompt ───────────────────────────────────────────────
  const auth = await chooseAuth(cfg);
  let token: string | undefined = auth.token;
  let tokenSecretArn: string | undefined = auth.tokenSecretArn;
  let tokenSecretKey: string | undefined = auth.tokenSecretKey;

  // Optional knobs — explicit opt-in keeps the default install minimal.
  const enabled = await checkbox({
    message: "Optional settings to set (leave empty to keep defaults):",
    choices: [
      { name: "Dataset (DASH0_DATASET)", value: "dataset" },
      { name: "Service name (OTEL_SERVICE_NAME)", value: "serviceName" },
      {
        name: "Extension log level (DASH0_EXTENSION_LOG_LEVEL)",
        value: "logLevel",
      },
      { name: "X-Ray active tracing already on", value: "xray" },
      {
        name: "Disable auto-instrumentation (synthetic-only)",
        value: "noAuto",
      },
    ],
  });

  let dataset: string | undefined;
  let serviceName: string | undefined;
  let extensionLogLevel:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | undefined;
  let xrayTracesEnabled: boolean | undefined;
  let disableAutoInstrumentation: boolean | undefined;

  if (enabled.includes("dataset")) {
    dataset = await input({
      message: "Dataset name:",
      default: cfg.dataset ?? "default",
    });
  }
  if (enabled.includes("serviceName")) {
    serviceName = await input({
      message: "Service name:",
      default: fnName,
    });
  }
  if (enabled.includes("logLevel")) {
    extensionLogLevel = (await select({
      message: "Log level:",
      choices: ["trace", "debug", "info", "warn", "error"].map((v) => ({
        name: v,
        value: v,
      })),
      default: "warn",
    })) as typeof extensionLogLevel;
  }
  if (enabled.includes("xray")) xrayTracesEnabled = true;
  if (enabled.includes("noAuto")) disableAutoInstrumentation = true;

  // Always show plan first via dry-run, then ask to apply.
  console.log("");
  info("Showing plan first (dry-run)...");
  await install({
    function: fnName,
    region,
    endpoint,
    token,
    tokenSecretArn,
    tokenSecretKey,
    dataset,
    serviceName,
    extensionLogLevel,
    xrayTracesEnabled,
    disableAutoInstrumentation,
    dryRun: true,
  });

  const apply = await confirm({
    message: "Apply this plan?",
    default: true,
  });
  if (!apply) {
    info("Aborted. Nothing changed.");
    return;
  }

  await install({
    function: fnName,
    region,
    endpoint,
    token,
    tokenSecretArn,
    tokenSecretKey,
    dataset,
    serviceName,
    extensionLogLevel,
    xrayTracesEnabled,
    disableAutoInstrumentation,
  });

  // ─── Persist defaults for next run ──────────────────────────────────────
  await maybeSaveDefaults({
    cfg,
    region,
    endpoint,
    dataset,
    literalToken: token,
    tokenSecretArn,
    tokenSecretKey,
  });

  // ─── Optional: jump to the function in the AWS console ─────────────────
  await offerOpenInConsole({ region, functionName: fnName, tab: "configuration" });

  console.log(c.dim("\n  Tip: run `validate` next to confirm the wiring.\n"));
}

interface AuthChoice {
  token?: string;
  tokenSecretArn?: string;
  tokenSecretKey?: string;
}

/**
 * Decide where the token comes from. Returns the resolved token / ARN to
 * use *and* optionally persists it for next time.
 *
 * Order of precedence for "we already have a token":
 *   1. Saved tokenSecretArn in config — fetch & verify
 *   2. Saved tokenLocalFile — read from disk
 *   3. Otherwise prompt the user
 *
 * If a saved token is found we still ask for confirmation before reusing.
 */
async function chooseAuth(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<AuthChoice> {
  // Saved → confirm reuse.
  if (cfg.tokenSecretArn) {
    const reuse = await confirm({
      message: `Reuse saved Secrets Manager ARN (${shortenArn(cfg.tokenSecretArn)})?`,
      default: true,
    });
    if (reuse) {
      return {
        tokenSecretArn: cfg.tokenSecretArn,
        tokenSecretKey: cfg.tokenSecretKey,
      };
    }
  } else if (cfg.tokenLocalFile) {
    const reuse = await confirm({
      message: `Reuse saved local token file (${cfg.tokenLocalFile})?`,
      default: true,
    });
    if (reuse) {
      const tok = await loadLocalToken(cfg.tokenLocalFile);
      if (tok) return { token: tok };
      warn(`Couldn't read ${cfg.tokenLocalFile}; please enter the token again.`);
    }
  }

  // Prompt.
  const method = await select({
    message: "How should the extension authenticate?",
    choices: [
      { name: "Token (paste it now, hidden)", value: "token" },
      { name: "Existing Secrets Manager ARN", value: "secret-arn" },
    ],
  });

  if (method === "secret-arn") {
    const arn = await input({
      message: "Secrets Manager ARN:",
      default: cfg.tokenSecretArn,
      validate: (v) =>
        /^arn:aws:secretsmanager:/.test(v.trim()) || "must be a Secrets Manager ARN",
    });
    const isJson = await confirm({
      message: "Does the secret store a JSON object (vs. a raw string)?",
      default: !!cfg.tokenSecretKey,
    });
    let key: string | undefined;
    if (isJson) {
      key = await input({
        message: "JSON key inside the secret:",
        default: cfg.tokenSecretKey ?? "dash0_token",
      });
    }
    return { tokenSecretArn: arn.trim(), tokenSecretKey: key };
  }

  const token = await password({
    message: "Dash0 token (input hidden):",
    mask: "*",
    validate: (v) =>
      /^auth_[A-Za-z0-9]{32,}$/.test(v.trim()) ||
      "looks wrong (expecting 'auth_' + 32+ chars)",
  });
  return { token };
}

interface PersistOptions {
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  region: string;
  endpoint: string;
  dataset?: string;
  /** The literal token the user entered, if any. Lets us save it without re-asking. */
  literalToken?: string;
  tokenSecretArn?: string;
  tokenSecretKey?: string;
}

/**
 * Ask whether to save defaults so the next install pre-fills. If the
 * user entered a literal token (no ARN), offer to upgrade it into a
 * Secrets Manager secret OR write it to a local 0600 file. The literal
 * token NEVER goes into the JSON config.
 */
async function maybeSaveDefaults(opts: PersistOptions): Promise<void> {
  const haveSecretAlready = !!opts.tokenSecretArn;

  type Choice =
    | "none"
    | "defaults-only"
    | "defaults-plus-secret"
    | "defaults-plus-localfile";

  const choices: Array<{ name: string; value: Choice; description?: string }> = [
    {
      name: "Save defaults (region, endpoint, dataset, secret ARN if any)",
      value: "defaults-only",
    },
  ];
  if (!haveSecretAlready && opts.literalToken) {
    choices.push({
      name: kleur.cyan("Also save token → AWS Secrets Manager (creates a secret)"),
      value: "defaults-plus-secret",
      description:
        "Creates a managed secret, saves the ARN to the config. Function role needs secretsmanager:GetSecretValue on it.",
    });
    choices.push({
      name: kleur.cyan(
        "Also save token → local file (./.dash0-lambda.token, mode 0600)",
      ),
      value: "defaults-plus-localfile",
      description:
        "Convenient for dev. We add the file to .gitignore if one exists. Lambda role-based options like Secrets Manager are safer for prod.",
    });
  }
  choices.push({ name: "Don't save", value: "none" });

  const what = await select<Choice>({
    message: "Save defaults to ./.dash0-lambda.json for next time?",
    choices,
  });

  if (what === "none") return;

  let tokenSecretArn = opts.tokenSecretArn;
  let tokenSecretKey = opts.tokenSecretKey;
  let tokenLocalFile: string | undefined;

  if (what === "defaults-plus-secret" && opts.literalToken) {
    const name = await input({
      message: "Secret name:",
      default: defaultSecretName({
        dataset: opts.dataset,
        region: opts.region,
      }),
    });
    const shape = (await select({
      message: "Secret value shape:",
      choices: [
        { name: "Plain string (the secret IS the token)", value: "string" },
        { name: "JSON object with a 'dash0_token' key", value: "json" },
      ],
      default: "string",
    })) as "string" | "json";
    try {
      const r = await saveTokenToSecret({
        region: opts.region,
        name,
        token: opts.literalToken,
        shape,
      });
      ok(`${r.created ? "Created" : "Updated"} secret ${name}`);
      info(`  ARN: ${r.arn}`);
      tokenSecretArn = r.arn;
      if (r.shape === "json") tokenSecretKey = r.key;
      info(
        "Don't forget to grant secretsmanager:GetSecretValue on this ARN to the function's IAM role.",
      );
    } catch (err) {
      warn(
        `Couldn't save secret: ${(err as Error).message}. Saving non-token defaults only.`,
      );
    }
  } else if (what === "defaults-plus-localfile" && opts.literalToken) {
    try {
      const r = await saveTokenLocally(opts.literalToken);
      ok(`Wrote ${r.absolutePath} (mode 0600)`);
      tokenLocalFile = r.configRelativePath;
    } catch (err) {
      warn(`Couldn't write local token: ${(err as Error).message}`);
    }
  }

  const path = await saveConfig({
    region: opts.region,
    endpoint: opts.endpoint,
    dataset: opts.dataset,
    tokenSecretArn,
    tokenSecretKey,
    tokenLocalFile,
  });
  ok(`Saved defaults to ${path}`);
}

/** Best-guess Dash0 ingress region for a given AWS region. */
function dash0Region(awsRegion: string): string {
  if (awsRegion.startsWith("eu-")) return "eu-west-1";
  return "us-west-2";
}

function shortenArn(arn: string): string {
  // arn:aws:secretsmanager:us-west-2:111:secret:dash0-token-AbCd
  const parts = arn.split(":");
  if (parts.length < 7) return arn;
  return `${parts[3]}:${parts[6]}`;
}

// Re-export for tests/uses elsewhere if needed.
export { saveTokenLocally };
