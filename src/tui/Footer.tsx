/** Persistent footer: status line + context-relevant hotkeys. */

import React from "react";
import { Box, Text } from "ink";
import type { AppState, Screen } from "./types.js";

const COMMON_HOTKEYS: Array<[string, string]> = [
  ["a", "profile"],
  ["R", "region"],
  ["?", "help"],
  ["q", "quit"],
];

const SCREEN_HOTKEYS: Partial<Record<Screen, Array<[string, string]>>> = {
  home: [["↑↓", "navigate"], ["⏎", "select"]],
  functions: [
    ["↑↓", "nav"],
    ["/", "filter"],
    ["␣", "toggle"],
    ["A", "all"],
    ["x", "clear"],
    ["i", "install"],
    ["v", "validate"],
    ["u", "uninstall"],
    ["U", "update layer"],
    ["s", "switch vendor"],
    ["o", "open"],
    ["e", "env"],
    ["r", "refresh"],
    ["esc", "back"],
  ],
  install: [["⏎", "next"], ["esc", "back"]],
  validate: [["esc", "back"]],
  uninstall: [["⏎", "confirm"], ["esc", "back"]],
  migrate: [["⏎", "next"], ["esc", "back"]],
  generate: [["⏎", "next"], ["esc", "back"]],
  console: [["⏎", "select"], ["esc", "back"]],
  config: [["⏎", "select"], ["esc", "back"]],
  "switch-region": [["⏎", "select"], ["esc", "cancel"]],
  "switch-profile": [["↑↓", "nav"], ["PgUp/Dn", "page"], ["g/G", "top/bot"], ["⏎", "select"], ["esc", "cancel"]],
  help: [["esc", "close"]],
  "auth-error": [["⏎", "select"], ["R", "retry verify"], ["esc", "back"]],
  "switch-vendor": [["⏎", "select"], ["esc", "back"]],
  "update-layer": [["↑↓", "nav"], ["␣", "toggle"], ["A", "all out-of-date"], ["x", "clear"], ["v", "pin version"], ["⏎", "apply"], ["r", "rescan"], ["esc", "back"]],
  "env-manage": [["↑↓", "nav"], ["⏎", "edit"], ["d/c", "delete"], ["x", "revert"], ["R", "reveal"], ["s", "save"], ["esc", "back"]],
};

const STATUS_COLOR = {
  info: "cyan",
  warn: "yellow",
  error: "red",
  ok: "green",
} as const;

export const Footer: React.FC<{ state: AppState }> = ({ state }) => {
  const screenHotkeys = SCREEN_HOTKEYS[state.screen] ?? [];
  return (
    <Box flexDirection="column">
      {state.status && (
        <Box paddingX={1}>
          <Text color={STATUS_COLOR[state.status.tone]}>
            {iconFor(state.status.tone)} {state.status.text}
          </Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>
          {screenHotkeys.map(([k, l], i) => (
            <Text key={i}>
              {i > 0 && "   "}
              <Text bold>{k}</Text> {l}
            </Text>
          ))}
        </Text>
        <Text dimColor>
          {COMMON_HOTKEYS.map(([k, l], i) => (
            <Text key={i}>
              {i > 0 && "   "}
              <Text bold>{k}</Text> {l}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
};

function iconFor(tone: "info" | "warn" | "error" | "ok"): string {
  return tone === "ok" ? "✔" : tone === "warn" ? "!" : tone === "error" ? "✘" : "ℹ";
}
