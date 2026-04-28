/**
 * Function picker — lists Lambda functions in a region (with optional filter
 * predicates) and lets the user pick by name with type-to-search.
 */

import { search } from "@inquirer/prompts";
import { LambdaWrapper, type FunctionSnapshot } from "../lib/lambda.js";
import { parseDash0LayerArn } from "../lib/layers.js";
import { detectLumigo } from "../lib/lumigo.js";

export interface FunctionPickerOptions {
  region: string;
  /** Hint shown in the prompt header. */
  message?: string;
  /** Filter predicate; only functions returning true are offered. */
  filter?: (fn: FunctionSnapshot) => boolean;
}

export async function pickFunction(
  opts: FunctionPickerOptions,
): Promise<string> {
  const lambda = new LambdaWrapper({ region: opts.region, dryRun: true });
  // Fetch eagerly once — usually < 1s in a region.
  const all: FunctionSnapshot[] = [];
  for await (const fn of lambda.listFunctions()) {
    if (!opts.filter || opts.filter(fn)) all.push(fn);
  }

  if (all.length === 0) {
    throw new Error(
      `No matching Lambda functions in ${opts.region}. ` +
        `(Check your AWS profile/region and that you have lambda:ListFunctions.)`,
    );
  }

  const choices = all
    .sort((a, b) => a.functionName.localeCompare(b.functionName))
    .map((fn) => ({
      name: formatRow(fn),
      value: fn.functionName,
      description: `Runtime: ${fn.runtime} · Last modified: ${fn.lastModified ?? "?"}`,
    }));

  return search<string>({
    message:
      opts.message ?? `Pick a function (${all.length} in ${opts.region}):`,
    source: async (term) => {
      if (!term) return choices;
      const t = term.toLowerCase();
      return choices.filter((c) =>
        c.value.toLowerCase().includes(t) ||
        c.name.toLowerCase().includes(t),
      );
    },
    pageSize: 12,
  });
}

function formatRow(fn: FunctionSnapshot): string {
  const tags: string[] = [];
  const dash0 = fn.layers
    .map((l) => parseDash0LayerArn(l.Arn ?? ""))
    .find((x) => x !== null);
  if (dash0) tags.push(`\x1b[32mdash0:v${dash0.version}\x1b[0m`);
  const lumigo = detectLumigo(fn);
  if (lumigo.layers.length > 0) tags.push(`\x1b[33mlumigo\x1b[0m`);
  const tagStr = tags.length ? `  [${tags.join(" ")}]` : "";
  // Pad name + runtime so columns align in the picker.
  const padName = fn.functionName.padEnd(38).slice(0, 38);
  const padRt = fn.runtime.padEnd(14).slice(0, 14);
  return `${padName}  \x1b[2m${padRt}\x1b[0m${tagStr}`;
}
