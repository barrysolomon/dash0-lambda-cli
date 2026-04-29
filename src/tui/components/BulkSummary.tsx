/**
 * Renders a live + final view of a BulkResult[] — counts header, per-row
 * status lines, scrollable when long. Same visual idiom as Validate's
 * ValidateMany so it transfers across screens.
 *
 * `phase`:
 *   "running" — still iterating; show spinner on the active row.
 *   "done"    — all done; show finalSummary line ("✔ N · ✘ M failed").
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { countOutcomes, type BulkResult } from "../lib/bulk.js";

const PAGE = 12;

export const BulkSummary: React.FC<{
  title: string;
  rows: BulkResult[];
  phase: "running" | "done";
}> = ({ title, rows, phase }) => {
  const counts = countOutcomes(rows);
  const [cursor, setCursor] = useState(0);

  // Auto-scroll cursor to follow the running row so users see live progress.
  useEffect(() => {
    if (phase !== "running") return;
    const runningIdx = rows.findIndex((r) => r.outcome === "running");
    if (runningIdx >= 0) setCursor(runningIdx);
  }, [rows, phase]);

  useInput((_, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - PAGE));
    if (key.pageDown) setCursor((c) => Math.min(rows.length - 1, c + PAGE));
  });

  const visible = paginate(rows, cursor, PAGE);
  const visibleStart = paginateStart(rows.length, cursor, PAGE);

  const focused = rows[cursor];

  return (
    <Box flexDirection="column">
      <Text bold>
        {phase === "running" ? (
          <>
            <Spinner type="dots" /> {title} ({counts.done}/{rows.length})
          </>
        ) : (
          <>{title} ({counts.done}/{rows.length})</>
        )}
      </Text>
      <Text>
        <Text color="green">✔ {counts.ok}</Text>
        {counts.failed > 0 ? (
          <>
            {" · "}
            <Text color="red">✘ {counts.failed} failed</Text>
          </>
        ) : null}
        {counts.running > 0 ? (
          <>
            {" · "}
            <Text color="cyan">… {counts.running} running</Text>
          </>
        ) : null}
        {counts.pending > 0 ? (
          <>
            {" · "}
            <Text dimColor>{counts.pending} pending</Text>
          </>
        ) : null}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>{"  "}</Text>
          <Text bold>{padR("function", 38)}</Text>
          <Text bold>status</Text>
        </Box>
        {visible.map((r, i) => {
          const idxInList = visibleStart + i;
          return (
            <RowView
              key={r.name}
              row={r}
              highlighted={idxInList === cursor}
            />
          );
        })}
        {rows.length > PAGE && (
          <Text dimColor>
            {" "}
            showing {visibleStart + 1}–
            {Math.min(visibleStart + PAGE, rows.length)} of {rows.length}
          </Text>
        )}
      </Box>

      {focused && focused.outcome === "failed" && focused.error && (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor="red"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="red">
            ✘ {focused.name}
          </Text>
          <Text>{focused.error}</Text>
        </Box>
      )}

      {phase === "done" && (
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ to inspect failures · <Text bold>esc</Text> to return
          </Text>
        </Box>
      )}
    </Box>
  );
};

const RowView: React.FC<{ row: BulkResult; highlighted: boolean }> = ({
  row,
  highlighted,
}) => {
  const icon =
    row.outcome === "ok" ? (
      <Text color="green">✔</Text>
    ) : row.outcome === "failed" ? (
      <Text color="red">✘</Text>
    ) : row.outcome === "running" ? (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    ) : (
      <Text dimColor>·</Text>
    );
  const statusText =
    row.outcome === "ok"
      ? "ok"
      : row.outcome === "failed"
        ? "failed"
        : row.outcome === "running"
          ? "running"
          : "queued";
  return (
    <Box>
      <Text>{icon} </Text>
      <Text
        color={highlighted ? "cyan" : undefined}
        bold={highlighted}
        dimColor={!highlighted && row.outcome === "pending"}
      >
        {padR(row.name, 38)}
      </Text>
      <Text
        color={
          row.outcome === "failed"
            ? "red"
            : row.outcome === "ok"
              ? "green"
              : undefined
        }
        dimColor={row.outcome === "pending" || row.outcome === "running"}
      >
        {statusText}
      </Text>
    </Box>
  );
};

function paginate<T>(rows: T[], cursor: number, page: number): T[] {
  if (rows.length <= page) return rows;
  const start = paginateStart(rows.length, cursor, page);
  return rows.slice(start, start + page);
}

function paginateStart(total: number, cursor: number, page: number): number {
  if (total <= page) return 0;
  return Math.max(
    0,
    Math.min(cursor - Math.floor(page / 2), total - page),
  );
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}
