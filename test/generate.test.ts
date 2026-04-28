import { describe, expect, it } from "vitest";
import { generate } from "../src/commands/generate.js";

const base = {
  region: "us-west-2",
  family: "node" as const,
  layerVersion: 5,
  endpoint: "https://ingress.us-west-2.aws.dash0.com:4318",
};

describe("generate", () => {
  it("emits a usable Terraform snippet with SSM-backed token", () => {
    const out = generate({
      ...base,
      flavor: "terraform",
      tokenFromSsm: "/dash0/prod/token",
    });
    expect(out).toMatch(/aws_lambda_function/);
    expect(out).toMatch(/dash0-extension-node:5/);
    expect(out).toMatch(/AWS_LAMBDA_EXEC_WRAPPER\s*=\s*"\/opt\/wrapper"/);
    expect(out).toMatch(/aws_ssm_parameter/);
  });

  it("emits SAM YAML", () => {
    const out = generate({ ...base, flavor: "sam", token: "auth_xxx" });
    expect(out).toMatch(/AWS::Serverless::Function/);
    expect(out).toMatch(/dash0-extension-node:5/);
    expect(out).toMatch(/AWS_LAMBDA_EXEC_WRAPPER:\s*\/opt\/wrapper/);
  });

  it("emits CDK TypeScript", () => {
    const out = generate({
      ...base,
      flavor: "cdk-ts",
      tokenFromSsm: "/dash0/prod/token",
    });
    expect(out).toMatch(/lambda\.LayerVersion\.fromLayerVersionArn/);
    expect(out).toMatch(/dash0-extension-node:5/);
    expect(out).toMatch(/aws-cdk-lib\/aws-ssm/);
  });

  it("emits Serverless Framework", () => {
    const out = generate({ ...base, flavor: "serverless", token: "auth_xxx" });
    expect(out).toMatch(/provider:/);
    expect(out).toMatch(/dash0-extension-node:5/);
  });

  it("manual family omits AWS_LAMBDA_EXEC_WRAPPER", () => {
    const out = generate({
      ...base,
      flavor: "terraform",
      family: "manual",
      tokenFromSsm: "/dash0/prod/token",
    });
    expect(out).not.toMatch(/AWS_LAMBDA_EXEC_WRAPPER/);
    expect(out).toMatch(/dash0-extension-manual:5/);
  });
});
