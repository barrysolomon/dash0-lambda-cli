import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import {
  clearConfig,
  configPath,
  describeConfig,
  loadConfig,
  type SavedConfig,
} from "../../lib/config.js";
import type { ScreenProps } from "../types.js";

export const ConfigScreen: React.FC<ScreenProps> = () => {
  const [cfg, setCfg] = useState<SavedConfig | undefined>();
  const [msg, setMsg] = useState<string | undefined>();
  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);
  if (!cfg) return <Text>loading…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>Saved config ({configPath()})</Text>
      <Box marginTop={1} flexDirection="column">
        {Object.entries(cfg).length === 0 ? (
          <Text dimColor>(empty)</Text>
        ) : (
          describeConfig(cfg)
            .split("\n")
            .map((l, i) => <Text key={i}>{l}</Text>)
        )}
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { key: "clear", label: "Clear all saved config", value: "clear" },
            { key: "back", label: "Back", value: "back" },
          ]}
          onSelect={async (i) => {
            if (i.value === "clear") {
              const removed = await clearConfig();
              setMsg(removed ? "Config cleared." : "No config existed.");
              setCfg({});
            }
          }}
        />
      </Box>
      {msg && (
        <Box marginTop={1}>
          <Text color="green">✔ {msg}</Text>
        </Box>
      )}
    </Box>
  );
};
