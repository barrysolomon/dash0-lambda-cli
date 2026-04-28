/**
 * AWS console URL builders. The console deep-links here are stable; AWS
 * has used these shapes for years across Lambda, CloudWatch Logs, X-Ray.
 *
 * GovCloud and China-region hosts are different; we handle the common
 * commercial regions only and degrade gracefully (returns the standard
 * console URL) for others.
 */

import { spawn } from "node:child_process";

export type LambdaConsoleTab =
  | "code"
  | "test"
  | "monitoring"
  | "configuration"
  | "aliases";

export interface LambdaConsoleUrlOpts {
  region: string;
  functionName: string;
  tab?: LambdaConsoleTab;
}

export function lambdaConsoleUrl(opts: LambdaConsoleUrlOpts): string {
  const host = consoleHost(opts.region);
  const tab = opts.tab ? `?tab=${opts.tab}` : "";
  return `https://${host}/lambda/home?region=${encodeURIComponent(
    opts.region,
  )}#/functions/${encodeURIComponent(opts.functionName)}${tab}`;
}

export function cloudwatchLogsUrl(opts: {
  region: string;
  functionName: string;
}): string {
  const host = consoleHost(opts.region);
  // Console encodes "/aws/lambda/<fn>" log group with $252F escapes.
  const encoded = `/aws/lambda/${opts.functionName}`
    .split("/")
    .join("$252F");
  return `https://${host}/cloudwatch/home?region=${encodeURIComponent(
    opts.region,
  )}#logsV2:log-groups/log-group/${encoded}`;
}

export function xrayServiceMapUrl(region: string): string {
  const host = consoleHost(region);
  return `https://${host}/cloudwatch/home?region=${encodeURIComponent(
    region,
  )}#xray:service-map/map`;
}

function consoleHost(region: string): string {
  if (region.startsWith("us-gov-")) return `${region}.console.amazonaws-us-gov.com`;
  if (region.startsWith("cn-")) return `${region}.console.amazonaws.cn`;
  return `${region}.console.aws.amazon.com`;
}

/**
 * Best-effort cross-platform URL opener. Returns true if we successfully
 * spawned the OS opener; the caller should still print the URL so users
 * with no GUI can copy it.
 */
export async function openUrl(url: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };
  return new Promise((resolve) => {
    const child = spawn(cmd.bin, cmd.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => resolve(false));
    // We don't wait for exit — `open`/`xdg-open` return quickly but we
    // don't want to block the menu on the browser actually loading.
    child.unref();
    setImmediate(() => resolve(true));
  });
}
