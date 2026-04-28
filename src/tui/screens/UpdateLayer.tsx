/**
 * Update-layer screen.
 *
 * Two entry points:
 *   - From the Home menu (no selection / focus) → scan every function in
 *     the region, surface the ones with a Dash0 layer attached, default-
 *     select the out-of-date ones.
 *   - From the Functions screen (highlight a row or ␣-select a set, then U)
 *     → only inspect those names.
 *
 * Once loaded, the screen acts as a multi-select table:
 *   ↑↓ navigate · ␣ toggle · A select-all-out-of-date · x clear
 *   ⏎ apply  ·  r refresh  ·  esc back
 *
 * Apply iterates the selected rows only and runs updateLayer() per row,
 * streaming each command's output into a log panel.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { LambdaWrapper } from "../../lib/lambda.js";
import {
  KNOWN_LATEST_LAYER_VERSION,
  parseDash0LayerArn,
} from "../../lib/layers.js";
import { updateLayer } from "../../commands/updateLayer.js";
import { resolveTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";
import type { ScreenProps } from "../types.js";

type RowStatus = "loading" | "ready" | "noop" | "blocked" | "downgrade";

interface PlanRow {
  name: string;
  family?: string;
  current?: number;
  target?: number;
  status: RowStatus;
  blocker?: string;
}

type Stage = "loading" | "review" | "applying" | "done" | "error";
type Mode = "scan-all" | "targeted";

const PAGE = 14;

export const UpdateLayer: React.FC<ScreenProps> = ({ state }) => {
  // Decide mode from incoming state.
  const incoming = resolveTargets(state).names;
  const mode: Mode = incoming.length > 0 ? "targeted" : "scan-all";

  const [stage, setStage] = useState<Stage>("loading");
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [refreshTick, setRefreshTick] = useState(0);

  // Load + classify.
  useEffect(() => {
    let cancelled = false;
    setStage("loading");
    setRows([]);
    (async () => {
      const lambda = new LambdaWrapper({ region: state.region, dryRun: true });
      const initial: PlanRow[] = [];
      try {
        if (mode === "targeted") {
          for (const name of incoming) {
            initial.push({ name, status: "loading" });
          }
          setRows([...initial]);
          for (let i = 0; i < incoming.length; i++) {
            if (cancelled) return;
            initial[i] = await classify(lambda, incoming[i]!);
            setRows([...initial]);
          }
        } else {
          // Scan every function in the region; only keep those with a
          // Dash0 layer (uninstalled functions don't belong here — use
          // `install` instead).
          for await (const fn of lambda.listFunctions()) {
            if (cancelled) return;
            const dash0 = fn.layers
              .map((l) => parseDash0LayerArn(l.Arn ?? ""))
              .find((x) => x !== null);
            if (!dash0) continue;
            const target = KNOWN_LATEST_LAYER_VERSION[dash0.family];
            const current = dash0.version ?? 0;
            const status: RowStatus =
              current === target
                ? "noop"
                : target < current
                  ? "downgrade"
                  : "ready";
            initial.push({
              name: fn.functionName,
              family: dash0.family,
              current,
              target,
              status,
            });
            // Stream rows into the screen as we discover them — the user
            // sees the list grow rather than waiting for the full scan.
            setRows([...initial]);
          }
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      if (cancelled) return;
      // Sort: out-of-date (ready) first, then downgrade, then noop, then blocked.
      initial.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
      setRows([...initial]);
      // Default selection: every "ready" row.
      setSelected(new Set(initial.filter((r) => r.status === "ready").map((r) => r.name)));
      setStage("review");
    })();
    return () => {
      cancelled = true;
    };
  }, [state.region, mode, incoming.join("|"), refreshTick]);

  useInput((input, key) => {
    if (stage !== "review") return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - PAGE));
    if (key.pageDown) setCursor((c) => Math.min(rows.length - 1, c + PAGE));
    if (input === "g") setCursor(0);
    if (input === "G") setCursor(Math.max(0, rows.length - 1));
    const cur = rows[cursor];
    if (input === " " && cur && (cur.status === "ready" || cur.status === "downgrade")) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(cur.name)) next.delete(cur.name);
        else next.add(cur.name);
        return next;
      });
    }
    if (input === "A") {
      setSelected(new Set(rows.filter((r) => r.status === "ready").map((r) => r.name)));
    }
    if (input === "x") setSelected(new Set());
    if (input === "r") setRefreshTick((t) => t + 1);
    if (key.return && selected.size > 0) apply();
  });

  const apply = async () => {
    setStage("applying");
    setLogs([]);
    try {
      await captureConsole(
        { onLine: (l) => setLogs((p) => [...p, l].slice(-40)) },
        async () => {
          for (const row of rows) {
            if (!selected.has(row.name)) continue;
            await updateLayer({ function: row.name, region: state.region });
          }
        },
      );
      setStage("done");
    } catch (e) {
      setError((e as Error).message);
      setStage("error");
    }
  };

  const visible = useMemo(() => {
    if (rows.length <= PAGE) return rows;
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE),
    );
    return rows.slice(start, start + PAGE);
  }, [rows, cursor]);
  const visibleStart = rows.length <= PAGE
    ? 0
    : Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE));

  const counts = {
    ready: rows.filter((r) => r.status === "ready").length,
    noop: rows.filter((r) => r.status === "noop").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
    downgrade: rows.filter((r) => r.status === "downgrade").length,
  };

  if (stage === "applying" || stage === "done" || stage === "error") {
    return (
      <Box flexDirection="column">
        <Text bold>
          {stage === "applying" ? (
            <>
              <Spinner type="dots" /> Updating {selected.size} function(s)…
            </>
          ) : stage === "done" ? (
            <Text color="green">✔ Done</Text>
          ) : (
            <Text color="red">✘ {error}</Text>
          )}
        </Text>
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
        >
          {logs.length === 0 ? (
            <Text dimColor>(no output yet)</Text>
          ) : (
            logs.slice(-12).map((l, i) => <Text key={i}>{l}</Text>)
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>
        Update Dash0 layer{" "}
        <Text dimColor>
          (CLI knows v{KNOWN_LATEST_LAYER_VERSION.node} as current — env vars
          and other layers are left untouched.)
        </Text>
      </Text>
      <Text>
        {mode === "scan-all" ? (
          <Text dimColor>
            Scan mode: every function in {state.region} with a Dash0 layer.
          </Text>
        ) : (
          <Text dimColor>
            Targeted mode: {incoming.length} function(s) from your selection.
          </Text>
        )}
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color="green">{counts.ready} can update</Text>
          {" · "}
          <Text dimColor>{counts.noop} already current</Text>
          {counts.downgrade > 0 ? " · " : ""}
          {counts.downgrade > 0 && (
            <Text color="yellow">{counts.downgrade} downgrade(s)</Text>
          )}
          {counts.blocked > 0 ? " · " : ""}
          {counts.blocked > 0 && <Text color="red">{counts.blocked} blocked</Text>}
          {" · "}
          <Text bold color="cyan">
            {selected.size} selected → ⏎ to apply
          </Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {stage === "loading" && rows.length === 0 ? (
          <Text>
            <Spinner type="dots" /> scanning {state.region}…
          </Text>
        ) : rows.length === 0 ? (
          <Text dimColor>
            No functions with a Dash0 layer found in {state.region}. Use
            `install` first to attach the layer.
          </Text>
        ) : (
          <>
            <Box>
              <Text>{"  "}</Text>
              <Text bold>{padR("function", 36)}</Text>
              <Text bold>{padR("family", 8)}</Text>
              <Text bold>{padR("current", 9)}</Text>
              <Text bold>{padR("→ target", 10)}</Text>
              <Text bold>status</Text>
            </Box>
            {visible.map((r, i) => {
              const idx = visibleStart + i;
              return (
                <RowView
                  key={r.name}
                  row={r}
                  highlighted={idx === cursor}
                  selected={selected.has(r.name)}
                />
              );
            })}
            {rows.length > PAGE && (
              <Text dimColor>
                {" "}
                showing {visibleStart + 1}–{Math.min(visibleStart + PAGE, rows.length)} of {rows.length}
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

const RowView: React.FC<{
  row: PlanRow;
  highlighted: boolean;
  selected: boolean;
}> = ({ row, highlighted, selected }) => {
  const marker = selected ? "●" : highlighted ? "❯" : " ";
  const arrow =
    row.current !== undefined && row.target !== undefined
      ? `→ v${row.target}`
      : "—";
  const statusEl =
    row.status === "ready" ? (
      <Text color="green">ready</Text>
    ) : row.status === "noop" ? (
      <Text dimColor>already current</Text>
    ) : row.status === "downgrade" ? (
      <Text color="yellow">downgrade</Text>
    ) : row.status === "blocked" ? (
      <Text color="red">{row.blocker ?? "blocked"}</Text>
    ) : (
      <Text>
        <Spinner type="dots" />
      </Text>
    );
  return (
    <Box>
      <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
        {marker} {padR(row.name, 36)}
      </Text>
      <Text dimColor>{padR(row.family ?? "—", 8)}</Text>
      <Text>{padR(row.current !== undefined ? `v${row.current}` : "—", 9)}</Text>
      <Text>{padR(arrow, 10)}</Text>
      {statusEl}
    </Box>
  );
};

async function classify(
  lambda: LambdaWrapper,
  name: string,
): Promise<PlanRow> {
  try {
    const fn = await lambda.getFunction(name);
    const dash0 = fn.layers
      .map((l) => parseDash0LayerArn(l.Arn ?? ""))
      .find((x) => x !== null);
    if (!dash0) {
      return {
        name,
        status: "blocked",
        blocker: "no Dash0 layer attached — run install",
      };
    }
    const target = KNOWN_LATEST_LAYER_VERSION[dash0.family];
    const current = dash0.version ?? 0;
    return {
      name,
      family: dash0.family,
      current,
      target,
      status:
        current === target
          ? "noop"
          : target < current
            ? "downgrade"
            : "ready",
    };
  } catch (err) {
    return {
      name,
      status: "blocked",
      blocker: (err as Error).message,
    };
  }
}

function rank(s: RowStatus): number {
  switch (s) {
    case "ready":
      return 0;
    case "downgrade":
      return 1;
    case "noop":
      return 2;
    case "loading":
      return 3;
    case "blocked":
      return 4;
  }
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}
