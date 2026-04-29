import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { uninstall } from "../../commands/uninstall.js";
import type { ScreenProps } from "../types.js";
import { resolveTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";
import { runBulk, type BulkResult } from "../lib/bulk.js";
import { BulkSummary } from "../components/BulkSummary.js";

export const Uninstall: React.FC<ScreenProps> = ({ state, setState }) => {
  // Selection wins (even at size==1) over a single focused row.
  const targets = resolveTargets(state).names;
  const [stage, setStage] = useState<"confirm" | "running" | "done">("confirm");
  const [bulkRows, setBulkRows] = useState<BulkResult[]>([]);

  if (targets.length === 0) {
    return (
      <Text dimColor>
        No function selected. Open the Functions screen and pick one (or press ␣ on multiple).
      </Text>
    );
  }

  const run = async () => {
    setStage("running");
    setBulkRows([]);
    // Best-effort: per-target try/catch via runBulk. The captureConsole
    // wrapper just keeps the underlying command's stdout from littering
    // the TUI — outcomes are tracked in bulkRows.
    await captureConsole({ onLine: () => undefined }, async () => {
      await runBulk(
        targets,
        (name) =>
          uninstall({ function: name, region: state.region, clearWrapper: true }).then(
            () => undefined,
          ),
        setBulkRows,
      );
    });
    setStage("done");
  };

  if (stage === "confirm") {
    return (
      <Box flexDirection="column">
        <Text bold>Uninstall Dash0 from:</Text>
        <Text dimColor>{targets.length} target(s)</Text>
        <Box marginTop={1} flexDirection="column">
          {targets.slice(0, 8).map((t) => (
            <Text key={t}>  • {t}</Text>
          ))}
          {targets.length > 8 && (
            <Text dimColor>  …and {targets.length - 8} more</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { key: "yes", label: `Yes — uninstall ${targets.length}`, value: "yes" },
              { key: "no", label: "No — back", value: "no" },
            ]}
            onSelect={(i) => {
              if (i.value === "yes") void run();
              else
                setState((s) => {
                  const back = [...s.back];
                  const prev = back.pop() ?? "home";
                  return { ...s, screen: prev, back };
                });
            }}
          />
        </Box>
      </Box>
    );
  }
  return (
    <BulkSummary
      title={stage === "running" ? "Uninstalling Dash0…" : "Uninstall complete"}
      rows={bulkRows}
      phase={stage === "running" ? "running" : "done"}
    />
  );
};
