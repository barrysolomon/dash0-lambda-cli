/**
 * Top-level interactive menu. Launched by `dash0-lambda` (no subcommand)
 * or `dash0-lambda menu`.
 *
 * Each iteration:
 *   1. show banner + AWS identity
 *   2. select a top-level action
 *   3. run the corresponding flow
 *   4. ask "do another?" → loop or exit
 *
 * Ctrl-C inside any prompt is treated as "back to main menu" once,
 * "exit" if hit at the main menu.
 */

import { confirm, select } from "@inquirer/prompts";
import { renderBanner, probeIdentity, renderIdentity } from "./banner.js";
import { installFlow } from "./flows/install.js";
import { uninstallFlow } from "./flows/uninstall.js";
import { validateFlow } from "./flows/validate.js";
import { listFlow } from "./flows/list.js";
import { migrateFlow } from "./flows/migrate.js";
import { generateFlow } from "./flows/generate.js";
import { configFlow } from "./flows/config.js";
import { openConsoleFlow } from "./flows/open-console.js";
import { isAwsAuthError, remediateAuthError } from "./auth.js";
import { CliError, ValidationError } from "../lib/errors.js";
import { c, fail } from "../lib/output.js";

type Action =
  | "install"
  | "validate"
  | "list"
  | "migrate"
  | "uninstall"
  | "generate"
  | "console"
  | "config"
  | "quit";

export async function runMenu(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ValidationError(
      "the menu requires an interactive TTY. " +
        "Use the flag-driven commands (e.g. `dash0-lambda install ...`) for scripts/CI.",
    );
  }

  console.log(renderBanner());
  const id = await probeIdentity(process.env.AWS_REGION);
  console.log(renderIdentity(id));
  console.log("");

  while (true) {
    const action = await pickAction();
    if (action === "quit") {
      console.log(c.dim("\n  bye 👋\n"));
      return;
    }

    await dispatch(action);

    const again = await confirmSafely(
      "Do something else?",
      true,
    );
    if (!again) {
      console.log(c.dim("\n  bye 👋\n"));
      return;
    }
    console.log(""); // visual breather between iterations
  }
}

async function pickAction(): Promise<Action> {
  return select<Action>({
    message: "What would you like to do?",
    choices: [
      {
        name: "Install Dash0 on a Lambda function",
        value: "install",
        description: "Attach the layer + set required env vars (with a plan + confirm)",
      },
      {
        name: "Validate / doctor an existing setup",
        value: "validate",
        description: "Health-check a function's wiring and (optionally) tail logs",
      },
      {
        name: "List functions and their footprint",
        value: "list",
        description: "Show every function in a region and which have Dash0/Lumigo",
      },
      {
        name: "Migrate from Lumigo to Dash0",
        value: "migrate",
        description: "Swap Lumigo for Dash0 on one function or many (regex)",
      },
      {
        name: "Uninstall Dash0 from a function",
        value: "uninstall",
        description: "Remove the layer + DASH0_* env vars",
      },
      {
        name: "Open a function in the AWS console",
        value: "console",
        description:
          "Pick a function and jump to Lambda code/config/monitor or CloudWatch Logs in your browser",
      },
      {
        name: "Generate IaC snippet (Terraform / SAM / CDK / Serverless)",
        value: "generate",
        description: "Emit a snippet you can paste into your templates",
      },
      {
        name: "Manage saved credentials & defaults",
        value: "config",
        description:
          "View / edit ./.dash0-lambda.json, rotate the saved Secrets Manager token, or clear everything",
      },
      {
        name: c.dim("Quit"),
        value: "quit",
      },
    ],
    pageSize: 10,
  });
}

async function runAction(action: Action): Promise<void> {
  switch (action) {
    case "install":
      return installFlow();
    case "uninstall":
      return uninstallFlow();
    case "validate":
      return validateFlow();
    case "list":
      return listFlow();
    case "migrate":
      return migrateFlow();
    case "generate":
      return generateFlow();
    case "console":
      return openConsoleFlow();
    case "config":
      return configFlow();
    case "quit":
      return;
  }
}

/**
 * Run an action with auth-error remediation. If AWS credentials are bad,
 * offer `aws sso login` and retry the action on success. Up to 2 retries
 * so we don't loop on a permanently broken setup.
 */
async function dispatch(action: Action): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runAction(action);
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log(c.dim("\n  (cancelled — back to main menu)\n"));
        return;
      }
      const authInfo = isAwsAuthError(err);
      if (authInfo && attempt < 2) {
        console.log("");
        const { retry } = await remediateAuthError(authInfo);
        if (retry) continue;
        return;
      }
      if (err instanceof CliError) fail(err.message);
      else fail((err as Error).message);
      return;
    }
  }
}

/** confirm() that swallows ExitPromptError and treats Ctrl-C as "no". */
async function confirmSafely(
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  try {
    return await confirm({ message, default: defaultValue });
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") return false;
    throw err;
  }
}
