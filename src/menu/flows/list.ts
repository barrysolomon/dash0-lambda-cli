import { select } from "@inquirer/prompts";
import { list } from "../../commands/list.js";
import { pickRegion } from "../regions.js";

export async function listFlow(): Promise<void> {
  const region = await pickRegion(process.env.AWS_REGION);
  const filter = await select({
    message: "Filter:",
    choices: [
      { name: "All functions", value: "all" },
      { name: "Only functions with Dash0", value: "dash0" },
      { name: "Only functions with Lumigo", value: "lumigo" },
    ],
  });
  const format = await select({
    message: "Output format:",
    choices: [
      { name: "Table (terminal)", value: "table" },
      { name: "JSON", value: "json" },
      { name: "YAML", value: "yaml" },
    ],
    default: "table",
  });

  await list({
    region,
    onlyDash0: filter === "dash0",
    onlyLumigo: filter === "lumigo",
    format: format as "table" | "json" | "yaml",
  });
}
