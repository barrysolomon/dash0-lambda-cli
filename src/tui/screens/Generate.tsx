import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import {
  generate,
  type IacFlavor,
} from "../../commands/generate.js";
import {
  KNOWN_LATEST_LAYER_VERSION,
  type RuntimeFamily,
} from "../../lib/layers.js";
import type { ScreenProps } from "../types.js";

type Step = "flavor" | "family" | "endpoint" | "ssm" | "output";

export const Generate: React.FC<ScreenProps> = ({ state }) => {
  const [step, setStep] = useState<Step>("flavor");
  const [flavor, setFlavor] = useState<IacFlavor>("terraform");
  const [family, setFamily] = useState<RuntimeFamily>("node");
  const [endpoint, setEndpoint] = useState(
    `https://ingress.${state.region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`,
  );
  const [ssm, setSsm] = useState("/dash0/prod/token");
  const [output, setOutput] = useState("");

  if (step === "flavor")
    return (
      <Box flexDirection="column">
        <Text bold>IaC flavor</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { key: "tf", label: "Terraform", value: "terraform" },
              { key: "cf", label: "AWS CloudFormation", value: "cloudformation" },
              { key: "sam", label: "AWS SAM", value: "sam" },
              { key: "cdk", label: "AWS CDK (TypeScript)", value: "cdk-ts" },
              { key: "sls", label: "Serverless Framework", value: "serverless" },
            ]}
            onSelect={(i) => {
              setFlavor(i.value as IacFlavor);
              setStep("family");
            }}
          />
        </Box>
      </Box>
    );
  if (step === "family")
    return (
      <Box flexDirection="column">
        <Text bold>Runtime family</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { key: "node", label: "node", value: "node" },
              { key: "python", label: "python", value: "python" },
              { key: "java", label: "java", value: "java" },
              { key: "manual", label: "manual", value: "manual" },
            ]}
            onSelect={(i) => {
              setFamily(i.value as RuntimeFamily);
              setStep("endpoint");
            }}
          />
        </Box>
      </Box>
    );
  if (step === "endpoint")
    return (
      <Box flexDirection="column">
        <Text bold>Endpoint</Text>
        <Box marginTop={1}>
          <Text>Endpoint: </Text>
          <TextInput value={endpoint} onChange={setEndpoint} onSubmit={() => setStep("ssm")} />
        </Box>
      </Box>
    );
  if (step === "ssm")
    return (
      <Box flexDirection="column">
        <Text bold>SSM parameter for the token</Text>
        <Box marginTop={1}>
          <Text>SSM path: </Text>
          <TextInput
            value={ssm}
            onChange={setSsm}
            onSubmit={() => {
              setOutput(
                generate({
                  flavor,
                  region: state.region,
                  family,
                  layerVersion: KNOWN_LATEST_LAYER_VERSION[family],
                  endpoint,
                  tokenFromSsm: ssm,
                }),
              );
              setStep("output");
            }}
          />
        </Box>
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Text bold>Snippet (copy from below; press esc to return)</Text>
      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        {output.split("\n").slice(0, 30).map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
    </Box>
  );
};
