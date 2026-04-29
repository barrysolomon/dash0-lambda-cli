/**
 * Auth-error screen — sectioned, hand-rolled list with modifier keys.
 *
 * Design:
 *   - One row per SSO profile. Three keystrokes act on the highlighted row:
 *       Enter → aws sso login                  (PKCE, the default)
 *       d     → aws sso login --use-device-code (fallback when PKCE callback fails)
 *       f     → aws sso logout && aws sso login (clears stale cache first)
 *   - Sectioned: "Sign in with SSO" / "Other ways" / "Continue without signing in",
 *     same pattern as Home.tsx.
 *   - $AWS_PROFILE (if set and SSO-capable) is sorted to the top — that's
 *     usually the user's most recent intent.
 *
 * The aws CLI is spawned with PIPE stdio (not inherit) — handing stdio to
 * the child previously deadlocked with Ink's raw-mode stdin handling.
 * Both PKCE and device-code stream into a log panel below the spinner so
 * the user can copy device codes without losing the screen.
 */

import React, { useEffect, useRef, useState } from "react";
import { spawn, type ChildProcess } from "node:child_process";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { listProfiles, type AwsProfile } from "../../menu/aws-profiles.js";
import type { ScreenProps } from "../types.js";

type Mode =
  | "menu"
  | "running"
  | "verifying"
  | "verified"
  | "verify-failed"
  | "manual-key"
  | "manual-secret"
  | "manual-session";

type Row =
  | { kind: "header"; label: string }
  | {
      kind: "sso";
      profile: string;
      region?: string;
      hint: string;
    }
  | {
      kind: "action";
      label: string;
      value: "manual" | "configure" | "retry" | "skip" | "quit";
      hint: string;
    };

export const AuthError: React.FC<ScreenProps> = ({ state, setState }) => {
  const [profiles, setProfiles] = useState<AwsProfile[] | undefined>();
  const [mode, setMode] = useState<Mode>("menu");
  const [verifyError, setVerifyError] = useState<string | undefined>();
  const [accessKey, setAccessKey] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [runningCmd, setRunningCmd] = useState<string>("");
  /**
   * Live handle to the currently-running `aws` subprocess so we can kill
   * it on Esc/q. Without this, an `aws sso login` that waits forever for
   * a browser callback we'll never complete (e.g. user closed the tab,
   * lost the localhost callback) keeps us trapped in `running` mode and
   * orphans the process when the TUI exits.
   */
  const childRef = useRef<ChildProcess | null>(null);
  /**
   * Set true when the user cancels. Multi-step flows (e.g. `fresh` =
   * logout-then-login) check this between steps so we don't barrel into
   * the next subprocess after the user already bailed.
   */
  const cancelledRef = useRef(false);
  const { exit } = useApp();

  useEffect(() => {
    listProfiles().then(setProfiles);
  }, []);

  // Re-probe sts:GetCallerIdentity. Pop back on success.
  useEffect(() => {
    if (mode !== "verifying") return;
    let cancelled = false;
    const region = process.env.AWS_REGION ?? state.region;
    const sts = new STSClient({ region, maxAttempts: 1 });
    sts
      .send(new GetCallerIdentityCommand({}))
      .then((out) => {
        if (cancelled) return;
        setMode("verified");
        setState((s) => {
          const back = [...s.back];
          const prev = back.pop() ?? "home";
          return {
            ...s,
            screen: prev,
            back,
            suppressAuthAutoRoute: false,
            identity: {
              account: out.Account,
              arn: out.Arn,
              userId: out.UserId,
              region,
            },
            profile: process.env.AWS_PROFILE ?? s.profile,
            status: { text: `Verified: account ${out.Account ?? "?"}`, tone: "ok" },
          };
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setVerifyError((err as Error).message);
        setMode("verify-failed");
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const ssoProfiles = orderedSsoProfiles(profiles, process.env.AWS_PROFILE);
  const rows = buildRows(ssoProfiles);

  const firstSelectable = rows.findIndex(
    (r) => r.kind === "sso" || r.kind === "action",
  );
  const [cursor, setCursor] = useState(firstSelectable);

  // Re-clamp cursor when rows shape changes (e.g. profiles loaded).
  useEffect(() => {
    if (cursor >= rows.length || !isSelectable(rows[cursor])) {
      const next = rows.findIndex((r) => isSelectable(r));
      setCursor(next >= 0 ? next : 0);
    }
  }, [rows.length]);

  // ── Spawn aws as a subprocess; PIPE stdio. ──────────────────────────
  function runAwsPiped(args: string[], setProfileEnv?: string): Promise<number> {
    return new Promise((resolve) => {
      setLogLines([]);
      setRunningCmd("aws " + args.join(" "));
      if (setProfileEnv) process.env.AWS_PROFILE = setProfileEnv;
      const child = spawn("aws", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      childRef.current = child;
      const append = (chunk: Buffer) => {
        const text = chunk.toString();
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length > 0) {
          setLogLines((prev) => [...prev, ...lines].slice(-30));
        }
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => {
        setLogLines((prev) =>
          [...prev, `spawn error: ${err.message}`].slice(-30),
        );
        if (childRef.current === child) childRef.current = null;
        resolve(127);
      });
      child.on("exit", (code) => {
        if (childRef.current === child) childRef.current = null;
        resolve(code ?? 1);
      });
    });
  }

  /** Kill the running child and return to the menu. Idempotent. */
  const cancelRunning = () => {
    cancelledRef.current = true;
    const child = childRef.current;
    if (child && child.exitCode === null && child.signalCode === null) {
      // SIGTERM first; aws-cli usually wraps up cleanly. The 'exit' handler
      // attached in runAwsPiped clears childRef and resolves the promise,
      // which lets the spawning function continue and (because we set
      // mode here) won't override our menu transition.
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore — child may have died between the null check and the kill.
      }
    }
    setMode("menu");
    setLogLines([]);
    setRunningCmd("");
  };

  // Make sure we never orphan the child if the screen unmounts (e.g. the
  // user navigates away via App's global esc-to-back).
  useEffect(() => {
    return () => {
      const child = childRef.current;
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore.
        }
      }
    };
  }, []);

  const triggerSso = async (
    profile: string,
    method: "pkce" | "device" | "fresh",
  ) => {
    cancelledRef.current = false;
    setMode("running");
    if (method === "fresh") {
      const logoutArgs = ["sso", "logout"];
      if (profile) logoutArgs.push("--profile", profile);
      await runAwsPiped(logoutArgs, profile || undefined);
      // If the user hit q/Esc during logout, don't kick off the login.
      if (cancelledRef.current) return;
    }
    const args = ["sso", "login"];
    if (profile) args.push("--profile", profile);
    if (method === "device") args.push("--use-device-code");
    const code = await runAwsPiped(args, profile || undefined);
    if (cancelledRef.current) return; // cancelRunning already set mode = "menu"
    setMode(code === 0 ? "verifying" : "menu");
  };

  const triggerAction = async (value: "manual" | "configure" | "retry" | "skip" | "quit") => {
    if (value === "retry") return setMode("verifying");
    if (value === "manual") return setMode("manual-key");
    if (value === "configure") {
      cancelledRef.current = false;
      setMode("running");
      await runAwsPiped(["configure", "sso"]);
      if (cancelledRef.current) return;
      setMode("verifying");
      return;
    }
    if (value === "skip") {
      setState((s) => {
        const back = [...s.back];
        const prev = back.pop() ?? "home";
        return { ...s, screen: prev, back, suppressAuthAutoRoute: true };
      });
      return;
    }
    if (value === "quit") return exit();
  };

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    // While a subprocess is running (or aws configure sso), let the user
    // bail out: q cancels in place, Esc also cancels (App's global Esc
    // handler will additionally pop the screen, which is acceptable —
    // unmount cleanup kills the child either way).
    if (mode === "running") {
      if (input === "q" || key.escape) cancelRunning();
      return;
    }
    if (mode !== "menu") {
      // verifying / verify-failed / manual-* — let R retry, no other
      // keys handled here (verify-failed and manual-* own their own keys).
      if (input === "r" || input === "R") setMode("verifying");
      return;
    }

    // Menu mode.
    if (key.upArrow) setCursor((c) => stepCursor(rows, c, -1));
    if (key.downArrow) setCursor((c) => stepCursor(rows, c, +1));
    const cur = rows[cursor];
    if (key.return) {
      if (cur?.kind === "sso") void triggerSso(cur.profile, "pkce");
      else if (cur?.kind === "action") void triggerAction(cur.value);
    }
    // Modifier keys only meaningful on SSO rows.
    if (cur?.kind === "sso") {
      if (input === "d") void triggerSso(cur.profile, "device");
      if (input === "f") void triggerSso(cur.profile, "fresh");
    }
    // Global retry — works on any row.
    if (input === "R") setMode("verifying");
    // q quits the TUI from the menu. App's global q handler is gated to
    // the home screen, so we own this key here.
    if (input === "q") exit();
  });

  // ── Render: subprocess running (PKCE / device-code / configure) ────
  if (mode === "running") {
    return (
      <Box flexDirection="column">
        <Text>
          <Spinner type="dots" /> {runningCmd}
        </Text>
        <Text dimColor>
          Browser should pop. Watch the panel below — for device-code the AWS
          CLI prints a verification code; copy it and paste in the browser.
          For PKCE just complete auth in the tab and return here.
        </Text>
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
          height={12}
        >
          {logLines.length === 0 ? (
            <Text dimColor>(waiting for AWS CLI output…)</Text>
          ) : (
            logLines.slice(-10).map((l, i) => <Text key={i}>{l}</Text>)
          )}
        </Box>
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>
            Closed the browser tab or stuck waiting? Press{" "}
            <Text bold>q</Text> to cancel and return to the menu, or{" "}
            <Text bold>esc</Text> to cancel and go back.
          </Text>
        </Box>
      </Box>
    );
  }
  if (mode === "verifying") {
    return (
      <Text>
        <Spinner type="dots" /> verifying with sts:GetCallerIdentity…
      </Text>
    );
  }
  if (mode === "verify-failed") {
    return (
      <VerifyFailed
        error={verifyError ?? "unknown error"}
        onRetry={() => setMode("verifying")}
        onBack={() => setMode("menu")}
        onSkip={() =>
          setState((s) => {
            const back = [...s.back];
            const prev = back.pop() ?? "home";
            return { ...s, screen: prev, back, suppressAuthAutoRoute: true };
          })
        }
        onQuit={() => exit()}
      />
    );
  }
  if (mode === "manual-key") {
    return (
      <Box flexDirection="column">
        <Text bold>Paste AWS_ACCESS_KEY_ID</Text>
        <Box marginTop={1}>
          <Text>Access Key ID: </Text>
          <TextInput
            value={accessKey}
            onChange={setAccessKey}
            onSubmit={(v) => {
              if (!/^[A-Z0-9]{16,}$/i.test(v.trim())) return;
              setAccessKey(v.trim());
              setMode("manual-secret");
            }}
          />
        </Box>
      </Box>
    );
  }
  if (mode === "manual-secret") {
    return (
      <Box flexDirection="column">
        <Text bold>Paste AWS_SECRET_ACCESS_KEY (input hidden)</Text>
        <Box marginTop={1}>
          <Text>Secret: </Text>
          <TextInput
            value={secret}
            onChange={setSecret}
            mask="*"
            onSubmit={(v) => {
              if (v.trim().length < 16) return;
              setSecret(v.trim());
              setMode("manual-session");
            }}
          />
        </Box>
      </Box>
    );
  }
  if (mode === "manual-session") {
    return (
      <Box flexDirection="column">
        <Text bold>Paste AWS_SESSION_TOKEN (or leave blank for permanent keys)</Text>
        <Box marginTop={1}>
          <Text>Session token: </Text>
          <TextInput
            value={sessionToken}
            onChange={setSessionToken}
            mask="*"
            onSubmit={(v) => {
              process.env.AWS_ACCESS_KEY_ID = accessKey;
              process.env.AWS_SECRET_ACCESS_KEY = secret;
              if (v.trim()) process.env.AWS_SESSION_TOKEN = v.trim();
              else delete process.env.AWS_SESSION_TOKEN;
              delete process.env.AWS_PROFILE;
              setMode("verifying");
            }}
          />
        </Box>
      </Box>
    );
  }

  // ── Render: the menu itself ────────────────────────────────────────
  const focusedRow = rows[cursor];
  const contextHint =
    focusedRow?.kind === "sso"
      ? focusedRow.hint
      : focusedRow?.kind === "action"
        ? focusedRow.hint
        : undefined;

  return (
    <Box flexDirection="column">
      <Text bold color="red">
        ✘ AWS auth needed
      </Text>
      <Text dimColor>
        AWS_PROFILE={process.env.AWS_PROFILE ?? "(unset)"}
        {"  "}AWS_REGION={process.env.AWS_REGION ?? "(unset)"}
      </Text>
      {!profiles ? (
        <Box marginTop={1}>
          <Text>
            <Spinner type="dots" /> reading ~/.aws/config…
          </Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            {rows.map((r, i) => (
              <RowView key={i} row={r} highlighted={i === cursor} />
            ))}
          </Box>
          {contextHint && (
            <Box marginTop={1} paddingX={1}>
              <Text dimColor>{contextHint}</Text>
            </Box>
          )}
          <Box marginTop={1} paddingX={1}>
            <Text dimColor>
              <Text bold>⏎</Text> sign in (PKCE) ·{" "}
              <Text bold>d</Text> device-code ·{" "}
              <Text bold>f</Text> force fresh login ·{" "}
              <Text bold>R</Text> retry verify ·{" "}
              <Text bold>q</Text> quit
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};

const RowView: React.FC<{ row: Row; highlighted: boolean }> = ({
  row,
  highlighted,
}) => {
  if (row.kind === "header") {
    return (
      <Box marginTop={1}>
        <Text bold color="cyan">
          {row.label}
        </Text>
      </Box>
    );
  }
  if (row.kind === "sso") {
    return (
      <Box paddingLeft={2}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {highlighted ? "❯ " : "  "}
          {row.profile}
        </Text>
        {row.region && (
          <Text dimColor>
            {"  "}
            {row.region}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
        {highlighted ? "❯ " : "  "}
        {row.label}
      </Text>
    </Box>
  );
};

const VerifyFailed: React.FC<{
  error: string;
  onRetry: () => void;
  onBack: () => void;
  onSkip: () => void;
  onQuit: () => void;
}> = ({ error, onRetry, onBack, onSkip, onQuit }) => {
  const items: Array<{
    label: string;
    value: "again" | "retry" | "skip" | "quit";
  }> = [
    { label: "Pick a different option", value: "again" },
    { label: "Retry verify (R)", value: "retry" },
    { label: "Skip — let me into the TUI anyway", value: "skip" },
    { label: "Quit the TUI", value: "quit" },
  ];
  const [cursor, setCursor] = useState(0);
  useInput((_, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (key.return) {
      const v = items[cursor]!.value;
      if (v === "retry") onRetry();
      else if (v === "skip") onSkip();
      else if (v === "quit") onQuit();
      else onBack();
    }
  });
  return (
    <Box flexDirection="column">
      <Text color="red">✘ Verify failed: {error}</Text>
      <Text dimColor>
        Browser said success but the CLI couldn't verify? AWS CLI v2.22 made
        PKCE the default — if the localhost callback didn't reach back, try
        device-code (d). Or force fresh login (f) to wipe a stale cache.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((it, i) => (
          <Box key={it.value} paddingLeft={2}>
            <Text color={i === cursor ? "cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}
              {it.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────

function isSelectable(r: Row | undefined): boolean {
  return !!r && (r.kind === "sso" || r.kind === "action");
}

function stepCursor(rows: Row[], from: number, direction: -1 | 1): number {
  const n = rows.length;
  if (n === 0) return 0;
  let i = from;
  for (let steps = 0; steps < n; steps++) {
    i = (i + direction + n) % n;
    if (isSelectable(rows[i])) return i;
  }
  return from;
}

/**
 * Sort SSO profiles so the user's current $AWS_PROFILE (if SSO-capable)
 * appears first — that's their most recent intent. Everything else is
 * alphabetical.
 */
function orderedSsoProfiles(
  profiles: AwsProfile[] | undefined,
  current: string | undefined,
): AwsProfile[] {
  if (!profiles) return [];
  const sso = profiles.filter((p) => p.isSso);
  if (!current) return sso;
  const idx = sso.findIndex((p) => p.name === current);
  if (idx <= 0) return sso;
  const head = sso[idx]!;
  const rest = sso.filter((_, i) => i !== idx);
  return [head, ...rest];
}

function buildRows(ssoProfiles: AwsProfile[]): Row[] {
  const rows: Row[] = [];
  rows.push({ kind: "header", label: "Sign in with SSO" });
  if (ssoProfiles.length === 0) {
    rows.push({
      kind: "action",
      label: "Run aws configure sso (first-time setup)",
      value: "configure",
      hint: "Walks through aws configure sso. Use this if you've never set up SSO before.",
    });
  } else {
    for (const p of ssoProfiles) {
      rows.push({
        kind: "sso",
        profile: p.name,
        region: p.region,
        hint:
          "⏎ runs aws sso login (PKCE). Press d for device-code if PKCE's localhost callback fails. " +
          "Press f to wipe the cache and start fresh — useful if a prior login on a different account is still cached.",
      });
    }
  }
  rows.push({ kind: "header", label: "Other ways" });
  rows.push({
    kind: "action",
    label: "Paste temporary credentials",
    value: "manual",
    hint: "Use this when you have AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN from another tool.",
  });
  if (ssoProfiles.length > 0) {
    rows.push({
      kind: "action",
      label: "Run aws configure sso (set up a new profile)",
      value: "configure",
      hint: "Add another SSO profile to ~/.aws/config.",
    });
  }
  rows.push({ kind: "header", label: "Continue without signing in" });
  rows.push({
    kind: "action",
    label: "Retry verify",
    value: "retry",
    hint: "If you ran aws sso login in another terminal, hit this (or R) to re-probe.",
  });
  rows.push({
    kind: "action",
    label: "Skip — read-only mode",
    value: "skip",
    hint: "Drops you into the TUI with no credentials. Read-only screens (Generate, Help) still work.",
  });
  rows.push({
    kind: "action",
    label: "Quit",
    value: "quit",
    hint: "Exit the TUI; use the flag-driven CLI (dash0-lambda install …) instead.",
  });
  return rows;
}
