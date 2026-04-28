import { confirm } from "@inquirer/prompts";
import { uninstall } from "../../commands/uninstall.js";
import { pickRegion } from "../regions.js";
import { pickFunction } from "../function-picker.js";
import { parseDash0LayerArn } from "../../lib/layers.js";
import { offerOpenInConsole } from "./open-console.js";
import { info } from "../../lib/output.js";

export async function uninstallFlow(): Promise<void> {
  const region = await pickRegion(process.env.AWS_REGION);
  const fnName = await pickFunction({
    region,
    message: "Pick a function to remove Dash0 from:",
    filter: (fn) =>
      fn.layers.some((l) => parseDash0LayerArn(l.Arn ?? "") !== null) ||
      Object.keys(fn.env).some((k) => k.startsWith("DASH0_")),
  });

  const clearWrapper = await confirm({
    message:
      "Also clear AWS_LAMBDA_EXEC_WRAPPER if it points at /opt/wrapper?",
    default: true,
  });

  info("Showing plan first (dry-run)...");
  await uninstall({ function: fnName, region, clearWrapper, dryRun: true });

  const apply = await confirm({ message: "Apply?", default: true });
  if (!apply) {
    info("Aborted.");
    return;
  }
  await uninstall({ function: fnName, region, clearWrapper });
  await offerOpenInConsole({ region, functionName: fnName, tab: "configuration" });
}
