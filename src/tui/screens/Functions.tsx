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
import { summarizeTargets, filterToZip } from "../lib/targets.js";
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
        if (next.has(cur.functionName)) {
          next.delete(cur.functionName);
          return { ...s, selected: next };
        }
        next.add(cur.functionName);
        // Image functions can be selected (so the user can mix into bulk
        // ops where some actions are valid, e.g. `o` open in console), but
        // we surface a one-line warning so it's never silent.
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
    if (input === "A") {
      // Select-all (visible filtered set), excluding image functions —
      // bulk select-all is overwhelmingly used for layer ops, and pulling
      // image functions into that set is almost always wrong.
      setState((s) => {
        const eligible = filtered.filter((f) => f.packageType !== "Image");
        const skipped = filtered.length - eligible.length;
        return {
          ...s,
          selected: new Set(eligible.map((f) => f.functionName)),
          status:
            skipped > 0
              ? {
                  text: `Selected ${eligible.length} zip functions; skipped ${skipped} image function(s).`,
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
        // Layer-mutating: filter image-package targets out.
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
        // If we filtered some out, narrow the active selection so the
        // downstream screen — and TargetsBanner — show the truth.
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
    if (cur && (input === "i" || key.return)) enterAction("install");
    if (cur && input === "v") enterAction("validate");
    if (cur && input === "u") enterAction("uninstall");
    if (cur && input === "o") enterAction("console");
    if (cur && input === "s") enterAction("switch-vendor");
    if (cur && input === "U") enterAction("update-layer");
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
                  region={state.region}
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

// Column widths. Sized for typical Lambda values:
//   runtime: longest realistic is "provided.al2023" (15); we cap at 13
//     and truncate — that fits "nodejs20.x", "python3.13", "java21", etc.
//   pkg: "image" (5) or "zip" (3) — width 7 with trailing gap.
//   dash0: "v999/python" worst case (11) — width 13 with trailing gap.
//   lumigo: "yes" / "—" — width 8 with trailing gap.
//   endpoint: "default" or host:port fragment — width 18.
//
// Each column has its own <Box> with flexShrink=0 so name can't squeeze
// them when terminal narrows; a built-in trailing space (or marginRight)
// gives visual separation. Name is flex-grow but capped — without a cap
// it engulfs the row even when the actual function name is short.
const COL = {
  gutterChevron: 2, // "❯" + 1 space
  gutterCheck: 2,   // "☐"/"☑" + 1 space
  name: 50,         // soft cap — flex-grow within this
  runtime: 13,
  pkg: 7,
  dash0: 13,
  lumigo: 8,
  endpoint: 46, // fits "https://ingress.<long-region>.aws.dash0.com:4318"
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

const Row: React.FC<{
  fn: import("../../lib/lambda.js").FunctionSnapshot;
  highlighted: boolean;
  selected: boolean;
  region: string;
}> = ({ fn, highlighted, selected, region }) => {
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
      <Box width={COL.name} flexShrink={1} marginRight={1}>
        <Text
          color={highlighted ? "cyan" : undefined}
          bold={highlighted}
          dimColor={isImage && !highlighted}
          wrap="truncate-end"
        >
          {fn.functionName}
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
