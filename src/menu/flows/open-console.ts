/**
 * "Open in AWS console" flow + a reusable post-action helper that other
 * flows (install/validate/uninstall) can call to ask the user whether
 * they want to jump to the console for the function they just touched.
 */

import { confirm, select } from "@inquirer/prompts";
import kleur from "kleur";
import {
  cloudwatchLogsUrl,
  lambdaConsoleUrl,
  openUrl,
  type LambdaConsoleTab,
} from "../../lib/console-urls.js";
import { pickRegion } from "../regions.js";
import { pickFunction } from "../function-picker.js";
import { info, ok, warn } from "../../lib/output.js";

/** Standalone flow — region → function → tab → open. */
export async function openConsoleFlow(): Promise<void> {
  const region = await pickRegion(process.env.AWS_REGION);
  const functionName = await pickFunction({
    region,
    message: "Pick a function to open in the AWS console:",
  });
  const target = await select<"lambda" | "logs" | "lambda-config" | "lambda-monitoring">({
    message: "Where should I send you?",
    choices: [
      { name: "Lambda → Code & test", value: "lambda" },
      { name: "Lambda → Configuration tab", value: "lambda-config" },
      { name: "Lambda → Monitor tab", value: "lambda-monitoring" },
      { name: "CloudWatch Logs (this function's log group)", value: "logs" },
    ],
  });

  let url: string;
  switch (target) {
    case "lambda":
      url = lambdaConsoleUrl({ region, functionName, tab: "code" });
      break;
    case "lambda-config":
      url = lambdaConsoleUrl({ region, functionName, tab: "configuration" });
      break;
    case "lambda-monitoring":
      url = lambdaConsoleUrl({ region, functionName, tab: "monitoring" });
      break;
    case "logs":
      url = cloudwatchLogsUrl({ region, functionName });
      break;
  }

  await launchOrShow(url);
}

/**
 * Shared post-action prompt. Call this from install/validate/uninstall
 * after they finish so the user can jump to the function in one keystroke.
 *
 * Defaults to NOT opening (true → would open). Returns silently when the
 * user declines so the menu's "Do something else?" prompt fires next.
 */
export async function offerOpenInConsole(opts: {
  region: string;
  functionName: string;
  /** Tab to deep-link to. Default: 'configuration' which is the most useful
   *  view post-install (shows attached layers + env vars). */
  tab?: LambdaConsoleTab;
}): Promise<void> {
  const yes = await confirm({
    message: `Open ${opts.functionName} in the AWS console?`,
    default: false,
  });
  if (!yes) return;
  const url = lambdaConsoleUrl({
    region: opts.region,
    functionName: opts.functionName,
    tab: opts.tab ?? "configuration",
  });
  await launchOrShow(url);
}

/** Print the URL prominently, then attempt to spawn the OS opener. */
async function launchOrShow(url: string): Promise<void> {
  console.log("");
  console.log(`  ${kleur.bold("URL:")} ${kleur.cyan().underline(url)}`);
  console.log("");
  const opened = await openUrl(url);
  if (opened) ok("Opened in your default browser.");
  else {
    warn(
      "Couldn't auto-launch a browser (no GUI? remote SSH? unusual platform?). " +
        "Copy the URL above.",
    );
    info(
      "Tip: ssh -L localhost:8080:localhost:8080 forwards or `pbcopy < <(echo $URL)` works in a pinch.",
    );
  }
}
