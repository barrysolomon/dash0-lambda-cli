/**
 * Home screen — sectioned action picker.
 *
 * Why hand-rolled instead of `ink-select-input`: we want section headers
 * (non-selectable rows) interleaved with selectable actions. Same cursor
 * pattern as Functions.tsx, so muscle memory transfers.
 *
 * Sections:
 *   • Browse              — open the inventory
 *   • Operate on selected — bulk verbs (collapses to a hint when no selection)
 *   • One-off tools       — verbs that take a single function (Migrate / Console / IaC)
 *   • Settings            — credentials, defaults
 *
 * The "Operate on selected" group is only meaningful when the user has
 * already picked targets, so when selection is empty we collapse the four
 * verbs into a single hint pointing at Functions. This removes the need
 * for dynamic per-action labels.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { ScreenProps, Screen, AppState } from "../types.js";
import { resolveTargets } from "../lib/targets.js";

type Row =
  | { kind: "header"; label: string }
  | { kind: "hint"; label: string; goto?: Screen }
  | {
      kind: "action";
      label: string;
      value: Screen;
      description: string;
      disabled?: boolean;
    };

function buildRows(state: AppState): Row[] {
  const { names } = resolveTargets(state);
  const n = names.length;
  const noIdentity = !state.identity;

  const rows: Row[] = [];

  // If the auth probe failed and the user has dismissed the AuthError
  // screen (suppressAuthAutoRoute=true), the only way back is via this
  // entry — Home doesn't trigger AWS calls, so the auto-route never
  // re-fires here. The dispatcher detects screen="auth-error" and clears
  // the suppress flag.
  if (noIdentity) {
    rows.push({ kind: "header", label: "AWS authentication" });
    rows.push({
      kind: "action",
      label: "Sign in to AWS",
      value: "auth-error",
      description:
        "Pick a profile and run aws sso login (or paste temporary credentials).",
    });
  }

  // Browse
  rows.push({ kind: "header", label: "Browse" });
  rows.push({
    kind: "action",
    label:
      n > 0
        ? `List functions  (${n} selected — ␣ to edit)`
        : "List functions and their footprint",
    value: "functions",
    description:
      n > 0
        ? `Live list with Dash0/Lumigo status. ${n} currently in your cart.`
        : "Live list with Dash0/Lumigo status. Multi-select with ␣ for bulk ops.",
  });

  // Operate on selected — collapsed when empty.
  rows.push({
    kind: "header",
    label: n > 0 ? `Operate on ${n} selected` : "Operate on selected lambda(s)",
  });
  if (n === 0) {
    rows.push({
      kind: "hint",
      label: "Pick targets first  →  List functions  (␣ to select)",
      goto: "functions",
    });
  } else {
    rows.push({
      kind: "action",
      label: "Install Dash0",
      value: "install",
      description:
        "Attach the layer + set required env vars (with plan + confirm).",
    });
    rows.push({
      kind: "action",
      label: "Update Dash0 layer",
      value: "update-layer",
      description:
        "Bump the layer ARN. Doesn't touch env vars / token.",
    });
    rows.push({
      kind: "action",
      label: "Validate / doctor",
      value: "validate",
      description: "Health-check + (single-target) live CloudWatch log tailer.",
    });
    rows.push({
      kind: "action",
      label: "Uninstall Dash0",
      value: "uninstall",
      description: "Remove the layer + DASH0_* env vars.",
    });
  }

  // One-off tools
  rows.push({ kind: "header", label: "One-off tools" });
  rows.push({
    kind: "action",
    label: "Migrate from Lumigo to Dash0",
    value: "migrate",
    description:
      "Swap Lumigo for Dash0 (single function or filter regex). Doesn't use selection.",
  });
  rows.push({
    kind: "action",
    label: "Open a function in the AWS console",
    value: "console",
    description: "Pick a function and jump to Lambda / CloudWatch Logs.",
  });
  rows.push({
    kind: "action",
    label: "Generate IaC snippet",
    value: "generate",
    description:
      "Terraform / SAM / CDK / Serverless — paste into your templates.",
  });

  // Settings
  rows.push({ kind: "header", label: "Settings" });
  rows.push({
    kind: "action",
    label: "Manage saved credentials & defaults",
    value: "config",
    description:
      "View / edit ./.dash0-lambda.json, rotate Secrets Manager token.",
  });

  return rows;
}

export const Home: React.FC<ScreenProps> = ({ state, setState }) => {
  const rows = React.useMemo(
    () => buildRows(state),
    [state.selected, state.focused],
  );

  // Index of the first selectable row — the cursor lands here on mount.
  const firstSelectable = rows.findIndex(
    (r) => r.kind === "action" || r.kind === "hint",
  );
  const [cursor, setCursor] = React.useState(firstSelectable);

  // Re-clamp + re-snap if the row list shape changes (e.g. selection
  // emptied, "Operate on selected" collapsed). Don't drift onto a header.
  React.useEffect(() => {
    if (cursor >= rows.length || !isSelectable(rows[cursor])) {
      const next = rows.findIndex(
        (r, i) => i >= cursor && (r.kind === "action" || r.kind === "hint"),
      );
      setCursor(next >= 0 ? next : firstSelectable);
    }
  }, [rows.length, cursor]);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => stepCursor(rows, c, -1));
    if (key.downArrow) setCursor((c) => stepCursor(rows, c, +1));
    if (key.return) {
      const r = rows[cursor];
      if (!r) return;
      if (r.kind === "action" && !r.disabled) {
        setState((s) => ({
          ...s,
          back: [...s.back, "home"],
          screen: r.value,
          // Going to auth-error explicitly = user wants to sign in. Clear
          // the suppress flag so the auto-route can resume guarding the
          // rest of the app once they're back to verified state.
          suppressAuthAutoRoute:
            r.value === "auth-error" ? false : s.suppressAuthAutoRoute,
        }));
      } else if (r.kind === "hint" && r.goto) {
        setState((s) => ({
          ...s,
          back: [...s.back, "home"],
          screen: r.goto!,
        }));
      }
    }
  });

  const focusedRow = rows[cursor];
  const description =
    focusedRow?.kind === "action" ? focusedRow.description : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>What would you like to do?</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) => (
          <RowView key={i} row={r} highlighted={i === cursor} />
        ))}
      </Box>
      {description && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{description}</Text>
        </Box>
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
  if (row.kind === "hint") {
    return (
      <Box paddingLeft={2}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {highlighted ? "❯ " : "  "}
        </Text>
        <Text dimColor>{row.label}</Text>
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

function isSelectable(r: Row | undefined): boolean {
  return !!r && (r.kind === "action" || r.kind === "hint");
}

/**
 * Move the cursor by `direction`, skipping non-selectable rows. Wraps at
 * either end (a small QoL choice that matches `ink-select-input`'s default
 * behavior, so users coming from the previous Home don't notice a regression).
 */
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

