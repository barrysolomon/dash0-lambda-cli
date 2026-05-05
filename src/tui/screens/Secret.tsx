/**
 * Secret-inspect screen.
 *
 * Reads DASH0_TOKEN_SECRET_ARN from the focused function (or shows the
 * literal DASH0_TOKEN if that's what's wired). Token is redacted by
 * default; press R to reveal in full. Press B to go back.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { LambdaWrapper } from "../../lib/lambda.js";
import { inspectSecret, type InspectSecretResult } from "../../lib/secrets.js";
import { resolveTargets } from "../lib/targets.js";
import type { ScreenProps } from "../types.js";

interface State {
  loading: boolean;
  source?: "env" | "secret";
  arn?: string;
  envToken?: string;
  inspect?: InspectSecretResult;
  error?: string;
}

export const Secret: React.FC<ScreenProps> = ({ state, setState }) => {
  // Use the first resolved target (focused function or first selected).
  const fnName = resolveTargets(state).names[0];
  const [reveal, setReveal] = useState(false);
  const [s, setS] = useState<State>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    if (!fnName) return;
    (async () => {
      const lambda = new LambdaWrapper({ region: state.region, dryRun: true });
      try {
        const fn = await lambda.getFunction(fnName);
        if (cancelled) return;
        if (fn.env.DASH0_TOKEN) {
          setS({ loading: false, source: "env", envToken: fn.env.DASH0_TOKEN });
          return;
        }
        const arn = fn.env.DASH0_TOKEN_SECRET_ARN;
        if (!arn) {
          setS({
            loading: false,
            error:
              "Function has neither DASH0_TOKEN nor DASH0_TOKEN_SECRET_ARN set.",
          });
          return;
        }
        const r = await inspectSecret({
          region: state.region,
          arn,
          key: fn.env.DASH0_TOKEN_SECRET_KEY,
        });
        if (cancelled) return;
        setS({ loading: false, source: "secret", arn, inspect: r });
      } catch (err) {
        if (!cancelled)
          setS({ loading: false, error: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fnName, state.region]);

  useInput((input, key) => {
    if (input === "r" || input === "R") setReveal((v) => !v);
    if (input === "b" || input === "B" || key.escape) {
      setState((prev) => {
        const back = [...prev.back];
        const last = back.pop() ?? "home";
        return { ...prev, screen: last, back };
      });
    }
  });

  if (!fnName) {
    return (
      <Text dimColor>
        No function focused. Pick one on the Functions screen first (highlight a row, press 's').
      </Text>
    );
  }

  if (s.loading) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Reading secret for {fnName}…</Text>
      </Box>
    );
  }

  if (s.error) {
    return (
      <Box flexDirection="column">
        <Text color="red">✘ {s.error}</Text>
        <Text dimColor>Press B to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Dash0 token — {fnName}</Text>
      <Box marginTop={1} flexDirection="column">
        {s.source === "env" && s.envToken && (
          <>
            <Text>
              source: <Text color="cyan">DASH0_TOKEN</Text> (env var on the function)
            </Text>
            <Text>
              token: {reveal ? s.envToken : redact(s.envToken)}
            </Text>
          </>
        )}
        {s.source === "secret" && s.inspect && (
          <>
            <Text>
              source: <Text color="cyan">Secrets Manager</Text>
            </Text>
            <Text>arn:    {s.inspect.arn}</Text>
            {s.inspect.kmsKeyId && <Text>kms:    {s.inspect.kmsKeyId}</Text>}
            {typeof s.inspect.isJson === "boolean" && (
              <Text>shape:  {s.inspect.isJson ? "json" : "string"}</Text>
            )}
            {s.inspect.jsonKeys && s.inspect.jsonKeys.length > 0 && (
              <Text>keys:   {s.inspect.jsonKeys.join(", ")}</Text>
            )}
            {!s.inspect.exists || s.inspect.errorCode ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color="red">
                  ✘ {s.inspect.errorCode ?? "Unknown"} — {s.inspect.errorMessage ?? ""}
                </Text>
                {s.inspect.errorCode === "AccessDenied" && (
                  <Text dimColor>
                    The CLI's creds can't read this secret; the function's role probably can't either.
                  </Text>
                )}
              </Box>
            ) : s.inspect.tokenValue ? (
              <Text>
                token:  {reveal ? s.inspect.tokenValue : redact(s.inspect.tokenValue)}
              </Text>
            ) : (
              <Text dimColor>(no token value extracted)</Text>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>R reveal/hide · B back</Text>
      </Box>
    </Box>
  );
};

function redact(tok: string): string {
  if (tok.length <= 12) return "***";
  return `${tok.slice(0, 8)}…${tok.slice(-4)}`;
}
