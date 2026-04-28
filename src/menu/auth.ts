/**
 * AWS auth-error remediation.
 *
 * When a flow blows up with bad credentials we:
 *   1. show what went wrong + current AWS_PROFILE / AWS_REGION
 *   2. read ~/.aws/config and offer SSO-capable profiles
 *   3. set process.env.AWS_PROFILE (and AWS_REGION when we know it) so
 *      subsequent SDK clients in this menu session use the chosen profile
 *   4. spawn `aws sso login --profile X` (PKCE flow by default since
 *      AWS CLI v2.22, Nov 2024 — falls back to --use-device-code if PKCE
 *      can't get the token back from 127.0.0.1's loopback callback)
 *   5. verify with sts:GetCallerIdentity from the same Node process
 *   6. tell the caller to retry the failed action
 *
 * The PKCE-vs-device-code distinction is the most common gotcha today:
 * if the browser shows "credentials shared successfully" but our SDK still
 * can't authenticate, the localhost callback didn't reach back to the
 * `aws sso login` process. Re-run with --use-device-code (the older OOB
 * flow where the CLI prints a code and you paste it into the browser).
 */

import { spawn } from "node:child_process";
import { confirm, select } from "@inquirer/prompts";
import kleur from "kleur";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { listProfiles, type AwsProfile } from "./aws-profiles.js";
import { fail, info, ok, warn } from "../lib/output.js";

const AUTH_ERROR_NAMES = new Set([
  "InvalidClientTokenId",
  "InvalidClientTokenIdException",
  "ExpiredToken",
  "ExpiredTokenException",
  "TokenRefreshRequired",
  "UnrecognizedClientException",
  "SignatureDoesNotMatch",
  "CredentialsProviderError",
  "CredentialsError",
  "SSOTokenProviderFailure",
  "ForbiddenException",
]);

const AUTH_ERROR_PHRASES = [
  "security token included in the request is invalid",
  "the security token included in the request is expired",
  "could not load credentials",
  "unable to load credentials",
  "the SSO session associated with this profile has expired",
  "no sso-session or sso_start_url",
  "could not find SSO session",
];

export interface AuthErrorInfo {
  name?: string;
  message: string;
}

export function isAwsAuthError(err: unknown): false | AuthErrorInfo {
  if (!(err instanceof Error)) return false;
  const name = (err as Error & { name?: string }).name;
  if (name && AUTH_ERROR_NAMES.has(name)) return { name, message: err.message };
  const lower = err.message.toLowerCase();
  if (AUTH_ERROR_PHRASES.some((p) => lower.includes(p)))
    return { name, message: err.message };
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (
    meta?.httpStatusCode === 403 &&
    /token/.test(err.message.toLowerCase())
  ) {
    return { name, message: err.message };
  }
  return false;
}

export interface RemediationResult {
  retry: boolean;
}

interface LoginOptions {
  profile?: string;
  /** Force OOB device-code flow instead of the default PKCE flow. */
  useDeviceCode?: boolean;
}

export async function remediateAuthError(
  info0: AuthErrorInfo,
): Promise<RemediationResult> {
  fail(`AWS auth error: ${info0.message}`);
  console.log(
    kleur.dim(
      `  AWS_PROFILE=${process.env.AWS_PROFILE ?? "(not set — using default)"}` +
        `  AWS_REGION=${process.env.AWS_REGION ?? "(not set)"}`,
    ),
  );

  const awsCliAvailable = await commandExists("aws");
  if (!awsCliAvailable) {
    info(
      "The aws CLI isn't on your PATH — install it (https://aws.amazon.com/cli/) to use SSO from here.",
    );
    return {
      retry: await confirm({ message: "Retry anyway?", default: false }),
    };
  }

  // Read available profiles from ~/.aws/config / ~/.aws/credentials.
  const profiles = await listProfiles();
  const ssoProfiles = profiles.filter((p) => p.isSso);

  type Choice = {
    name: string;
    value:
      | "pick-sso"
      | "pick-sso-device"
      | "sso-current"
      | "sso-current-device"
      | "sso-default"
      | "sso-default-device"
      | "sso-configure"
      | "manual"
      | "cancel";
    description?: string;
  };
  const choices: Choice[] = [];

  if (ssoProfiles.length > 0) {
    choices.push({
      name: `Pick an SSO profile and log in  ${kleur.dim(`(${ssoProfiles.length} available · PKCE flow)`)}`,
      value: "pick-sso",
      description:
        "Default since AWS CLI 2.22 (Nov 2024). Browser redirects to a localhost callback.",
    });
    choices.push({
      name: kleur.yellow(
        `Pick an SSO profile and log in via device code  ${kleur.dim("(use if the browser/callback flow keeps failing)")}`,
      ),
      value: "pick-sso-device",
      description:
        "Older OOB flow: CLI prints a code, you paste it into the browser. Works when the localhost callback can't reach the CLI (remote SSH, blocked port, etc.).",
    });
  }
  if (process.env.AWS_PROFILE) {
    choices.push({
      name: `Run: aws sso login --profile ${process.env.AWS_PROFILE}  ${kleur.dim("(current · PKCE)")}`,
      value: "sso-current",
    });
    choices.push({
      name: kleur.yellow(
        `Run: aws sso login --profile ${process.env.AWS_PROFILE} --use-device-code`,
      ),
      value: "sso-current-device",
      description: "Try this if PKCE just succeeded in the browser but CLI auth still failed.",
    });
  } else if (ssoProfiles.length === 0) {
    choices.push({
      name: "Run: aws sso login  (default profile · PKCE)",
      value: "sso-default",
    });
    choices.push({
      name: kleur.yellow("Run: aws sso login --use-device-code  (older OOB flow)"),
      value: "sso-default-device",
    });
  }
  choices.push({
    name: "Run: aws configure sso  (set up a new SSO profile)",
    value: "sso-configure",
  });
  choices.push({
    name: "I'll fix it manually — let me retry",
    value: "manual",
    description: "Use after pasting fresh keys, switching AWS_PROFILE, etc.",
  });
  choices.push({
    name: kleur.dim("Cancel — back to the main menu"),
    value: "cancel",
  });

  const choice = await select({
    message: "How do you want to handle this?",
    choices,
    pageSize: 12,
  });

  switch (choice) {
    case "pick-sso":
      return pickProfileAndLogin(ssoProfiles, { useDeviceCode: false });
    case "pick-sso-device":
      return pickProfileAndLogin(ssoProfiles, { useDeviceCode: true });
    case "sso-current":
      return runLogin({ profile: process.env.AWS_PROFILE });
    case "sso-current-device":
      return runLogin({
        profile: process.env.AWS_PROFILE,
        useDeviceCode: true,
      });
    case "sso-default":
      return runLogin({});
    case "sso-default-device":
      return runLogin({ useDeviceCode: true });
    case "sso-configure": {
      await runInherited("aws", ["configure", "sso"]);
      ok(
        "Profile configured. Pick it from the list next time this prompt appears.",
      );
      return { retry: false };
    }
    case "manual": {
      const ready = await confirm({
        message: "Ready to retry?",
        default: true,
      });
      return { retry: ready };
    }
    default:
      return { retry: false };
  }
}

async function pickProfileAndLogin(
  ssoProfiles: AwsProfile[],
  loginOpts: LoginOptions,
): Promise<RemediationResult> {
  const profileName = await select({
    message: "Pick an SSO profile to use for this session:",
    choices: ssoProfiles.map((p) => ({
      name: formatProfileChoice(p),
      value: p.name,
      description: p.ssoStartUrl
        ? `SSO start URL: ${p.ssoStartUrl}`
        : undefined,
    })),
    default: process.env.AWS_PROFILE,
    pageSize: 12,
  });
  const picked = ssoProfiles.find((p) => p.name === profileName)!;

  // Set for the rest of this menu session — the SDK will pick this up
  // on the next client construction.
  process.env.AWS_PROFILE = picked.name;
  if (picked.region && !process.env.AWS_REGION) {
    process.env.AWS_REGION = picked.region;
  }
  info(
    `Using AWS_PROFILE=${picked.name}` +
      (picked.region ? ` (region ${picked.region})` : ""),
  );

  return runLogin({ profile: picked.name, ...loginOpts });
}

async function runLogin(opts: LoginOptions): Promise<RemediationResult> {
  const args = ["sso", "login"];
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.useDeviceCode) args.push("--use-device-code");

  if (opts.useDeviceCode) {
    info(
      "Device-code flow: the CLI will print a verification code; paste it in the browser when prompted.",
    );
  }

  const code = await runInherited("aws", args);
  if (code !== 0) {
    warn(`aws sso login exited with code ${code}.`);
    return { retry: false };
  }
  return verifyAndReturn(opts.profile, opts.useDeviceCode);
}

function formatProfileChoice(p: AwsProfile): string {
  const meta: string[] = [];
  if (p.region) meta.push(p.region);
  if (p.ssoAccountId) meta.push(`acct ${p.ssoAccountId}`);
  if (p.ssoRoleName) meta.push(p.ssoRoleName);
  const trailing = meta.length ? `  ${kleur.dim(`(${meta.join(" · ")})`)}` : "";
  return `${p.name}${trailing}`;
}

/**
 * Run sts:GetCallerIdentity to verify the just-refreshed credentials work
 * before we tell the caller to retry. If still bad, surface the most likely
 * causes — the top one being a PKCE callback that didn't reach the CLI
 * even though the browser said "success".
 */
async function verifyAndReturn(
  profile: string | undefined,
  triedDeviceCode: boolean | undefined,
): Promise<RemediationResult> {
  ok("SSO login completed.");
  try {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const sts = new STSClient({ region, maxAttempts: 1 });
    const out = await sts.send(new GetCallerIdentityCommand({}));
    ok(
      `Verified: account ${kleur.bold(out.Account ?? "?")} as ` +
        `${(out.Arn ?? "?").split("/").slice(-1)[0]}` +
        (profile ? ` (profile ${profile})` : ""),
    );
    return { retry: true };
  } catch (err) {
    fail(
      `Login appeared to succeed but sts:GetCallerIdentity still fails: ${(err as Error).message}`,
    );

    if (!triedDeviceCode) {
      console.log("");
      warn(
        "This is the classic PKCE-vs-device-code symptom. AWS CLI v2.22 (Nov 2024) " +
          "made PKCE the default — the browser redirects to http://127.0.0.1:<port>/oauth/callback. " +
          "If that callback can't reach the running `aws sso login` process " +
          "(remote SSH session, blocked loopback port, multiple browser profiles), " +
          "the browser shows 'credentials shared successfully' but the CLI never gets the token.",
      );
      const tryDevice = await confirm({
        message: "Re-run with --use-device-code (older OOB flow)?",
        default: true,
      });
      if (tryDevice) {
        return runLogin({ profile, useDeviceCode: true });
      }
    }

    info("Other common causes:");
    console.log(
      kleur.dim(
        [
          "  • The profile and the sso-session you logged into don't match.",
          "    Try: aws sso login --sso-session <name>",
          "  • The profile lacks sso_account_id / sso_role_name (required since CLI 2.90).",
          "  • AWS_REGION isn't set and the profile has no region.",
          "  • The SSO role isn't granted in the target AWS account.",
        ].join("\n"),
      ),
    );
    const retry = await confirm({
      message: "Retry the original action anyway?",
      default: false,
    });
    return { retry };
  }
}

function runInherited(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    probe.on("exit", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}
