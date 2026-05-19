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
 *   ⏎ apply  ·  r refresh  ·  v pin a target version  ·  esc back
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
import { runBulk, type BulkResult } from "../lib/bulk.js";
import { BulkSummary } from "../components/BulkSummary.js";
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

type Stage = "loading" | "review" | "applying" | "done";
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
  const [bulkRows, setBulkRows] = useState<BulkResult[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [refreshTick, setRefreshTick] = useState(0);
  /** Optional pinned target version. When `undefined`, each row targets
   *  `KNOWN_LATEST_LAYER_VERSION[family]` (CLI default). When set, every
   *  row targets this number regardless of family — matches the `single
   *  v<n>, applied to every family` semantics chosen for install. */
  const [override, setOverride] = useState<number | undefined>();
  /** When true, the row table is replaced by an inline numeric editor. */
  const [editingOverride, setEditingOverride] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState("");
  const [overrideError, setOverrideError] = useState<string | undefined>();

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

  // Re-derive each row's target + status against the current override.
  // Baseline `rows` always carries the KNOWN_LATEST target — that way
  // unsetting the override returns to the original classification with
  // no rescan.
  const displayRows = useMemo<PlanRow[]>(() => {
    if (override === undefined) return rows;
    return rows.map((r) => {
      if (r.status === "loading" || r.status === "blocked") return r;
      const current = r.current ?? 0;
      const target = override;
      const status: RowStatus =
        current === target ? "noop" : target < current ? "downgrade" : "ready";
      return { ...r, target, status };
    });
  }, [rows, override]);

  useInput((input, key) => {
    if (stage !== "review") return;
    if (editingOverride) {
      // Numeric editor owns its own input until submit/esc.
      if (key.escape) {
        setEditingOverride(false);
        setOverrideError(undefined);
        return;
      }
      if (key.return) {
        const trimmed = overrideDraft.trim();
        if (trimmed === "") {
          setOverride(undefined);
          setEditingOverride(false);
          setOverrideError(undefined);
          return;
        }
        const n = parseInt(trimmed, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) {
          setOverrideError("must be a positive integer (or blank to clear)");
          return;
        }
        setOverride(n);
        setEditingOverride(false);
        setOverrideError(undefined);
        return;
      }
      if (key.backspace || key.delete) {
        setOverrideDraft((s) => s.slice(0, -1));
        setOverrideError(undefined);
        return;
      }
      // Accept digits only.
      if (input && /^[0-9]$/.test(input)) {
        setOverrideDraft((s) => s + input);
        setOverrideError(undefined);
      }
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(displayRows.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - PAGE));
    if (key.pageDown) setCursor((c) => Math.min(displayRows.length - 1, c + PAGE));
    if (input === "g") setCursor(0);
    if (input === "G") setCursor(Math.max(0, displayRows.length - 1));
    const cur = displayRows[cursor];
    if (input === " " && cur && (cur.status === "ready" || cur.status === "downgrade")) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(cur.name)) next.delete(cur.name);
        else next.add(cur.name);
        return next;
      });
    }
    if (input === "A") {
      setSelected(new Set(displayRows.filter((r) => r.status === "ready").map((r) => r.name)));
    }
    if (input === "x") setSelected(new Set());
    if (input === "r") setRefreshTick((t) => t + 1);
    if (input === "v" || input === "V") {
      setOverrideDraft(override !== undefined ? String(override) : "");
      setOverrideError(undefined);
      setEditingOverride(true);
    }
    if (key.return && selected.size > 0) apply();
  });

  const apply = async () => {
    setStage("applying");
    setBulkRows([]);
    setError(undefined);
    // Best-effort: per-target try/catch via runBulk. captureConsole hides
    // the underlying command's stdout — outcomes appear in the BulkSummary.
    const targets = displayRows
      .filter((r) => selected.has(r.name))
      .map((r) => r.name);
    try {
      await captureConsole({ onLine: () => undefined }, async () => {
        await runBulk(
          targets,
          (name) =>
            updateLayer({
              function: name,
              region: state.region,
              layerVersion: override,
            }).then(() => undefined),
          setBulkRows,
        );
      });
    } catch (e) {
      // captureConsole / setup failure (not per-target). Surface as a
      // post-step warning and still show whatever rows we collected.
      setError((e as Error).message);
    }
    setStage("done");
  };

  const visible = useMemo(() => {
    if (displayRows.length <= PAGE) return displayRows;
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(PAGE / 2), displayRows.length - PAGE),
    );
    return displayRows.slice(start, start + PAGE);
  }, [displayRows, cursor]);
  const visibleStart = displayRows.length <= PAGE
    ? 0
    : Math.max(
        0,
        Math.min(cursor - Math.floor(PAGE / 2), displayRows.length - PAGE),
      );

  const counts = {
    ready: displayRows.filter((r) => r.status === "ready").length,
    noop: displayRows.filter((r) => r.status === "noop").length,
    blocked: displayRows.filter((r) => r.status === "blocked").length,
    downgrade: displayRows.filter((r) => r.status === "downgrade").length,
  };

  if (stage === "applying" || stage === "done") {
    return (
      <Box flexDirection="column">
        <BulkSummary
          title={
            stage === "applying"
              ? `Updating layer (${selected.size} function${selected.size === 1 ? "" : "s"})…`
              : "Update complete"
          }
          rows={bulkRows}
          phase={stage === "applying" ? "running" : "done"}
        />
        {stage === "done" && error && (
          <Box marginTop={1}>
            <Text color="yellow">! post-step warning: {error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  const targetSummary =
    override !== undefined
      ? `targeting v${override} (pinned — applies to every family)`
      : `targeting CLI's known-latest per family (node:v${KNOWN_LATEST_LAYER_VERSION.node})`;

  return (
    <Box flexDirection="column">
      <Text bold>
        Update Dash0 layer{" "}
        <Text dimColor>
          ({targetSummary} — env vars and other layers are left untouched.)
        </Text>
      </Text>
      <Text>
        {mode === "scan-all" ? (
          <Text dimColor>
            Scan mode: every function in {state.region} with a Dash0 layer.
          </Text>
        ) : (
          <Text dimColor>
            Targeted mode: limited to your selection (see banner above).
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
          {"  "}
          <Text dimColor>(press v to {override !== undefined ? "change/clear" : "pin"} version)</Text>
        </Text>
      </Box>
      {editingOverride && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text bold>Pin layer version: </Text>v
            <Text color="cyan">{overrideDraft || "_"}</Text>
            {"  "}
            <Text dimColor>(digits · ⏎ submit · blank+⏎ clear · esc cancel)</Text>
          </Text>
          {overrideError && (
            <Text color="red">{overrideError}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {stage === "loading" && displayRows.length === 0 ? (
          <Text>
            <Spinner type="dots" /> scanning {state.region}…
          </Text>
        ) : displayRows.length === 0 ? (
          <Text dimColor>
            No functions with a Dash0 layer found in {state.region}. Use
            `install` first to attach the layer.
          </Text>
        ) : (
          <>
            <Box>
              <Text>{"   "}</Text>
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
            {displayRows.length > PAGE && (
              <Text dimColor>
                {" "}
                showing {visibleStart + 1}–{Math.min(visibleStart + PAGE, displayRows.length)} of {displayRows.length}
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
  // Cursor and selection live in separate gutter columns — same idiom as
  // Functions.tsx so muscle memory transfers between screens.
  const chevron = highlighted ? "❯" : " ";
  const check = selected ? "☑" : "☐";
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
        {chevron}
      </Text>
      <Text color={selected ? "magenta" : undefined} bold={selected}>
        {check}{" "}
      </Text>
      <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
        {padR(row.name, 36)}
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
