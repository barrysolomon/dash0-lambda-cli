import { describe, expect, it } from "vitest";
import {
  cloudwatchLogsUrl,
  lambdaConsoleUrl,
  xrayServiceMapUrl,
} from "../src/lib/console-urls.js";

describe("lambdaConsoleUrl", () => {
  it("builds a code-tab URL by default", () => {
    const url = lambdaConsoleUrl({
      region: "us-east-1",
      functionName: "orders-create",
    });
    expect(url).toBe(
      "https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/orders-create",
    );
  });
  it("supports the configuration tab deep-link", () => {
    expect(
      lambdaConsoleUrl({
        region: "us-west-2",
        functionName: "orders-create",
        tab: "configuration",
      }),
    ).toContain("?tab=configuration");
  });
  it("URL-encodes function names with funny characters", () => {
    const url = lambdaConsoleUrl({
      region: "us-west-2",
      functionName: "orders/create",
    });
    expect(url).toContain("orders%2Fcreate");
  });
  it("uses the GovCloud console host for us-gov-* regions", () => {
    expect(
      lambdaConsoleUrl({
        region: "us-gov-west-1",
        functionName: "fn",
      }),
    ).toContain("console.amazonaws-us-gov.com");
  });
  it("uses the China console host for cn-* regions", () => {
    expect(
      lambdaConsoleUrl({ region: "cn-north-1", functionName: "fn" }),
    ).toContain("console.amazonaws.cn");
  });
});

describe("cloudwatchLogsUrl", () => {
  it("encodes the /aws/lambda/<fn> log-group path", () => {
    const url = cloudwatchLogsUrl({
      region: "us-east-1",
      functionName: "orders-create",
    });
    // Console uses $252F as the slash escape inside #log-group/log-group/...
    expect(url).toMatch(/log-group\/\$252Faws\$252Flambda\$252Forders-create/);
  });
});

describe("xrayServiceMapUrl", () => {
  it("returns a CloudWatch X-Ray service-map URL for the region", () => {
    expect(xrayServiceMapUrl("eu-west-1")).toContain(
      "cloudwatch/home?region=eu-west-1#xray:service-map/map",
    );
  });
});
