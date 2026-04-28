/**
 * Validate screen — runs the doctor checks. Supports single-function
 * (with a live CloudWatch log tailer) and bulk (a summary table across
 * the selected set, no log tailer per-row to keep the screen readable).
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { validate, type CheckResult } from "../../commands/validate.js";
import type { ScreenProps } from "../types.js";
import { useFunctionList } from "../hooks/useFunctionList.js";
import { resolveTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";

export const Validate: React.FC<ScreenProps> = ({ state, setState }) => {
  const targets = resolveTargets(state);
  if (targets.names.length === 0) return <PickThenValidate state={state} setState={setState} />;
  if (targets.names.length === 1) {
    return <ValidateOne region={state.region} functionName={targets.names[0]!} />;
  }
  return <ValidateMany region={state.region} functionNames={targets.names} />;
};

const PickThenValidate: React.FC<ScreenProps> = ({ state, setState }) => {
  const { functions, loading } = useFunctionList(state.region);
  if (loading)
    return (
      <Text>
        <Spinner type="dots" /> loading…
      </Text>
    );
  if (functions.length === 0) return <Text>No functions in this region.</Text>;
  setTimeout(
    () =>
      setState((s) => ({
        ...s,
        back: [...s.back, "validate"],
        screen: "functions",
      })),
    0,
  );
  return <Text dimColor>No selection. Sending you to Functions to pick…</Text>;
};

const ValidateOne: React.FC<{ region: string; functionName: string }> = ({
  region,
  functionName,
}) => {
  const [checks, setChecks] = useState<CheckResult[] | undefined>();
  const [pass, setPass] = useState<boolean | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setChecks(undefined);
    setError(undefined);
    captureConsole({ onLine: () => undefined }, async () => {
      try {
        const r = await validate({ function: functionName, region });
        if (cancelled) return;
        setChecks(r.checks);
        setPass(r.pass);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [region, functionName]);

  return (
    <Box flexDirection="column">
      <Text bold>Doctor — {functionName}</Text>
      <Box marginTop={1} flexDirection="column">
        {checks ? (
          <>
            {checks.map((ck, i) => (
              <CheckRow key={i} check={ck} />
            ))}
            <Box marginTop={1}>
              {pass ? (
                <Text color="green">✔ All checks passed.</Text>
              ) : (
                <Text color="red">
                  ✘ {checks.filter((c) => c.level === "fail").length} failure(s),{" "}
                  {checks.filter((c) => c.level === "warn").length} warning(s).
                </Text>
              )}
            </Box>
          </>
        ) : error ? (
          <Text color="red">✘ {error}</Text>
        ) : (
          <Text>
            <Spinner type="dots" /> running checks…
          </Text>
        )}
      </Box>
      <LogTailer region={region} functionName={functionName} />
    </Box>
  );
};

interface BulkRow {
  name: string;
  status: "pending" | "running" | "ok" | "fail" | "error";
  failures: number;
  warnings: number;
  message?: string;
}

const ValidateMany: React.FC<{
  region: string;
  functionNames: string[];
}> = ({ region, functionNames }) => {
  const [rows, setRows] = useState<BulkRow[]>(() =>
    functionNames.map((n) => ({ name: n, status: "pending", failures: 0, warnings: 0 })),
  );

  useEffect(() => {
    let cancelled = false;
    void captureConsole({ onLine: () => undefined }, async () => {
      for (const name of functionNames) {
        if (cancelled) break;
        setRows((rs) =>
          rs.map((r) => (r.name === name ? { ...r, status: "running" } : r)),
        );
        try {
          const r = await validate({ function: name, region });
          if (cancelled) break;
          const failures = r.checks.filter((c) => c.level === "fail").length;
          const warnings = r.checks.filter((c) => c.level === "warn").length;
          setRows((rs) =>
            rs.map((row) =>
              row.name === name
                ? { ...row, status: r.pass ? "ok" : "fail", failures, warnings }
                : row,
            ),
          );
        } catch (err) {
          if (cancelled) break;
          setRows((rs) =>
            rs.map((row) =>
              row.name === name
                ? { ...row, status: "error", message: (err as Error).message, failures: 0, warnings: 0 }
                : row,
            ),
          );
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [region, functionNames.join("|")]);

  const done = rows.filter((r) => r.status !== "pending" && r.status !== "running").length;
  const okCount = rows.filter((r) => r.status === "ok").length;
  const failCount = rows.filter((r) => r.status === "fail" || r.status === "error").length;

  return (
    <Box flexDirection="column">
      <Text bold>
        Doctor — {functionNames.length} functions{" "}
        <Text dimColor>
          ({done}/{functionNames.length} done · {okCount} pass · {failCount} fail)
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{"  "}</Text>
          <Text bold>{padR("function", 38)}</Text>
          <Text bold>{padR("status", 12)}</Text>
          <Text bold>{padR("fail", 6)}</Text>
          <Text bold>warn</Text>
        </Box>
        {rows.map((r) => (
          <BulkRowView key={r.name} row={r} />
        ))}
      </Box>
    </Box>
  );
};

const BulkRowView: React.FC<{ row: BulkRow }> = ({ row }) => {
  const icon =
    row.status === "ok" ? (
      <Text color="green">✔</Text>
    ) : row.status === "fail" || row.status === "error" ? (
      <Text color="red">✘</Text>
    ) : row.status === "running" ? (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    ) : (
      <Text dimColor>·</Text>
    );
  const statusText =
    row.status === "ok"
      ? "ok"
      : row.status === "fail"
        ? "needs fix"
        : row.status === "error"
          ? "error"
          : row.status === "running"
            ? "running"
            : "queued";
  return (
    <Box>
      <Text>{icon} </Text>
      <Text>{padR(row.name, 38)}</Text>
      <Text dimColor={row.status !== "fail" && row.status !== "error"}>
        {padR(statusText, 12)}
      </Text>
      <Text>{padR(String(row.failures), 6)}</Text>
      <Text>{row.warnings}</Text>
      {row.message && <Text color="red">  {row.message}</Text>}
    </Box>
  );
};

const CheckRow: React.FC<{ check: CheckResult }> = ({ check }) => {
  const icon =
    check.level === "ok" ? (
      <Text color="green">✔</Text>
    ) : check.level === "warn" ? (
      <Text color="yellow">!</Text>
    ) : (
      <Text color="red">✘</Text>
    );
  return (
    <Box>
      <Text>{icon} </Text>
      <Text bold>{padR(check.name, 18)}</Text>
      <Text> {check.message}</Text>
      {check.fix && check.level !== "ok" && (
        <Text dimColor>  · fix: {check.fix}</Text>
      )}
    </Box>
  );
};

const LogTailer: React.FC<{ region: string; functionName: string }> = ({
  region,
  functionName,
}) => {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let lastTime = Date.now() - 5 * 60 * 1000;
    const logs = new CloudWatchLogsClient({ region });
    const tick = async () => {
      try {
        const out = await logs.send(
          new FilterLogEventsCommand({
            logGroupName: `/aws/lambda/${functionName}`,
            startTime: lastTime,
            limit: 50,
          }),
        );
        if (cancelled) return;
        const events = out.events ?? [];
        if (events.length > 0) {
          const newLines = events.map(
            (e) => `${new Date(e.timestamp ?? 0).toISOString().slice(11, 19)}  ${(e.message ?? "").trim()}`,
          );
          setLines((prev) => [...prev, ...newLines].slice(-15));
          lastTime = Math.max(...events.map((e) => e.timestamp ?? lastTime)) + 1;
        }
      } catch (err) {
        const e = err as Error & { name?: string };
        if (e.name === "AccessDeniedException" || e.name === "ResourceNotFoundException") {
          setAccessDenied(true);
        } else {
          setError(e.message);
        }
      }
    };
    tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [region, functionName]);

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold dimColor>
        live logs (/aws/lambda/{functionName})
      </Text>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        height={9}
      >
        {accessDenied ? (
          <Text dimColor>
            (no logs:Access not permitted on /aws/lambda/{functionName} — invoke the function or grant logs:FilterLogEvents)
          </Text>
        ) : error ? (
          <Text color="red">✘ {error}</Text>
        ) : lines.length === 0 ? (
          <Text dimColor>
            <Spinner type="dots" /> watching for log events…
          </Text>
        ) : (
          lines.slice(-7).map((l, i) => (
            <Text key={i} dimColor={!/dash0-extension/i.test(l)}>
              {l.length > 110 ? l.slice(0, 109) + "…" : l}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
};

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
