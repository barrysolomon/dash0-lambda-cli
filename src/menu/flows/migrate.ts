import { confirm, input, number, password, select } from "@inquirer/prompts";
import { migrate } from "../../commands/migrate.js";
import { pickRegion } from "../regions.js";
import { pickFunction } from "../function-picker.js";
import { detectLumigo } from "../../lib/lumigo.js";
import { info } from "../../lib/output.js";

export async function migrateFlow(): Promise<void> {
  const region = await pickRegion(process.env.AWS_REGION);

  const scope = await select({
    message: "Migrate one function or many?",
    choices: [
      { name: "One specific function", value: "one" },
      { name: "Bulk: regex match across the region", value: "many" },
    ],
  });

  let fnName: string | undefined;
  let filter: string | undefined;

  if (scope === "one") {
    fnName = await pickFunction({
      region,
      message: "Pick a function to migrate:",
      filter: (fn) => detectLumigo(fn).layers.length > 0,
    });
  } else {
    filter = await input({
      message: "Regex matching function names:",
      default: "^",
      validate: (v) => {
        try {
          new RegExp(v);
          return true;
        } catch (e) {
          return `invalid regex: ${(e as Error).message}`;
        }
      },
    });
  }

  const endpoint = await input({
    message: "Dash0 OTLP endpoint:",
    default:
      process.env.DASH0_ENDPOINT ??
      `https://ingress.${region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`,
  });

  const authMode = await select({
    message: "Auth method:",
    choices: [
      { name: "Token", value: "token" },
      { name: "Secrets Manager ARN", value: "secret" },
    ],
  });
  let token: string | undefined;
  let tokenSecretArn: string | undefined;
  if (authMode === "token") {
    token = await password({
      message: "Dash0 token:",
      mask: "*",
      validate: (v) =>
        /^auth_[A-Za-z0-9]{32,}$/.test(v.trim()) || "looks wrong",
    });
  } else {
    tokenSecretArn = await input({
      message: "Secrets Manager ARN:",
    });
  }

  const concurrency =
    (await number({
      message: "Concurrency (parallel function updates):",
      default: 4,
      min: 1,
      max: 32,
    })) ?? 4;

  // Plan first.
  info("Showing plan first (dry-run)...");
  await migrate({
    function: fnName,
    filter,
    region,
    endpoint,
    token,
    tokenSecretArn,
    concurrency,
    dryRun: true,
    yes: true, // bypass interactive confirm inside migrate during dry-run
  });

  const apply = await confirm({
    message: "Apply this plan?",
    default: false,
  });
  if (!apply) {
    info("Aborted.");
    return;
  }
  await migrate({
    function: fnName,
    filter,
    region,
    endpoint,
    token,
    tokenSecretArn,
    concurrency,
    yes: true,
  });
}
