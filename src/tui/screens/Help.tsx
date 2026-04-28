import React from "react";
import { Box, Text } from "ink";
import type { ScreenProps } from "../types.js";

export const Help: React.FC<ScreenProps> = () => (
  <Box flexDirection="column">
    <Text bold>Keyboard reference</Text>
    <Box marginTop={1} flexDirection="column">
      <Text bold>Global</Text>
      <Text>  q          quit (from home)</Text>
      <Text>  Ctrl-C     quit (anywhere)</Text>
      <Text>  esc        back / cancel</Text>
      <Text>  ?          this help</Text>
      <Text>  a          switch AWS profile</Text>
      <Text>  R          switch AWS region</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold>Functions screen</Text>
      <Text>  ↑↓        navigate</Text>
      <Text>  PgUp/PgDn page</Text>
      <Text>  g/G       top/bottom</Text>
      <Text>  /         filter</Text>
      <Text>  ␣ space   toggle selection</Text>
      <Text>  A         select all (filtered)</Text>
      <Text>  x         clear selection</Text>
      <Text>  ⏎ enter   install on highlighted (or selection)</Text>
      <Text>  i / v / u install / validate / uninstall</Text>
      <Text>  o         open in AWS console</Text>
      <Text>  r         refresh</Text>
    </Box>
    <Box marginTop={1}>
      <Text dimColor>Press </Text>
      <Text bold>esc</Text>
      <Text dimColor> to close this overlay.</Text>
    </Box>
  </Box>
);
