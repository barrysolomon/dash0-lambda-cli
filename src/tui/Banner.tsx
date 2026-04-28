/** Persistent banner: program name + AWS identity. */

import React from "react";
import { Box, Text } from "ink";
import type { AppState } from "./types.js";

export const Banner: React.FC<{ state: AppState }> = ({ state }) => {
  const id = state.identity;
  const account = id?.account ? id.account : "not detected";
  const arnTail = id?.arn?.split("/").slice(-1)[0] ?? "?";
  const profile = state.profile ?? process.env.AWS_PROFILE ?? "default";
  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text bold color="cyan">dash0-lambda</Text>
        <Text dimColor> · interactive TUI (unofficial)</Text>
      </Text>
      <Text>
        <Text dimColor>account </Text>
        <Text bold>{account}</Text>
        {id?.arn && <Text dimColor> as {arnTail}</Text>}
        <Text dimColor>  ·  profile </Text>
        <Text bold>{profile}</Text>
        <Text dimColor>  ·  region </Text>
        <Text bold>{state.region}</Text>
      </Text>
    </Box>
  );
};
