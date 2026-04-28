/**
 * Auth-error screen.
 *
 * Five escape hatches so you never get stuck:
 *   1. Run `aws sso login` (PKCE or device-code) — child stdout/stderr
 *      streams into an in-screen log panel. We do NOT hand stdio to the
 *      child (that previously caused a deadlock with Ink's raw-mode
 *      stdin handling). Both PKCE and device-code work this way:
 *        - PKCE: AWS CLI auto-opens the browser; we just wait for the
 *          process to exit.
 *        - Device-code: AWS CLI prints a code in stdout; user copies it
 *          from the log panel and pastes in the browser tab.
 *   2. "Force fresh login" — runs `aws sso logout` first, then login.
 *   3. Set AWS access key / secret / session by paste — fastest with
 *      temp creds from another source.
 *   4. "Skip" — sets suppressAuthAutoRoute so read-only screens still work.
 *   5. "Quit" — clean exit so flag-driven commands take over.
 */

import React, { useEffect, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
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

export const AuthError: React.FC<ScreenProps> = ({ state, setState }) => {
  const [profiles, setProfiles] = useState<AwsProfile[] | undefined>();
  const [mode, setMode] = useState<Mode>("menu");
  const [verifyError, setVerifyError] = useState<string | undefined>();
  const [accessKey, setAccessKey] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [runningCmd, setRunningCmd] = useState<string>("");
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

  useInput((input) => {
    if (mode === "menu" && (input === "r" || input === "R")) setMode("verifying");
  });

  const ssoProfiles = profiles?.filter((p) => p.isSso) ?? [];

  type Choice = {
    label: string;
    value:
      | `pkce:${string}`
      | `device:${string}`
      | `fresh:${string}`
      | "retry"
      | "configure"
      | "manual"
      | "skip"
      | "quit";
  };
  const choices: Choice[] = [];
  for (const p of ssoProfiles) {
    choices.push({
      label: `Run: aws sso login --profile ${p.name}  ${p.region ? `(${p.region})` : ""}`,
      value: `pkce:${p.name}`,
    });
    choices.push({
      label: `Run: aws sso login --profile ${p.name} --use-device-code`,
      value: `device:${p.name}`,
    });
    choices.push({
      label: `Force fresh login (logout first): --profile ${p.name}`,
      value: `fresh:${p.name}`,
    });
  }
  if (process.env.AWS_PROFILE && !ssoProfiles.find((p) => p.name === process.env.AWS_PROFILE)) {
    const cur = process.env.AWS_PROFILE;
    choices.push({ label: `Run: aws sso login --profile ${cur}`, value: `pkce:${cur}` });
    choices.push({
      label: `Run: aws sso login --profile ${cur} --use-device-code`,
      value: `device:${cur}`,
    });
  }
  if (choices.length === 0) {
    choices.push({ label: "Run: aws sso login (default)", value: "pkce:" });
    choices.push({
      label: "Run: aws sso login --use-device-code (default)",
      value: "device:",
    });
    choices.push({ label: "Run: aws configure sso", value: "configure" });
  }
  choices.push({
    label: "Set AWS access key / secret / session token by paste",
    value: "manual",
  });
  choices.push({ label: "I fixed it manually elsewhere — retry verify (R)", value: "retry" });
  choices.push({
    label: "Skip — let me into the TUI anyway (read-only screens still work)",
    value: "skip",
  });
  choices.push({ label: "Quit the TUI (use flag-driven commands instead)", value: "quit" });

  // ── Spawn aws as a subprocess; PIPE stdio (not inherit). Output streams
  // into the log panel below the spinner so the user sees PKCE URLs and
  // device codes without us giving up the screen. ────────────────────
  function runAwsPiped(args: string[], setProfileEnv?: string): Promise<number> {
    return new Promise((resolve) => {
      setLogLines([]);
      setRunningCmd("aws " + args.join(" "));
      if (setProfileEnv) process.env.AWS_PROFILE = setProfileEnv;
      const child = spawn("aws", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
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
        resolve(127);
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
  }

  // ── Render ─────────────────────────────────────────────────────
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
      <Box flexDirection="column">
        <Text color="red">✘ Verify failed: {verifyError}</Text>
        <Text dimColor>
          Browser said success but CLI auth failed? AWS CLI v2.22 made PKCE
          the default — if the localhost callback didn't reach back, try the
          --use-device-code option. Or "Force fresh login" to wipe a stale
          cache.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { key: "again", label: "Pick a different option", value: "again" },
              { key: "retry", label: "Retry verify (R)", value: "retry" },
              { key: "skip", label: "Skip — let me into the TUI anyway", value: "skip" },
              { key: "quit", label: "Quit the TUI", value: "quit" },
            ]}
            onSelect={(i) => {
              if (i.value === "retry") setMode("verifying");
              else if (i.value === "skip") {
                setState((s) => {
                  const back = [...s.back];
                  const prev = back.pop() ?? "home";
                  return { ...s, screen: prev, back, suppressAuthAutoRoute: true };
                });
              } else if (i.value === "quit") exit();
              else setMode("menu");
            }}
          />
        </Box>
      </Box>
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

  return (
    <Box flexDirection="column">
      <Text bold color="red">
        ✘ AWS auth error
      </Text>
      <Text dimColor>
        AWS_PROFILE={process.env.AWS_PROFILE ?? "(not set)"}{" · "}
        AWS_REGION={process.env.AWS_REGION ?? "(not set)"}
      </Text>
      <Text dimColor>
        Note: aws sso login uses a cached token at ~/.aws/sso/cache. If a
        previous login (possibly with a different account) is still cached,
        the browser tab may open + close without you doing anything and the
        CLI succeeds — using the cached creds. Pick "Force fresh login" to
        wipe the cache first.
      </Text>
      <Text dimColor>
        Stuck in a loop? "Skip" lets you into read-only screens, "Set AWS
        env vars manually" if you have temp creds from elsewhere, "Quit" to
        bail to flag-driven commands.
      </Text>
      {!profiles ? (
        <Box marginTop={1}>
          <Text>
            <Spinner type="dots" /> reading ~/.aws/config…
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <SelectInput
            items={choices.map((c, i) => ({ key: `${c.value}-${i}`, label: c.label, value: c.value }))}
            onSelect={async (item) => {
              const v = item.value as Choice["value"];
              if (v === "retry") return setMode("verifying");
              if (v === "configure") {
                setMode("running");
                await runAwsPiped(["configure", "sso"]);
                setMode("verifying");
                return;
              }
              if (v === "manual") return setMode("manual-key");
              if (v === "skip") {
                setState((s) => {
                  const back = [...s.back];
                  const prev = back.pop() ?? "home";
                  return { ...s, screen: prev, back, suppressAuthAutoRoute: true };
                });
                return;
              }
              if (v === "quit") return exit();
              const [kind, profile] = v.split(":") as
                | ["pkce" | "device", string]
                | ["fresh", string];
              if (kind === "fresh") {
                setMode("running");
                const logoutArgs = ["sso", "logout"];
                if (profile) logoutArgs.push("--profile", profile);
                await runAwsPiped(logoutArgs, profile || undefined);
                const loginArgs = ["sso", "login"];
                if (profile) loginArgs.push("--profile", profile);
                const code = await runAwsPiped(loginArgs, profile || undefined);
                setMode(code === 0 ? "verifying" : "menu");
                return;
              }
              setMode("running");
              const args = ["sso", "login"];
              if (profile) args.push("--profile", profile);
              if (kind === "device") args.push("--use-device-code");
              const code = await runAwsPiped(args, profile || undefined);
              setMode(code === 0 ? "verifying" : "menu");
            }}
            limit={Math.min(choices.length, 14)}
          />
        </Box>
      )}
    </Box>
  );
};
