/**
 * `dash0-lambda generate <flavor>` — emit IaC snippets users paste into
 * their templates. We deliberately don't try to *modify* the user's IaC
 * files: too many shapes, too many edge cases. The snippet is correct,
 * commented, and parameterized.
 */

import {
  buildLayerArn,
  buildLayerName,
  CANONICAL_OWNER_ACCOUNT,
  type RuntimeFamily,
  wrapperPathFor,
} from "../lib/layers.js";
import { ValidationError } from "../lib/errors.js";

export type IacFlavor =
  | "terraform"
  | "cloudformation"
  | "sam"
  | "cdk-ts"
  | "serverless";

export interface GenerateOptions {
  flavor: IacFlavor;
  region: string;
  family: RuntimeFamily;
  layerVersion: number;
  layerOwner?: string;
  endpoint: string;
  /** SSM parameter path holding the Dash0 token (preferred for IaC). */
  tokenFromSsm?: string;
  /** Or: literal token. Discouraged in IaC. */
  token?: string;
  dataset?: string;
}

export function generate(opts: GenerateOptions): string {
  const ownerAccount = opts.layerOwner ?? CANONICAL_OWNER_ACCOUNT;
  const layerArn = buildLayerArn({
    region: opts.region,
    ownerAccount,
    family: opts.family,
    version: opts.layerVersion,
  });
  const wrapper = wrapperPathFor(opts.family);

  switch (opts.flavor) {
    case "terraform":
      return tf(opts, layerArn, wrapper);
    case "cloudformation":
      return cloudformation(opts, layerArn, wrapper);
    case "sam":
      return sam(opts, layerArn, wrapper);
    case "cdk-ts":
      return cdkTs(opts, layerArn, wrapper);
    case "serverless":
      return serverless(opts, layerArn, wrapper);
    default:
      throw new ValidationError(`unknown IaC flavor: ${opts.flavor}`);
  }
}

function tokenComment(o: GenerateOptions): string {
  if (o.tokenFromSsm)
    return `Token sourced from SSM parameter ${o.tokenFromSsm}. Lambda role needs ssm:GetParameter on this path.`;
  return `WARNING: hard-coding the token in IaC is discouraged. Prefer --token-from-ssm.`;
}

function tf(o: GenerateOptions, layerArn: string, wrapper: string | null): string {
  const envBlock: string[] = [`      DASH0_ENDPOINT = "${o.endpoint}"`];
  if (wrapper) envBlock.unshift(`      AWS_LAMBDA_EXEC_WRAPPER = "${wrapper}"`);
  if (o.dataset) envBlock.push(`      DASH0_DATASET  = "${o.dataset}"`);
  if (o.tokenFromSsm) {
    envBlock.push(
      `      DASH0_TOKEN    = data.aws_ssm_parameter.dash0_token.value`,
    );
  } else if (o.token) {
    envBlock.push(`      DASH0_TOKEN    = "${o.token}"`);
  }

  const ssmDataSource = o.tokenFromSsm
    ? `\ndata "aws_ssm_parameter" "dash0_token" {\n  name            = "${o.tokenFromSsm}"\n  with_decryption = true\n}\n`
    : "";

  return `# Dash0 Lambda extension (Terraform)
# ${tokenComment(o)}
${ssmDataSource}
resource "aws_lambda_function" "example" {
  # ... your existing function args ...

  layers = concat(
    var.existing_layers,
    ["${layerArn}"]
  )

  environment {
    variables = {
${envBlock.join("\n")}
    }
  }
}
`;
}

function cloudformation(
  o: GenerateOptions,
  layerArn: string,
  wrapper: string | null,
): string {
  // Plain CloudFormation (not SAM). Uses AWS::Lambda::Function and the
  // dynamic-reference syntax for SSM-secure params, which CF resolves at
  // deploy time without granting the function ssm:GetParameter.
  const env: string[] = [`          DASH0_ENDPOINT: ${o.endpoint}`];
  if (wrapper) env.unshift(`          AWS_LAMBDA_EXEC_WRAPPER: ${wrapper}`);
  if (o.dataset) env.push(`          DASH0_DATASET: ${o.dataset}`);
  if (o.tokenFromSsm) {
    env.push(
      `          DASH0_TOKEN: '{{resolve:ssm-secure:${o.tokenFromSsm}:1}}'`,
    );
  } else if (o.token) {
    env.push(`          DASH0_TOKEN: ${o.token}`);
  }
  return `# Dash0 Lambda extension (AWS CloudFormation)
# ${tokenComment(o)}
#
# This snippet uses plain CloudFormation (AWS::Lambda::Function). If you
# already use SAM macros, prefer the 'sam' flavor instead.

Resources:
  ExampleFunction:
    Type: AWS::Lambda::Function
    Properties:
      # ... your existing properties (FunctionName, Role, Handler, Code, ...) ...
      Layers:
        - ${layerArn}
      Environment:
        Variables:
${env.join("\n")}
`;
}

function sam(o: GenerateOptions, layerArn: string, wrapper: string | null): string {
  const env: string[] = [`        DASH0_ENDPOINT: ${o.endpoint}`];
  if (wrapper) env.unshift(`        AWS_LAMBDA_EXEC_WRAPPER: ${wrapper}`);
  if (o.dataset) env.push(`        DASH0_DATASET: ${o.dataset}`);
  if (o.tokenFromSsm) {
    env.push(`        DASH0_TOKEN: '{{resolve:ssm-secure:${o.tokenFromSsm}:1}}'`);
  } else if (o.token) {
    env.push(`        DASH0_TOKEN: ${o.token}`);
  }
  return `# Dash0 Lambda extension (AWS SAM)
# ${tokenComment(o)}

Resources:
  ExampleFunction:
    Type: AWS::Serverless::Function
    Properties:
      # ... your existing properties ...
      Layers:
        - ${layerArn}
      Environment:
        Variables:
${env.join("\n")}
`;
}

function cdkTs(o: GenerateOptions, layerArn: string, wrapper: string | null): string {
  const envLines: string[] = [`    DASH0_ENDPOINT: '${o.endpoint}',`];
  if (wrapper) envLines.unshift(`    AWS_LAMBDA_EXEC_WRAPPER: '${wrapper}',`);
  if (o.dataset) envLines.push(`    DASH0_DATASET: '${o.dataset}',`);
  if (o.tokenFromSsm) {
    envLines.push(
      `    DASH0_TOKEN: ssm.StringParameter.valueForStringParameter(this, '${o.tokenFromSsm}'),`,
    );
  } else if (o.token) {
    envLines.push(`    DASH0_TOKEN: '${o.token}',`);
  }
  const ssmImport = o.tokenFromSsm
    ? `import * as ssm from 'aws-cdk-lib/aws-ssm';\n`
    : "";
  return `// Dash0 Lambda extension (AWS CDK, TypeScript)
// ${tokenComment(o)}

import * as lambda from 'aws-cdk-lib/aws-lambda';
${ssmImport}
const dash0Layer = lambda.LayerVersion.fromLayerVersionArn(
  this,
  'Dash0Extension',
  '${layerArn}',
);

const fn = new lambda.Function(this, 'ExampleFunction', {
  // ... your existing props ...
  layers: [dash0Layer],
  environment: {
${envLines.join("\n")}
  },
});
`;
}

function serverless(
  o: GenerateOptions,
  layerArn: string,
  wrapper: string | null,
): string {
  const env: string[] = [`    DASH0_ENDPOINT: ${o.endpoint}`];
  if (wrapper) env.unshift(`    AWS_LAMBDA_EXEC_WRAPPER: ${wrapper}`);
  if (o.dataset) env.push(`    DASH0_DATASET: ${o.dataset}`);
  if (o.tokenFromSsm) {
    env.push(`    DASH0_TOKEN: \${ssm:${o.tokenFromSsm}~true}`);
  } else if (o.token) {
    env.push(`    DASH0_TOKEN: ${o.token}`);
  }
  return `# Dash0 Lambda extension (Serverless Framework)
# ${tokenComment(o)}
#
# TIP: For Serverless Framework users, the official 'serverless-dash0' plugin
# wires the layer + env vars automatically. See:
#   https://github.com/dash0hq/dash0-lambda-extension/tree/master/sls-plugin
# Use the snippet below if you'd rather manage things by hand.

provider:
  name: aws
  region: ${o.region}
  environment:
${env.join("\n")}

functions:
  example:
    handler: src/handler.main
    layers:
      - ${layerArn}
`;
}
