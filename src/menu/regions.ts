/** Region picker. Shows common regions first, then "Other..." for free-text. */

import { input, select } from "@inquirer/prompts";

const COMMON = [
  { name: "us-west-2 · Oregon", value: "us-west-2" },
  { name: "us-east-1 · N. Virginia", value: "us-east-1" },
  { name: "us-east-2 · Ohio", value: "us-east-2" },
  { name: "eu-west-1 · Ireland", value: "eu-west-1" },
  { name: "eu-central-1 · Frankfurt", value: "eu-central-1" },
  { name: "ap-northeast-1 · Tokyo", value: "ap-northeast-1" },
  { name: "ap-southeast-2 · Sydney", value: "ap-southeast-2" },
];

const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

export async function pickRegion(defaultRegion?: string): Promise<string> {
  const choices = [
    ...COMMON,
    { name: "Other (type one in)…", value: "__other__" },
  ];
  // If we have a default, hoist it to the top.
  if (defaultRegion) {
    const i = choices.findIndex((c) => c.value === defaultRegion);
    if (i > 0) {
      const [hit] = choices.splice(i, 1);
      choices.unshift({
        name: `${hit!.name}  ${kleurDim("(current default)")}`,
        value: hit!.value,
      });
    } else if (i < 0) {
      choices.unshift({
        name: `${defaultRegion}  ${kleurDim("(current default)")}`,
        value: defaultRegion,
      });
    }
  }

  const choice = await select({
    message: "AWS region:",
    choices,
    default: defaultRegion,
    pageSize: 10,
  });

  if (choice !== "__other__") return choice;
  return input({
    message: "Enter region (e.g. ap-south-1):",
    validate: (v) => REGION_RE.test(v.trim()) || "looks malformed",
  });
}

// Tiny inline kleur dim — avoids importing kleur for one call site.
function kleurDim(s: string): string {
  // 2 = dim, 0 = reset
  return `\x1b[2m${s}\x1b[0m`;
}
