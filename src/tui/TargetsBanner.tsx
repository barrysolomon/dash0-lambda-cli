/**
 * Persistent "what am I about to operate on?" indicator.
 *
 * Renders only when the user has either a multi-select set or a single
 * focused function pending. Sits between the AWS-context Banner (account/
 * profile/region) and the active screen, so selection state is never
 * invisible after the user leaves the Functions screen.
 *
 * Magenta is deliberately distinct from the cyan Banner border (env) and
 * the gray Footer border (hotkeys) — three colors, three concerns.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AppState, Screen } from "./types.js";
import { resolveTargets, summarizeTargets } from "./lib/targets.js";

/**
 * Screens that suppress the banner. Mostly screens where the user is
 * already editing the selection (Functions) or in a modal overlay
 * (region/profile/help/auth-error) where the banner would be noise.
 *
 * Kept exported so App.tsx can use the same list for height accounting —
 * TargetsBanner returning null is invisible to layout math.
 */
export const TARGETS_BANNER_HIDDEN_SCREENS: Screen[] = [
  "functions",
  "switch-region",
  "switch-profile",
  "help",
  "auth-error",
];

export const TargetsBanner: React.FC<{ state: AppState }> = ({ state }) => {
  if (TARGETS_BANNER_HIDDEN_SCREENS.includes(state.screen)) return null;
  const { names, bulk } = resolveTargets(state);
  if (names.length === 0) return null;
  const source = state.selected.size > 0 ? "selected" : "focused";
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text bold color="magenta">Targets</Text>
        <Text dimColor> · {names.length} {source}{bulk ? "" : ""}: </Text>
        <Text>{summarizeTargets(names, 6)}</Text>
      </Text>
      <Text dimColor>↩ esc to back · Functions to edit</Text>
    </Box>
  );
};
