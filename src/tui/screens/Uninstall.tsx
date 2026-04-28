import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { uninstall } from "../../commands/uninstall.js";
import type { ScreenProps } from "../types.js";
import { resolveTargets, summarizeTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";

export const Uninstall: React.FC<ScreenProps> = ({ state, setState }) => {
  // Selection wins (even at size==1) over a single focused row.
  const targets = resolveTargets(state).names;
  const [stage, setStage] = useState<"confirm" | "running" | "done" | "error">(
    "confirm",
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [err, setErr] = useState<string | undefined>();

  if (targets.length === 0) {
    return (
      <Text dimColor>
        No function selected. Open the Functions screen and pick one (or press ␣ on multiple).
      </Text>
    );
  }

  const run = async () => {
    setStage("running");
    try {
      await captureConsole(
        { onLine: (l) => setLogs((p) => [...p, l].slice(-40)) },
        async () => {
          for (const name of targets) {
            await uninstall({ function: name, region: state.region, clearWrapper: true });
          }
        },
      );
      setStage("done");
    } catch (e) {
      setErr((e as Error).message);
      setStage("error");
    }
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
              if (i.value === "yes") run();
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
    <Box flexDirection="column">
      <Text bold>
        {stage === "running" ? (
          <>
            <Spinner type="dots" /> Uninstalling…
          </>
        ) : stage === "done" ? (
          <Text color="green">✔ Done</Text>
        ) : (
          <Text color="red">✘ {err}</Text>
        )}
      </Text>
      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
      >
        {logs.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
    </Box>
  );
};
