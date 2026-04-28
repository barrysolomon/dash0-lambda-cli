/**
 * "Manage saved credentials" flow — show what's in ./.dash0-lambda.json,
 * let the user clear it, edit individual fields, or rotate the saved
 * Secrets Manager secret.
 */

import { confirm, input, select } from "@inquirer/prompts";
import kleur from "kleur";
import {
  clearConfig,
  configPath,
  describeConfig,
  loadConfig,
  saveConfig,
} from "../../lib/config.js";
import {
  defaultSecretName,
  saveTokenToSecret,
} from "../../lib/secrets.js";
import { info, ok, warn } from "../../lib/output.js";

export async function configFlow(): Promise<void> {
  const cfg = await loadConfig();
  console.log("");
  console.log(kleur.bold(`Saved config (${configPath()})`));
  console.log(describeConfig(cfg));
  console.log("");

  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Edit a field", value: "edit" },
      {
        name: "Rotate the saved Secrets Manager token (PutSecretValue)",
        value: "rotate",
        description:
          "Updates the existing secret with a new token value, keeping the ARN.",
      },
      { name: "Clear all saved config (delete the file)", value: "clear" },
      { name: kleur.dim("Back"), value: "back" },
    ],
  });

  switch (action) {
    case "edit":
      return editField(cfg);
    case "rotate":
      return rotateSecret(cfg);
    case "clear": {
      const yes = await confirm({
        message: `Delete ${configPath()}?`,
        default: false,
      });
      if (!yes) return;
      const removed = await clearConfig();
      if (removed) ok("Config cleared.");
      else info("No config file existed.");
      return;
    }
    default:
      return;
  }
}

async function editField(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  type Field =
    | "region"
    | "endpoint"
    | "dataset"
    | "profile"
    | "tokenSecretArn"
    | "tokenSecretKey"
    | "tokenLocalFile"
    | "layerOwner"
    | "layerVersion";
  const field = await select<Field>({
    message: "Which field?",
    choices: [
      { name: "region", value: "region" },
      { name: "endpoint", value: "endpoint" },
      { name: "dataset", value: "dataset" },
      { name: "profile", value: "profile" },
      { name: "tokenSecretArn", value: "tokenSecretArn" },
      { name: "tokenSecretKey", value: "tokenSecretKey" },
      { name: "tokenLocalFile", value: "tokenLocalFile" },
      { name: "layerOwner", value: "layerOwner" },
      { name: "layerVersion", value: "layerVersion" },
    ],
  });
  const current = (cfg as Record<string, unknown>)[field];
  const value = await input({
    message: `${field} (blank to clear):`,
    default: current === undefined ? "" : String(current),
  });

  const patch: Record<string, unknown> = {};
  if (value.trim() === "") {
    patch[field] = undefined;
  } else if (field === "layerVersion") {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
      warn("layerVersion must be an integer; ignored.");
      return;
    }
    patch[field] = n;
  } else {
    patch[field] = value.trim();
  }

  const path = await saveConfig(patch);
  ok(`Saved → ${path}`);
}

async function rotateSecret(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!cfg.tokenSecretArn) {
    warn("No tokenSecretArn in saved config. Run install first to create one.");
    return;
  }
  const region =
    cfg.region ??
    process.env.AWS_REGION ??
    (await input({ message: "Region for the secret:" }));
  // The secret name is embedded in the ARN — last segment minus the random suffix.
  const arnParts = cfg.tokenSecretArn.split(":");
  const last = arnParts[arnParts.length - 1] ?? "";
  const guessedName = last.replace(/-[A-Za-z0-9]{6}$/, "");
  const name = await input({
    message: "Secret name (we'll PutSecretValue on this):",
    default: guessedName || defaultSecretName({ region, dataset: cfg.dataset }),
  });
  const newToken = await input({
    message: "New token (will be hidden in the secret):",
    validate: (v) =>
      /^auth_[A-Za-z0-9]{32,}$/.test(v.trim()) || "looks wrong",
  });

  try {
    const r = await saveTokenToSecret({
      region,
      name,
      token: newToken.trim(),
      shape: cfg.tokenSecretKey ? "json" : "string",
      key: cfg.tokenSecretKey,
    });
    ok(
      `${r.created ? "Created" : "Updated"} secret ${name} → version ${r.versionId}`,
    );
    if (r.arn !== cfg.tokenSecretArn) {
      info(`Secret ARN changed → ${r.arn}; updating saved config.`);
      await saveConfig({ tokenSecretArn: r.arn });
    }
  } catch (err) {
    warn(`Failed: ${(err as Error).message}`);
  }
}
