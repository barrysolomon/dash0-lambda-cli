/**
 * Switch the active AWS account/profile.
 *
 * Reads ~/.aws/config + ~/.aws/credentials, groups profiles by
 * `sso_account_id` (each AWS account is its own bucket), and lists
 * roles within each account. For users with one IAM Identity Center
 * fronting many accounts (the common case), this turns the picker
 * into "pick an account first, then a role within it".
 *
 * Profiles that aren't SSO-shaped (legacy IAM users / direct keys)
 * land in an "Other (non-SSO)" bucket at the bottom.
 *
 * Selecting an entry:
 *   1. Sets process.env.AWS_PROFILE so subsequent SDK clients pick it up.
 *   2. Sets AWS_REGION from the profile's `region` if our env had none.
 *   3. Pushes a status line confirming the switch.
 *
 * If the SSO token for the chosen account is expired, the next AWS call
 * will fail and the auto-route in App.tsx will pop you into the
 * AuthError screen with the right "aws sso login" command pre-selected.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import {
  listProfiles,
  type AwsProfile,
} from "../../menu/aws-profiles.js";
import type { ScreenProps } from "../types.js";

interface AccountGroup {
  /** Account ID, or 'unknown' for non-SSO profiles. */
  accountId: string;
  profiles: AwsProfile[];
}

const PAGE = 14;

export const SwitchProfile: React.FC<ScreenProps> = ({ state, setState }) => {
  const [profiles, setProfiles] = useState<AwsProfile[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch((err) => setError((err as Error).message));
  }, []);

  // Build a flat list of selectable rows interleaved with header rows so
  // we can render the account-grouped tree without an outer-state library.
  type Row =
    | { kind: "header"; accountId: string; count: number }
    | { kind: "profile"; profile: AwsProfile };

  const rows: Row[] = React.useMemo(() => {
    if (!profiles) return [];
    const groups = groupByAccount(profiles);
    const out: Row[] = [];
    for (const g of groups) {
      out.push({ kind: "header", accountId: g.accountId, count: g.profiles.length });
      for (const p of g.profiles) out.push({ kind: "profile", profile: p });
    }
    return out;
  }, [profiles]);

  // Cursor moves only across profile rows. Find next/prev that isn't a header.
  const profileIndices = React.useMemo(
    () => rows.map((r, i) => (r.kind === "profile" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // On first load, position cursor at the current profile if we can find it.
  useEffect(() => {
    if (rows.length === 0) return;
    const cur = state.profile ?? process.env.AWS_PROFILE;
    if (cur) {
      const idx = rows.findIndex(
        (r) => r.kind === "profile" && r.profile.name === cur,
      );
      if (idx >= 0) {
        setCursor(idx);
        return;
      }
    }
    // Otherwise default to the first profile.
    if (profileIndices.length > 0) setCursor(profileIndices[0]!);
  }, [rows.length]);

  useInput((input, key) => {
    if (rows.length === 0) return;
    if (key.upArrow) {
      // Walk backwards over rows to find the previous profile.
      const order = profileIndices.slice().reverse();
      const next = order.find((i) => i < cursor);
      if (next !== undefined) setCursor(next);
    }
    if (key.downArrow) {
      const next = profileIndices.find((i) => i > cursor);
      if (next !== undefined) setCursor(next);
    }
    if (key.pageUp) {
      const target = Math.max(0, cursor - PAGE);
      const order = profileIndices.slice().reverse();
      const next = order.find((i) => i <= target) ?? profileIndices[0]!;
      setCursor(next);
    }
    if (key.pageDown) {
      const target = Math.min(rows.length - 1, cursor + PAGE);
      const next =
        profileIndices.find((i) => i >= target) ??
        profileIndices[profileIndices.length - 1]!;
      setCursor(next);
    }
    if (input === "g") setCursor(profileIndices[0] ?? 0);
    if (input === "G") setCursor(profileIndices[profileIndices.length - 1] ?? 0);
    if (key.return) {
      const r = rows[cursor];
      if (r?.kind === "profile") select(r.profile);
    }
  });

  const select = (picked: AwsProfile) => {
    process.env.AWS_PROFILE = picked.name;
    if (picked.region && !process.env.AWS_REGION) {
      process.env.AWS_REGION = picked.region;
    }
    // Wipe any stale env-var creds so the profile takes precedence.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    setState((s) => {
      const back = [...s.back];
      const prev = back.pop() ?? "home";
      const acctNote = picked.ssoAccountId
        ? ` (account ${picked.ssoAccountId})`
        : "";
      return {
        ...s,
        profile: picked.name,
        region: picked.region ?? s.region,
        screen: prev,
        back,
        suppressAuthAutoRoute: false,
        // Forget the previous account's STS readout; banner will refresh.
        identity: undefined,
        status: {
          text: `Profile → ${picked.name}${acctNote}${picked.isSso ? " (SSO; auth-error screen will pop if creds are expired)" : ""}`,
          tone: "ok",
        },
      };
    });
  };

  if (error) return <Text color="red">✘ {error}</Text>;
  if (!profiles)
    return (
      <Text>
        <Spinner type="dots" /> reading ~/.aws/config…
      </Text>
    );
  if (profiles.length === 0)
    return (
      <Box flexDirection="column">
        <Text>No AWS profiles found in ~/.aws/config or ~/.aws/credentials.</Text>
        <Text dimColor>Run `aws configure sso` then come back.</Text>
      </Box>
    );

  // Slice the rows around the cursor like Functions screen does.
  const start =
    rows.length <= PAGE
      ? 0
      : Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE));
  const visible = rows.slice(start, start + PAGE);

  const accounts = new Set(profiles.map((p) => p.ssoAccountId ?? "unknown"));

  return (
    <Box flexDirection="column">
      <Text bold>
        Switch AWS account / profile{" "}
        <Text dimColor>
          ({accounts.size} account{accounts.size === 1 ? "" : "s"} ·{" "}
          {profiles.length} profile{profiles.length === 1 ? "" : "s"})
        </Text>
      </Text>
      <Text dimColor>
        Profiles are grouped by sso_account_id. Pick a role profile to
        switch context — the banner at the top updates after the next AWS
        call confirms the new identity.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((r, i) => {
          const idx = start + i;
          if (r.kind === "header") {
            return (
              <Box key={`h-${r.accountId}-${idx}`} marginTop={idx === 0 ? 0 : 1}>
                <Text bold color="cyan">
                  ▸ Account {r.accountId}
                </Text>
                <Text dimColor>
                  {"  "}
                  {r.count} profile{r.count === 1 ? "" : "s"}
                </Text>
              </Box>
            );
          }
          const p = r.profile;
          const cur = state.profile ?? process.env.AWS_PROFILE;
          const isCurrent = p.name === cur;
          const highlighted = idx === cursor;
          return (
            <Box key={`p-${p.name}-${idx}`}>
              <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
                {highlighted ? "  ❯ " : "    "}
                {padR(p.name, 38)}
              </Text>
              <Text dimColor>
                {padR(p.ssoRoleName ?? (p.isSso ? "(no role)" : "non-SSO"), 18)}
                {padR(p.region ?? "—", 14)}
              </Text>
              {isCurrent && <Text color="green">  ← current</Text>}
            </Box>
          );
        })}
        {rows.length > PAGE && (
          <Text dimColor>
            {" "}
            showing {start + 1}–{Math.min(start + PAGE, rows.length)} of {rows.length}
          </Text>
        )}
      </Box>
    </Box>
  );
};

function groupByAccount(profiles: AwsProfile[]): AccountGroup[] {
  const map = new Map<string, AwsProfile[]>();
  for (const p of profiles) {
    const key = p.ssoAccountId ?? (p.isSso ? "unknown-sso" : "non-sso");
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  // Sort: known accounts (numeric IDs) first, ascending; then "unknown-sso";
  // then "non-sso" last.
  const groups: AccountGroup[] = [];
  for (const [accountId, items] of map.entries()) {
    items.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      accountId:
        accountId === "non-sso"
          ? "(non-SSO profiles)"
          : accountId === "unknown-sso"
            ? "(SSO, no account_id)"
            : accountId,
      profiles: items,
    });
  }
  groups.sort((a, b) => {
    const aN = /^\d+$/.test(a.accountId) ? 0 : 1;
    const bN = /^\d+$/.test(b.accountId) ? 0 : 1;
    if (aN !== bN) return aN - bN;
    return a.accountId.localeCompare(b.accountId);
  });
  return groups;
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}
