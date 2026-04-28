/**
 * Read and parse AWS shared config files (~/.aws/config and
 * ~/.aws/credentials) so the menu can offer the user a list of profiles
 * (and tell which ones are SSO-capable).
 *
 * We avoid the @aws-sdk/shared-ini-file-loader package and parse by hand:
 *   - the INI format is small and stable
 *   - we don't need the SDK's resolution semantics, just the raw fields
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AwsProfile {
  name: string;
  region?: string;
  ssoSession?: string;
  ssoStartUrl?: string;
  ssoAccountId?: string;
  ssoRoleName?: string;
  /** Profile is SSO-capable if it has either sso_session or sso_start_url. */
  isSso: boolean;
}

const CONFIG_PATH = process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
const CREDS_PATH =
  process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), ".aws", "credentials");

export async function listProfiles(): Promise<AwsProfile[]> {
  const profiles = new Map<string, AwsProfile>();
  for (const path of [CONFIG_PATH, CREDS_PATH]) {
    const text = await readFileSafe(path);
    if (!text) continue;
    parseInto(text, profiles, path === CONFIG_PATH);
  }
  return [...profiles.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Minimal INI parser. AWS config sections look like:
 *   [profile foo]                 ← in ~/.aws/config
 *   [foo]                         ← in ~/.aws/credentials
 *   [sso-session bar]             ← named SSO session block
 *   [default]                     ← the default profile
 *
 * We collapse `profile foo` and `foo` to the same canonical name "foo".
 */
function parseInto(
  text: string,
  out: Map<string, AwsProfile>,
  isConfigFile: boolean,
): void {
  let cur: { kind: "profile" | "sso" | "ignore"; name: string } | null = null;
  const ssoSessions = new Map<string, Record<string, string>>();
  const sectionRe = /^\[([^\]]+)\]\s*$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const m = sectionRe.exec(line);
    if (m) {
      const header = m[1]!.trim();
      if (header.startsWith("sso-session ")) {
        cur = { kind: "sso", name: header.slice("sso-session ".length).trim() };
        ssoSessions.set(cur.name, {});
      } else if (header.startsWith("profile ")) {
        const name = header.slice("profile ".length).trim();
        cur = { kind: "profile", name };
        if (!out.has(name)) out.set(name, blank(name));
      } else if (isConfigFile && header === "default") {
        cur = { kind: "profile", name: "default" };
        if (!out.has("default")) out.set("default", blank("default"));
      } else if (!isConfigFile) {
        // credentials file: bare [name] is a profile
        cur = { kind: "profile", name: header };
        if (!out.has(header)) out.set(header, blank(header));
      } else {
        cur = { kind: "ignore", name: header };
      }
      continue;
    }
    if (!cur || cur.kind === "ignore") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (cur.kind === "profile") {
      const p = out.get(cur.name)!;
      switch (key) {
        case "region":
          p.region = value;
          break;
        case "sso_session":
          p.ssoSession = value;
          p.isSso = true;
          break;
        case "sso_start_url":
          p.ssoStartUrl = value;
          p.isSso = true;
          break;
        case "sso_account_id":
          p.ssoAccountId = value;
          break;
        case "sso_role_name":
          p.ssoRoleName = value;
          break;
      }
    } else if (cur.kind === "sso") {
      ssoSessions.get(cur.name)![key] = value;
    }
  }

  // Backfill: if a profile points at an sso_session that defines start_url,
  // copy it onto the profile so the picker can show it.
  for (const p of out.values()) {
    if (p.ssoSession && !p.ssoStartUrl) {
      const sess = ssoSessions.get(p.ssoSession);
      if (sess?.sso_start_url) p.ssoStartUrl = sess.sso_start_url;
    }
  }
}

function blank(name: string): AwsProfile {
  return { name, isSso: false };
}

function stripComment(line: string): string {
  // ; or # introduces a comment when not inside quotes; AWS config doesn't use
  // quoted values so this is fine.
  for (const marker of [";", "#"]) {
    const i = line.indexOf(marker);
    if (i === 0) return "";
    if (i > 0) return line.slice(0, i);
  }
  return line;
}
