/**
 * Functions screen — live list of every Lambda in the region.
 *
 * Hotkeys:
 *   ↑ / ↓     navigate (across both app and function rows)
 *   /         enter filter mode (type to filter, Enter to apply, Esc to cancel)
 *   space     toggle selection — on an app row, toggles every member as a group
 *   Enter     on app row: collapse/expand the group
 *             on function row: with selection — back to Home for the
 *             "Operate on N selected" menu; without selection — warn.
 *   i         install on the highlighted function (or selected set)
 *   v         validate the highlighted function (or first selected)
 *   u         uninstall the highlighted function (or selected set)
 *   o         open the highlighted function in the AWS console
 *   r         refresh the list
 *   esc       back to home
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  parseDash0LayerArn,
} from "../../lib/layers.js";
import { detectLumigo } from "../../lib/lumigo.js";
import { useFunctionList } from "../hooks/useFunctionList.js";
import { isAwsAuthError } from "../../menu/auth.js";
import { useEffect as useEffect_authroute } from "react";
import { summarizeTargets, filterToZip } from "../lib/targets.js";
import { buildVisualRows, type VisualRow } from "../lib/groups.js";
import type { ScreenProps } from "../types.js";

const PAGE_SIZE = 14;

export const Functions: React.FC<ScreenProps> = ({ state, setState }) => {
  const { functions, loading, error, rawError, refresh, lastRefreshAt } =
    useFunctionList(state.region);

  // Auto-route to the auth-error screen on credential failures.
  useEffect_authroute(() => {
    if (rawError && isAwsAuthError(rawError)) {
      setState((s) =>
        s.screen === "auth-error"
          ? s
          : { ...s, back: [...s.back, s.screen], screen: "auth-error" },
      );
    }
  }, [rawError]);
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const { rows, visibleFunctionNames } = useMemo(
    () => buildVisualRows(functions, filter.trim().toLowerCase(), collapsed),
    [functions, filter, collapsed],
  );

  // Clamp cursor when list shrinks.
  React.useEffect(() => {
    if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length, cursor]);

  useInput((input, key) => {
    if (filterMode) return; // text input owns the keyboard while filtering
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - PAGE_SIZE));
    if (key.pageDown)
      setCursor((c) => Math.min(rows.length - 1, c + PAGE_SIZE));
    if (input === "g") setCursor(0);
    if (input === "G") setCursor(Math.max(0, rows.length - 1));

    if (input === "/") setFilterMode(true);
    if (input === "r") refresh();

    const row = rows[cursor];

    // Space on an app row toggles all members as a group: if any member
    // is currently selected, deselect the whole group; otherwise select
    // every (eligible) member. On a function row, behaves as before.
    if (input === " " && row) {
      if (row.kind === "app") {
        setState((s) => {
          const next = new Set(s.selected);
          const anySelected = row.members.some((n) => next.has(n));
          if (anySelected) {
            for (const n of row.members) next.delete(n);
            return { ...s, selected: next };
          }
          // Skip image-package members for the bulk add path — same
          // rationale as `A` below. We still allow individual `space`
          // selection of image functions, which is the existing
          // behavior preserved on the function-row branch.
          let skipped = 0;
          for (const name of row.members) {
            const fn = functions.find((f) => f.functionName === name);
            if (fn && fn.packageType === "Image") {
              skipped++;
              continue;
            }
            next.add(name);
          }
          const status =
            skipped > 0
              ? {
                  text: `Selected ${row.members.length - skipped} of ${row.members.length} in ${row.app}; skipped ${skipped} image function(s).`,
                  tone: "info" as const,
                }
              : s.status;
          return { ...s, selected: next, status };
        });
      } else {
        const cur = row.fn;
        setState((s) => {
          const next = new Set(s.selected);
          if (next.has(cur.functionName)) {
            next.delete(cur.functionName);
            return { ...s, selected: next };
          }
          next.add(cur.functionName);
          const status =
            cur.packageType === "Image"
              ? {
                  text: `${cur.functionName} is a container-image function — layer-mutating actions (i/U/u) will skip it.`,
                  tone: "warn" as const,
                }
              : s.status;
          return { ...s, selected: next, status };
        });
      }
    }

    // Enter / left / right on an app row collapses or expands the group.
    if (
      row?.kind === "app" &&
      (key.return || key.leftArrow || key.rightArrow)
    ) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (key.leftArrow) next.add(row.app);
        else if (key.rightArrow) next.delete(row.app);
        else if (next.has(row.app)) next.delete(row.app);
        else next.add(row.app);
        return next;
      });
      return;
    }

    if (input === "A") {
      // Select-all (visible filtered set), excluding image functions.
      setState((s) => {
        const eligibleNames = visibleFunctionNames.filter((n) => {
          const fn = functions.find((f) => f.functionName === n);
          return fn && fn.packageType !== "Image";
        });
        const skipped = visibleFunctionNames.length - eligibleNames.length;
        return {
          ...s,
          selected: new Set(eligibleNames),
          status:
            skipped > 0
              ? {
                  text: `Selected ${eligibleNames.length} zip functions; skipped ${skipped} image function(s).`,
                  tone: "info" as const,
                }
              : s.status,
        };
      });
    }
    if (input === "x") {
      setState((s) => ({ ...s, selected: new Set() }));
    }
    // Action shortcuts. If a multi-selection is active, we don't overwrite
    // `focused` — resolveTargets() will use the selection set, and writing
    // `focused = cur` would just be misleading state. When there's no
    // selection, the cursor row becomes the focus.
    //
    // For layer-mutating actions, we also pre-filter image-package
    // functions out of the selection set (they can't host layers). If the
    // resulting set is empty, we refuse to navigate and post a status.
    const cur = row?.kind === "fn" ? row.fn : undefined;
    const layerMutating = new Set<import("../types.js").Screen>([
      "install",
      "uninstall",
      "update-layer",
      "switch-vendor",
    ]);
    const enterAction = (screen: import("../types.js").Screen) => {
      setState((s) => {
        const usingSelection = s.selected.size > 0;
        const focused = usingSelection ? s.focused : cur;
        if (!layerMutating.has(screen)) {
          return { ...s, focused, back: [...s.back, s.screen], screen };
        }
        const candidateNames = usingSelection
          ? [...s.selected]
          : focused
            ? [focused.functionName]
            : [];
        const { kept, skipped } = filterToZip(candidateNames, functions);
        if (kept.length === 0) {
          return {
            ...s,
            status: {
              text: `${screen} can't run on container-image functions. Pick a zip-deployed Lambda.`,
              tone: "error",
            },
          };
        }
        const next: typeof s = {
          ...s,
          focused,
          back: [...s.back, s.screen],
          screen,
        };
        if (usingSelection && skipped.length > 0) {
          next.selected = new Set(kept);
          next.status = {
            text: `Skipping ${skipped.length} image function(s); proceeding with ${kept.length} zip function(s).`,
            tone: "warn",
          };
        }
        return next;
      });
    };
    if (cur && input === "i") enterAction("install");
    if (cur && input === "v") enterAction("validate");
    if (cur && input === "u") enterAction("uninstall");
    if (cur && input === "o") enterAction("console");
    if (cur && input === "s") enterAction("switch-vendor");
    if (cur && input === "U") enterAction("update-layer");

    // Enter on a function row: route back to Home where the selection-
    // aware "Operate on N selected" menu lives. With no selection, we
    // refuse and warn — the user just navigated to a row but didn't
    // claim it, so installing on the highlighted row would be a
    // surprise. Letter shortcuts (i/v/u/U) still work on the highlighted
    // row directly for power users.
    if (cur && key.return) {
      if (state.selected.size === 0) {
        setState((s) => ({
          ...s,
          status: {
            text: "Nothing selected. Press ␣ to add this row, then Enter.",
            tone: "warn",
          },
        }));
      } else {
        setState((s) => ({
          ...s,
          back: [...s.back, s.screen],
          screen: "home",
        }));
      }
    }
  });

  const visibleStart =
    rows.length <= PAGE_SIZE
      ? 0
      : Math.max(
          0,
          Math.min(cursor - Math.floor(PAGE_SIZE / 2), rows.length - PAGE_SIZE),
        );
  const visible = useMemo(
    () =>
      rows.length <= PAGE_SIZE
        ? rows
        : rows.slice(visibleStart, visibleStart + PAGE_SIZE),
    [rows, visibleStart],
  );

  // For the header count we want "function rows" not "visual rows" — app
  // rows are chrome.
  const fnRowCount = visibleFunctionNames.length;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>
          Functions in {state.region}{" "}
          <Text dimColor>
            ({fnRowCount}
            {filter ? `/${functions.length} after filter` : ""}
            {state.selected.size > 0 ? ` · ${state.selected.size} selected` : ""}
            )
          </Text>
          {state.selected.size > 0 ? (
            <Text color="magenta">
              {"  →  "}
              <Text bold>i</Text>/<Text bold>v</Text>/<Text bold>u</Text>/<Text bold>U</Text> acts on {state.selected.size} selected
            </Text>
          ) : (
            <Text dimColor>
              {"  ·  "}
              <Text bold>␣</Text> select  <Text bold>A</Text> all  <Text bold>x</Text> clear
            </Text>
          )}
        </Text>
        <Text dimColor>
          {lastRefreshAt
            ? `last refresh ${ago(lastRefreshAt)}`
            : loading
              ? "loading…"
              : ""}
        </Text>
      </Box>

      {state.selected.size > 0 && (
        <Box>
          <Text color="magenta" bold>
            ☑ {state.selected.size}
          </Text>
          <Text dimColor>
            {" "}selected:{" "}
          </Text>
          <Text>{summarizeTargets([...state.selected].sort(), 6)}</Text>
        </Box>
      )}

      {filterMode ? (
        <Box marginTop={1}>
          <Text>filter: </Text>
          <TextInput
            value={filter}
            onChange={setFilter}
            onSubmit={() => setFilterMode(false)}
            placeholder="type to filter, Enter to apply, esc clears"
          />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {loading && functions.length === 0 ? (
          <Text>
            <Spinner type="dots" /> loading…
          </Text>
        ) : error ? (
          <Text color="red">✘ {error}</Text>
        ) : rows.length === 0 ? (
          <Text dimColor>(no matching functions)</Text>
        ) : (
          <>
            <Header />
            {visible.map((row, i) => {
              const idxInList = visibleStart + i;
              const highlighted = idxInList === cursor;
              if (row.kind === "app") {
                const memberSel = row.members.filter((n) =>
                  state.selected.has(n),
                ).length;
                return (
                  <AppHeaderRow
                    key={`app:${row.app}`}
                    app={row.app}
                    total={row.totalMembers}
                    selectedCount={memberSel}
                    collapsed={row.collapsed}
                    highlighted={highlighted}
                  />
                );
              }
              return (
                <Row
                  key={row.fn.functionName}
                  fn={row.fn}
                  displayName={row.displayName}
                  indent={row.app !== undefined}
                  highlighted={highlighted}
                  selected={state.selected.has(row.fn.functionName)}
                  region={state.region}
                />
              );
            })}
            {rows.length > PAGE_SIZE && (
              <Text dimColor>
                {" "}
                showing {visibleStart + 1}–{Math.min(visibleStart + PAGE_SIZE, rows.length)} of {rows.length}
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

// Column widths. Each column has its own <Box> with flexShrink=0 so the
// name can't squeeze them when the terminal narrows; a built-in trailing
// space (or marginRight) gives visual separation. Name is flex-grow but
// capped — without a cap it engulfs the row even when the actual
// function name is short.
//
// Endpoint is intentionally narrow (was 46): the host suffix carries no
// real signal — what matters is whether the value is the default for
// this region. We rely on `wrap="truncate-end"` plus the dim/yellow
// coloring to convey state; the user can still see the full value by
// drilling into a function.
const COL = {
  gutterChevron: 2, // "❯" + 1 space
  gutterCheck: 2,   // "☐"/"☑" + 1 space
  groupIndent: 6,   // shown only on member rows under an app
  name: 100,        // soft cap — flex-grow within this
  runtime: 13,
  pkg: 7,
  dash0: 13,
  lumigo: 8,
  endpoint: 22,
} as const;

const Header: React.FC = () => (
  <Box>
    <Box width={COL.gutterChevron} flexShrink={0} />
    <Box width={COL.gutterCheck} flexShrink={0} />
    <Box width={COL.name} flexShrink={1} marginRight={1}>
      <Text bold>name</Text>
    </Box>
    <Box width={COL.runtime} flexShrink={0}>
      <Text bold>runtime</Text>
    </Box>
    <Box width={COL.pkg} flexShrink={0}>
      <Text bold>pkg</Text>
    </Box>
    <Box width={COL.dash0} flexShrink={0}>
      <Text bold>dash0</Text>
    </Box>
    <Box width={COL.lumigo} flexShrink={0}>
      <Text bold>lumigo</Text>
    </Box>
    <Box width={COL.endpoint} flexShrink={0}>
      <Text bold>endpoint</Text>
    </Box>
  </Box>
);

const AppHeaderRow: React.FC<{
  app: string;
  total: number;
  selectedCount: number;
  collapsed: boolean;
  highlighted: boolean;
}> = ({ app, total, selectedCount, collapsed, highlighted }) => {
  const chevron = highlighted ? "❯" : " ";
  const triangle = collapsed ? "▸" : "▾";
  const allSelected = selectedCount > 0 && selectedCount === total;
  const someSelected = selectedCount > 0 && !allSelected;
  const check = allSelected ? "☑" : someSelected ? "▣" : "☐";
  return (
    <Box>
      <Box width={COL.gutterChevron} flexShrink={0}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {chevron}
        </Text>
      </Box>
      <Box width={COL.gutterCheck} flexShrink={0}>
        <Text
          color={
            allSelected ? "magenta" : someSelected ? "magenta" : undefined
          }
          bold={allSelected || someSelected}
        >
          {check}
        </Text>
      </Box>
      <Box flexShrink={1} marginRight={1}>
        <Text
          color={highlighted ? "cyan" : "blueBright"}
          bold
          wrap="truncate-end"
        >
          {triangle} {app}{" "}
          <Text dimColor>
            ({total} function{total === 1 ? "" : "s"}
            {selectedCount > 0 ? ` · ${selectedCount} selected` : ""})
          </Text>
        </Text>
      </Box>
    </Box>
  );
};

const Row: React.FC<{
  fn: import("../../lib/lambda.js").FunctionSnapshot;
  displayName: string;
  indent: boolean;
  highlighted: boolean;
  selected: boolean;
  region: string;
}> = ({ fn, displayName, indent, highlighted, selected, region }) => {
  const dash0 = fn.layers
    .map((l) => parseDash0LayerArn(l.Arn ?? ""))
    .find((x) => x !== null);
  const lumigo = detectLumigo(fn);
  const lumigoFlag =
    lumigo.layers.length > 0 || Object.keys(lumigo.env).length > 0;
  const epRaw = fn.env.DASH0_ENDPOINT ?? "";
  const epDisplay = epRaw || "—";
  const epIsDefault = epRaw !== "" && isDefaultEndpoint(epRaw, region);
  const isImage = fn.packageType === "Image";
  // Two-column gutter: chevron (cursor) + checkbox (selection). Decoupling
  // these means a row can be highlighted AND selected without one marker
  // shadowing the other.
  const chevron = highlighted ? "❯" : " ";
  const check = selected ? "☑" : "☐";
  return (
    <Box>
      <Box width={COL.gutterChevron} flexShrink={0}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {chevron}
        </Text>
      </Box>
      <Box width={COL.gutterCheck} flexShrink={0}>
        <Text color={selected ? "magenta" : undefined} bold={selected}>
          {check}
        </Text>
      </Box>
      {indent && (
        <Box width={COL.groupIndent} flexShrink={0}>
          <Text dimColor>│</Text>
        </Box>
      )}
      <Box
        width={COL.name - (indent ? COL.groupIndent : 0)}
        flexShrink={1}
        marginRight={1}
      >
        <Text
          color={highlighted ? "cyan" : undefined}
          bold={highlighted}
          dimColor={isImage && !highlighted}
          wrap="truncate-end"
        >
          {displayName}
        </Text>
      </Box>
      <Box width={COL.runtime} flexShrink={0}>
        <Text dimColor={!highlighted} wrap="truncate-end">
          {fn.runtime}
        </Text>
      </Box>
      <Box width={COL.pkg} flexShrink={0}>
        <Text
          color={isImage ? "yellow" : undefined}
          dimColor={!isImage && !highlighted}
        >
          {isImage ? "image" : "zip"}
        </Text>
      </Box>
      <Box width={COL.dash0} flexShrink={0}>
        <Text
          color={dash0 ? "green" : undefined}
          dimColor={!highlighted && !dash0}
        >
          {dash0 ? `v${dash0.version}/${dash0.family}` : "—"}
        </Text>
      </Box>
      <Box width={COL.lumigo} flexShrink={0}>
        <Text
          color={lumigoFlag ? "yellow" : undefined}
          dimColor={!highlighted && !lumigoFlag}
        >
          {lumigoFlag ? "yes" : "—"}
        </Text>
      </Box>
      <Box width={COL.endpoint} flexShrink={0}>
        <Text
          dimColor={!highlighted || epIsDefault || epRaw === ""}
          color={epRaw === "" || epIsDefault ? undefined : "yellow"}
          wrap="truncate-end"
        >
          {epDisplay}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * True when DASH0_ENDPOINT matches the canonical Dash0 ingress for this
 * region. Used as a visual signal — default endpoints render dim, custom
 * endpoints render yellow so config drift pops while scanning.
 *
 * The CLI's Install wizard defaults to `ingress.eu-west-1.aws.dash0.com`
 * for eu-* regions and `ingress.us-west-2.aws.dash0.com` for everything
 * else, but accepts an in-region match too (e.g. `ingress.us-east-1...`)
 * since some users host pin per-region.
 */
function isDefaultEndpoint(value: string, region: string): boolean {
  const expected = `https://ingress.${region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`;
  const inRegion = `https://ingress.${region}.aws.dash0.com:4318`;
  return value === expected || value === inRegion;
}

function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
