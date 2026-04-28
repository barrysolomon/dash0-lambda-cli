/**
 * Install wizard. Steps: function-pick (if not focused) → endpoint →
 * auth (token / secret-arn) → confirm → apply. Re-uses the underlying
 * install() command function so behavior is identical to the flag CLI.
 *
 * Output from install() is captured into a small log panel at the bottom
 * so the screen doesn't get clobbered by raw stdout.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { install } from "../../commands/install.js";
import { loadConfig, saveConfig } from "../../lib/config.js";
import { resolveTargets, summarizeTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";
import type { ScreenProps } from "../types.js";
import { useFunctionList } from "../hooks/useFunctionList.js";

type Step =
  | "pick-fn"
  | "endpoint"
  | "auth-method"
  | "token"
  | "secret-arn"
  | "confirm"
  | "applying"
  | "done"
  | "error";

export const Install: React.FC<ScreenProps> = ({ state, setState }) => {
  // Resolve targets up-front. Selection wins over focused.
  const resolved = resolveTargets(state);
  const [step, setStep] = useState<Step>(
    resolved.names.length > 0 ? "endpoint" : "pick-fn",
  );
  const [fn, setFn] = useState<string | undefined>(resolved.names[0]);
  const [endpoint, setEndpoint] = useState("");
  const [authMethod, setAuthMethod] = useState<"token" | "secret">("token");
  const [token, setToken] = useState("");
  const [secretArn, setSecretArn] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  // Load saved defaults on mount.
  useEffect(() => {
    loadConfig().then((cfg) => {
      if (!endpoint && cfg.endpoint) setEndpoint(cfg.endpoint);
      if (cfg.tokenSecretArn) {
        setSecretArn(cfg.tokenSecretArn);
        setAuthMethod("secret");
      }
    });
  }, []);

  // ESC handled globally by App.

  const region = state.region;

  const onSubmit = async () => {
    setStep("applying");
    setLogs([]);
    // Selection wins; fall back to the wizard-picked single function.
    const targets =
      resolved.names.length > 0 ? resolved.names : fn ? [fn] : [];
    const log = (s: string) => setLogs((prev) => [...prev, s].slice(-60));
    try {
      await captureConsole(
        { onLine: log },
        async () => {
          for (const name of targets) {
            log(`▶ ${name}`);
            await install({
              function: name,
              region,
              endpoint,
              token: authMethod === "token" ? token : undefined,
              tokenSecretArn: authMethod === "secret" ? secretArn : undefined,
            });
          }
          await saveConfig({
            region,
            endpoint,
            tokenSecretArn: authMethod === "secret" ? secretArn : undefined,
          });
        },
      );
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
      setStep("error");
    }
  };

  // Render per step.
  if (step === "pick-fn") return <PickFunction state={state} setFn={(name) => { setFn(name); setStep("endpoint"); }} />;
  if (step === "endpoint")
    return (
      <Form
        title="Step 1 of 4 — Dash0 OTLP endpoint"
        prompt={`Endpoint for ${state.region}:`}
        defaultValue={
          endpoint ||
          `https://ingress.${state.region.startsWith("eu-") ? "eu-west-1" : "us-west-2"}.aws.dash0.com:4318`
        }
        onSubmit={(v) => {
          setEndpoint(v);
          setStep("auth-method");
        }}
      />
    );
  if (step === "auth-method")
    return (
      <Pick
        title="Step 2 of 4 — Authentication"
        items={[
          { label: "Token (paste it now, hidden)", value: "token" },
          { label: "Existing Secrets Manager ARN", value: "secret" },
        ]}
        onSelect={(v) => {
          setAuthMethod(v as "token" | "secret");
          setStep(v === "token" ? "token" : "secret-arn");
        }}
      />
    );
  if (step === "token")
    return (
      <Form
        title="Step 3 of 4 — Dash0 token"
        prompt="Token (input is masked):"
        mask
        validate={(v) =>
          /^auth_[A-Za-z0-9]{32,}$/.test(v.trim())
            ? null
            : "expecting 'auth_' + 32+ chars"
        }
        onSubmit={(v) => {
          setToken(v.trim());
          setStep("confirm");
        }}
      />
    );
  if (step === "secret-arn")
    return (
      <Form
        title="Step 3 of 4 — Secrets Manager ARN"
        prompt="ARN:"
        defaultValue={secretArn}
        validate={(v) =>
          /^arn:aws:secretsmanager:/.test(v.trim())
            ? null
            : "must be a Secrets Manager ARN"
        }
        onSubmit={(v) => {
          setSecretArn(v.trim());
          setStep("confirm");
        }}
      />
    );
  if (step === "confirm") {
    const targets =
      resolved.names.length > 0 ? resolved.names : fn ? [fn] : [];
    return (
      <Box flexDirection="column">
        <Text bold>Step 4 of 4 — Review</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text dimColor>function(s) ({targets.length}):</Text>{" "}
            {summarizeTargets(targets)}
          </Text>
          <Text>
            <Text dimColor>region:</Text> {region}
          </Text>
          <Text>
            <Text dimColor>endpoint:</Text> {endpoint}
          </Text>
          <Text>
            <Text dimColor>auth:</Text>{" "}
            {authMethod === "token" ? "DASH0_TOKEN" : `DASH0_TOKEN_SECRET_ARN=${secretArn}`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Pick
            title="Apply?"
            items={[
              { label: "Yes — install on " + targets.length + " function(s)", value: "yes" },
              { label: "No — back to home", value: "no" },
            ]}
            onSelect={(v) => {
              if (v === "yes") onSubmit();
              else setState((s) => ({ ...s, screen: "home", back: [] }));
            }}
          />
        </Box>
      </Box>
    );
  }
  if (step === "applying" || step === "done" || step === "error") {
    return (
      <Box flexDirection="column">
        <Text bold>
          {step === "applying" ? (
            <>
              <Spinner type="dots" /> Applying…
            </>
          ) : step === "done" ? (
            <Text color="green">✔ Done</Text>
          ) : (
            <Text color="red">✘ Failed: {error}</Text>
          )}
        </Text>
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          {logs.length === 0 ? (
            <Text dimColor>(no output yet)</Text>
          ) : (
            logs.map((l, i) => <Text key={i}>{l}</Text>)
          )}
        </Box>
        {(step === "done" || step === "error") && (
          <Box marginTop={1}>
            <Text dimColor>Press </Text>
            <Text bold>esc</Text>
            <Text dimColor> to return</Text>
          </Box>
        )}
      </Box>
    );
  }
  return <Text>?</Text>;
};

const PickFunction: React.FC<{
  state: import("../types.js").AppState;
  setFn: (name: string) => void;
}> = ({ state, setFn }) => {
  const { functions, loading, error } = useFunctionList(state.region);
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState(true);
  useInput((_, key) => {
    if (key.return && filter && !filterMode) {
      const match = functions.find((f) =>
        f.functionName.toLowerCase().includes(filter.toLowerCase()),
      );
      if (match) setFn(match.functionName);
    }
  });
  if (loading)
    return (
      <Text>
        <Spinner type="dots" /> loading functions…
      </Text>
    );
  if (error) return <Text color="red">{error}</Text>;
  const filtered = functions.filter((f) =>
    f.functionName.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Box flexDirection="column">
      <Text bold>Pick a function:</Text>
      <Box marginTop={1}>
        <Text>filter: </Text>
        <TextInput
          value={filter}
          onChange={setFilter}
          onSubmit={() => setFilterMode(false)}
        />
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={filtered.slice(0, 12).map((f) => ({
            key: f.functionName,
            label: f.functionName,
            value: f.functionName,
          }))}
          onSelect={(item) => setFn(item.value)}
          limit={12}
        />
      </Box>
    </Box>
  );
};

const Form: React.FC<{
  title: string;
  prompt: string;
  defaultValue?: string;
  mask?: boolean;
  validate?: (v: string) => string | null;
  onSubmit: (v: string) => void;
}> = ({ title, prompt, defaultValue, mask, validate, onSubmit }) => {
  const [value, setValue] = useState(defaultValue ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <Text>{prompt} </Text>
        <TextInput
          value={value}
          onChange={setValue}
          mask={mask ? "*" : undefined}
          onSubmit={(v) => {
            if (validate) {
              const e = validate(v);
              if (e) {
                setError(e);
                return;
              }
            }
            onSubmit(v);
          }}
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
};

const Pick: React.FC<{
  title: string;
  items: Array<{ label: string; value: string }>;
  onSelect: (v: string) => void;
}> = ({ title, items, onSelect }) => (
  <Box flexDirection="column">
    <Text bold>{title}</Text>
    <Box marginTop={1}>
      <SelectInput
        items={items.map((i) => ({ key: i.value, label: i.label, value: i.value }))}
        onSelect={(item) => onSelect(item.value)}
      />
    </Box>
  </Box>
);
