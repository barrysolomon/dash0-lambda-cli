import { input, number, select } from "@inquirer/prompts";
import { generate, type IacFlavor } from "../../commands/generate.js";
import { pickRegion } from "../regions.js";
import {
  KNOWN_LATEST_LAYER_VERSION,
  RUNTIME_FAMILIES,
} from "../../lib/layers.js";

export async function generateFlow(): Promise<void> {
  const flavor = (await select({
    message: "IaC flavor:",
    choices: [
      { name: "Terraform", value: "terraform" },
      { name: "AWS SAM", value: "sam" },
      { name: "AWS CDK (TypeScript)", value: "cdk-ts" },
      { name: "Serverless Framework", value: "serverless" },
    ],
  })) as IacFlavor;

  const region = await pickRegion(process.env.AWS_REGION);
  const family = (await select({
    message: "Runtime family:",
    choices: RUNTIME_FAMILIES.map((f) => ({ name: f, value: f })),
    default: "node",
  })) as (typeof RUNTIME_FAMILIES)[number];

  const defaultVersion = KNOWN_LATEST_LAYER_VERSION[family];
  const layerVersion =
    (await number({
      message: `Layer version to pin (CLI knows ${defaultVersion} as current):`,
      default: defaultVersion,
      min: 1,
    })) ?? defaultVersion;

  const endpoint = await input({
    message: "Dash0 endpoint:",
    default:
      process.env.DASH0_ENDPOINT ??
      `https://ingress.${region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`,
  });

  const tokenStrategy = await select({
    message: "How should the token reach the Lambda?",
    choices: [
      { name: "From SSM Parameter Store (recommended)", value: "ssm" },
      { name: "Inline literal (discouraged)", value: "inline" },
      { name: "I'll wire it myself — leave a placeholder", value: "placeholder" },
    ],
  });

  let tokenFromSsm: string | undefined;
  let token: string | undefined;
  if (tokenStrategy === "ssm") {
    tokenFromSsm = await input({
      message: "SSM parameter path:",
      default: "/dash0/prod/token",
    });
  } else if (tokenStrategy === "inline") {
    token = await input({
      message: "Token (literal):",
    });
  }

  const dataset = await input({
    message: "Dataset (blank to skip):",
    default: "",
  });

  const out = generate({
    flavor,
    region,
    family,
    layerVersion,
    endpoint,
    tokenFromSsm,
    token: token || undefined,
    dataset: dataset || undefined,
  });

  console.log("\n" + "─".repeat(64));
  process.stdout.write(out);
  console.log("─".repeat(64) + "\n");
}
