import { confirm } from "@inquirer/prompts";
import { validate } from "../../commands/validate.js";
import { pickRegion } from "../regions.js";
import { pickFunction } from "../function-picker.js";
import { offerOpenInConsole } from "./open-console.js";

export async function validateFlow(): Promise<void> {
  const region = await pickRegion(process.env.AWS_REGION);
  const fnName = await pickFunction({
    region,
    message: "Pick a function to validate:",
  });
  const checkLogs = await confirm({
    message: "Also tail recent CloudWatch logs to confirm the extension started?",
    default: true,
  });
  const result = await validate({ function: fnName, region, checkLogs });

  // After a doctor run, the configuration tab is the most useful jump
  // (shows attached layers + env vars side-by-side). On failure, the
  // Monitor tab is more useful — that's where logs/metrics live.
  await offerOpenInConsole({
    region,
    functionName: fnName,
    tab: result.pass ? "configuration" : "monitoring",
  });
}
