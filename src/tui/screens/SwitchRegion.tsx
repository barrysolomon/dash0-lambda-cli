import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { ScreenProps } from "../types.js";

const REGIONS = [
  { label: "us-west-2 · Oregon", value: "us-west-2" },
  { label: "us-east-1 · N. Virginia", value: "us-east-1" },
  { label: "us-east-2 · Ohio", value: "us-east-2" },
  { label: "us-west-1 · N. California", value: "us-west-1" },
  { label: "eu-west-1 · Ireland", value: "eu-west-1" },
  { label: "eu-central-1 · Frankfurt", value: "eu-central-1" },
  { label: "eu-west-2 · London", value: "eu-west-2" },
  { label: "eu-north-1 · Stockholm", value: "eu-north-1" },
  { label: "ap-northeast-1 · Tokyo", value: "ap-northeast-1" },
  { label: "ap-southeast-1 · Singapore", value: "ap-southeast-1" },
  { label: "ap-southeast-2 · Sydney", value: "ap-southeast-2" },
  { label: "ap-south-1 · Mumbai", value: "ap-south-1" },
  { label: "ca-central-1 · Canada Central", value: "ca-central-1" },
  { label: "sa-east-1 · São Paulo", value: "sa-east-1" },
];

export const SwitchRegion: React.FC<ScreenProps> = ({ state, setState }) => {
  const items = REGIONS.map((r) => ({
    key: r.value,
    label:
      r.value === state.region
        ? `${r.label}  (current)`
        : r.label,
    value: r.value,
  }));
  return (
    <Box flexDirection="column">
      <Text bold>Switch AWS region</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={Math.max(
            0,
            REGIONS.findIndex((r) => r.value === state.region),
          )}
          onSelect={(item) => {
            // Setting AWS_REGION ensures any new SDK clients pick this up.
            process.env.AWS_REGION = item.value;
            setState((s) => {
              const back = [...s.back];
              const prev = back.pop() ?? "home";
              // Selection is keyed by function name and scoped to the
              // previous region — those names refer to different
              // Lambdas in the new region (or don't exist at all). Drop
              // the selection on a real region change so the next
              // bulk action can't fire against a phantom set. Same
              // reasoning for `focused`. We skip the wipe when the
              // user re-picks their current region (a no-op).
              if (item.value === s.region) {
                return { ...s, screen: prev, back };
              }
              return {
                ...s,
                region: item.value,
                screen: prev,
                back,
                selected: new Set<string>(),
                focused: undefined,
                status: { text: `Region → ${item.value}`, tone: "ok" },
              };
            });
          }}
          limit={REGIONS.length}
        />
      </Box>
    </Box>
  );
};
