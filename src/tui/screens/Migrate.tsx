/**
 * Migrate screen — Lumigo → Dash0 swap.
 *
 * Two scoping modes:
 *   - "selection": uses the multi-select set from the Functions screen.
 *     Auto-skipped when nothing is selected.
 *   - "regex":     matches function names against a user-typed regex, like
 *                  the migrate flag CLI.
 *
 * Always plans first (dry-run), then asks for confirmation.
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { migrate } from "../../commands/migrate.js";
import type { ScreenProps } from "../types.js";
import { resolveTargets, summarizeTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";

type Step =
  | "scope"
  | "filter"
  | "endpoint"
  | "token"
  | "confirm"
  | "running"
  | "done"
  | "error";

export const Migrate: React.FC<ScreenProps> = ({ state }) => {
  const selected = resolveTargets(state).names;
  const haveSelection = selected.length > 0;

  const [step, setStep] = useState<Step>(haveSelection ? "scope" : "filter");
  const [scope, setScope] = useState<"selection" | "regex">(
    haveSelection ? "selection" : "regex",
  );
  const [filter, setFilter] = useState("^");
  const [endpoint, setEndpoint] = useState(
    `https://ingress.${state.region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`,
  );
  const [token, setToken] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [err, setErr] = useState<string | undefined>();

  const run = async () => {
    setStep("running");
    try {
      await captureConsole(
        { onLine: (l) => setLogs((p) => [...p, l].slice(-40)) },
        async () => {
          if (scope === "selection") {
            // The migrate command takes a single --function or a regex --filter,
            // but for a discrete selection we need to invoke once per function.
            for (const name of selected) {
              await migrate({
                function: name,
                region: state.region,
                endpoint,
                token,
                yes: true,
              });
            }
          } else {
            await migrate({
              filter,
              region: state.region,
              endpoint,
              token,
              concurrency: 4,
              yes: true,
            });
          }
        },
      );
      setStep("done");
    } catch (e) {
      setErr((e as Error).message);
      setStep("error");
    }
  };

  if (step === "scope")
    return (
      <Box flexDirection="column">
        <Text bold>Migrate Lumigo → Dash0</Text>
        <Text dimColor>
          You have {selected.length} function(s) selected. Use them, or pick a
          regex instead?
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              {
                key: "sel",
                label: `Use selection (${selected.length}): ${summarizeTargets(selected)}`,
                value: "selection",
              },
              {
                key: "rx",
                label: "Use a regex match instead",
                value: "regex",
              },
            ]}
            onSelect={(i) => {
              setScope(i.value as "selection" | "regex");
              setStep(i.value === "regex" ? "filter" : "endpoint");
            }}
          />
        </Box>
      </Box>
    );

  if (step === "filter")
    return (
      <Box flexDirection="column">
        <Text bold>Regex matching function names</Text>
        <Box marginTop={1}>
          <Text>regex: </Text>
          <TextInput value={filter} onChange={setFilter} onSubmit={() => setStep("endpoint")} />
        </Box>
      </Box>
    );

  if (step === "endpoint")
    return (
      <Box flexDirection="column">
        <Text bold>Endpoint</Text>
        <Box marginTop={1}>
          <Text>Endpoint: </Text>
          <TextInput value={endpoint} onChange={setEndpoint} onSubmit={() => setStep("token")} />
        </Box>
      </Box>
    );

  if (step === "token")
    return (
      <Box flexDirection="column">
        <Text bold>Token</Text>
        <Box marginTop={1}>
          <Text>Dash0 token: </Text>
          <TextInput value={token} onChange={setToken} mask="*" onSubmit={() => setStep("confirm")} />
        </Box>
      </Box>
    );

  if (step === "confirm")
    return (
      <Box flexDirection="column">
        <Text bold>Review</Text>
        <Text>
          <Text dimColor>scope:</Text>{" "}
          {scope === "selection"
            ? `selection (${selected.length}): ${summarizeTargets(selected)}`
            : `regex: ${filter}`}
        </Text>
        <Text>
          <Text dimColor>endpoint:</Text> {endpoint}
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { key: "yes", label: "Yes — apply", value: "yes" },
              { key: "no", label: "No — back", value: "no" },
            ]}
            onSelect={(i) =>
              i.value === "yes"
                ? run()
                : setStep(scope === "regex" ? "filter" : "scope")
            }
          />
        </Box>
      </Box>
    );

  return (
    <Box flexDirection="column">
      <Text bold>
        {step === "running" ? (
          <>
            <Spinner type="dots" /> Migrating…
          </>
        ) : step === "done" ? (
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
