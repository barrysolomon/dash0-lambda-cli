/**
 * Functions screen — live list of every Lambda in the region.
 *
 * Hotkeys:
 *   ↑ / ↓     navigate
 *   /         enter filter mode (type to filter, Enter to apply, Esc to cancel)
 *   space     toggle selection on current row
 *   Enter     dive into the highlighted function (defaults to install)
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

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return functions;
    return functions.filter((fn) =>
      fn.functionName.toLowerCase().includes(f),
    );
  }, [functions, filter]);

  // Clamp cursor when list shrinks.
  React.useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput((input, key) => {
    if (filterMode) return; // text input owns the keyboard while filtering
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(filtered.length - 1, c + 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - PAGE_SIZE));
    if (key.pageDown)
      setCursor((c) => Math.min(filtered.length - 1, c + PAGE_SIZE));
    if (input === "g") setCursor(0);
    if (input === "G") setCursor(Math.max(0, filtered.length - 1));

    if (input === "/") setFilterMode(true);
    if (input === "r") refresh();

    const cur = filtered[cursor];
    if (input === " " && cur) {
      setState((s) => {
        const next = new Set(s.selected);
        if (next.has(cur.functionName)) next.delete(cur.functionName);
        else next.add(cur.functionName);
        return { ...s, selected: next };
      });
    }
    if (input === "a") {
      // Note: 'a' is also the global profile-switch key. Owning it here
      // would shadow it; let App's global handler win.
    }
    if (input === "A") {
      // Select-all (visible filtered set).
      setState((s) => ({
        ...s,
        selected: new Set(filtered.map((f) => f.functionName)),
      }));
    }
    if (input === "x") {
      setState((s) => ({ ...s, selected: new Set() }));
    }
    if (cur && (input === "i" || key.return)) {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "install",
      }));
    }
    if (cur && input === "v") {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "validate",
      }));
    }
    if (cur && input === "u") {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "uninstall",
      }));
    }
    if (cur && input === "o") {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "console",
      }));
    }
    if (cur && input === "s") {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "switch-vendor",
      }));
    }
    if (cur && input === "U") {
      setState((s) => ({
        ...s,
        focused: cur,
        back: [...s.back, "functions"],
        screen: "update-layer",
      }));
    }
  });

  const visible = useMemo(() => {
    if (filtered.length <= PAGE_SIZE) return filtered;
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(PAGE_SIZE / 2), filtered.length - PAGE_SIZE),
    );
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, cursor]);
  const visibleStart = filtered.length <= PAGE_SIZE
    ? 0
    : Math.max(0, Math.min(cursor - Math.floor(PAGE_SIZE / 2), filtered.length - PAGE_SIZE));

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>
          Functions in {state.region}{" "}
          <Text dimColor>
            ({filtered.length}
            {filter ? `/${functions.length} after filter` : ""}
            {state.selected.size > 0 ? ` · ${state.selected.size} selected` : ""}
            )
          </Text>
          {state.selected.size > 0 ? (
            <Text color="cyan">
              {"  →  "}
              <Text bold>i</Text>/<Text bold>v</Text>/<Text bold>u</Text> acts on the {state.selected.size} selected
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
        ) : filtered.length === 0 ? (
          <Text dimColor>(no matching functions)</Text>
        ) : (
          <>
            <Header />
            {visible.map((fn, i) => {
              const idxInList = visibleStart + i;
              return (
                <Row
                  key={fn.functionName}
                  fn={fn}
                  highlighted={idxInList === cursor}
                  selected={state.selected.has(fn.functionName)}
                />
              );
            })}
            {filtered.length > PAGE_SIZE && (
              <Text dimColor>
                {" "}
                showing {visibleStart + 1}–{Math.min(visibleStart + PAGE_SIZE, filtered.length)} of {filtered.length}
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

const Header: React.FC = () => (
  <Box>
    <Text>{"  "}</Text>
    <Text bold>{pad("name", 38)}</Text>
    <Text bold>{pad("runtime", 14)}</Text>
    <Text bold>{pad("dash0", 12)}</Text>
    <Text bold>{pad("lumigo", 8)}</Text>
    <Text bold>endpoint</Text>
  </Box>
);

const Row: React.FC<{
  fn: import("../../lib/lambda.js").FunctionSnapshot;
  highlighted: boolean;
  selected: boolean;
}> = ({ fn, highlighted, selected }) => {
  const dash0 = fn.layers
    .map((l) => parseDash0LayerArn(l.Arn ?? ""))
    .find((x) => x !== null);
  const lumigo = detectLumigo(fn);
  const lumigoFlag =
    lumigo.layers.length > 0 || Object.keys(lumigo.env).length > 0;
  const ep = fn.env.DASH0_ENDPOINT ?? "—";
  const marker = selected ? "●" : highlighted ? "❯" : " ";
  return (
    <Box>
      <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
        {marker} {pad(fn.functionName, 38)}
      </Text>
      <Text dimColor={!highlighted}>{pad(fn.runtime, 14)}</Text>
      <Text color={dash0 ? "green" : undefined} dimColor={!highlighted && !dash0}>
        {pad(dash0 ? `v${dash0.version}/${dash0.family}` : "—", 12)}
      </Text>
      <Text color={lumigoFlag ? "yellow" : undefined} dimColor={!highlighted && !lumigoFlag}>
        {pad(lumigoFlag ? "yes" : "—", 8)}
      </Text>
      <Text dimColor={!highlighted}>{shorten(ep, 30)}</Text>
    </Box>
  );
};

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + "…";
  return s + " ".repeat(w - s.length);
}
function shorten(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}
function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
