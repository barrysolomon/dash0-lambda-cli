/** Home screen: top-level action picker. */

import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { ScreenProps, Screen } from "../types.js";

interface ActionItem {
  label: string;
  value: Screen;
  description: string;
}

const ACTIONS: ActionItem[] = [
  {
    label: "List functions and their footprint",
    value: "functions",
    description: "Live list with Dash0/Lumigo status. Multi-select for bulk ops.",
  },
  {
    label: "Install Dash0 on a Lambda function",
    value: "install",
    description: "Attach the layer + set required env vars (with plan + confirm)",
  },
  {
    label: "Update Dash0 layer to current version",
    value: "update-layer",
    description:
      "Bump the layer ARN on functions that already have Dash0. Doesn't touch env vars / token.",
  },
  {
    label: "Validate / doctor an existing setup",
    value: "validate",
    description: "Health-check + live CloudWatch log tailer",
  },
  {
    label: "Migrate from Lumigo to Dash0",
    value: "migrate",
    description: "Swap Lumigo for Dash0 (single function or filter regex)",
  },
  {
    label: "Uninstall Dash0 from a function",
    value: "uninstall",
    description: "Remove the layer + DASH0_* env vars",
  },
  {
    label: "Open a function in the AWS console",
    value: "console",
    description: "Pick a function and jump to Lambda / CloudWatch Logs",
  },
  {
    label: "Generate IaC snippet (Terraform / SAM / CDK / Serverless)",
    value: "generate",
    description: "Emit a snippet you can paste into your templates",
  },
  {
    label: "Manage saved credentials & defaults",
    value: "config",
    description: "View / edit ./.dash0-lambda.json, rotate Secrets Manager token",
  },
];

export const Home: React.FC<ScreenProps> = ({ state, setState }) => {
  const items = ACTIONS.map((a) => ({
    label: a.label,
    value: a.value,
    key: a.value,
  }));
  const handleSelect = (item: { value: Screen }) => {
    setState((s) => ({ ...s, back: [...s.back, "home"], screen: item.value }));
  };
  // Show description of the focused item.
  const [focused, setFocused] = React.useState<Screen>("functions");
  const focusedAction = ACTIONS.find((a) => a.value === focused);

  return (
    <Box flexDirection="column">
      <Text bold>What would you like to do?</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={handleSelect}
          onHighlight={(item) => setFocused(item.value as Screen)}
          limit={ACTIONS.length}
        />
      </Box>
      {focusedAction && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{focusedAction.description}</Text>
        </Box>
      )}
    </Box>
  );
};
