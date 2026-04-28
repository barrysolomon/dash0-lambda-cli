import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import {
  cloudwatchLogsUrl,
  lambdaConsoleUrl,
  openUrl,
  type LambdaConsoleTab,
} from "../../lib/console-urls.js";
import type { ScreenProps } from "../types.js";

export const ConsoleScreen: React.FC<ScreenProps> = ({ state }) => {
  const fnName = state.focused?.functionName;
  const [opened, setOpened] = useState<string | undefined>();
  if (!fnName) {
    return (
      <Text dimColor>
        No function focused. Pick one on the Functions screen first (highlight a row, press 'o').
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>Open {fnName} in the AWS console</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { key: "code", label: "Lambda → Code & test", value: "code" },
            { key: "cfg", label: "Lambda → Configuration", value: "configuration" },
            { key: "mon", label: "Lambda → Monitor", value: "monitoring" },
            { key: "logs", label: "CloudWatch Logs", value: "logs" },
          ]}
          onSelect={async (item) => {
            const url =
              item.value === "logs"
                ? cloudwatchLogsUrl({ region: state.region, functionName: fnName })
                : lambdaConsoleUrl({
                    region: state.region,
                    functionName: fnName,
                    tab: item.value as LambdaConsoleTab,
                  });
            await openUrl(url);
            setOpened(url);
          }}
        />
      </Box>
      {opened && (
        <Box marginTop={1} flexDirection="column">
          <Text color="green">✔ Launched in your default browser:</Text>
          <Text underline>{opened}</Text>
        </Box>
      )}
    </Box>
  );
};
