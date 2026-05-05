/**
 * Install wizard. Steps: function-pick (if not focused) → endpoint →
 * auth → confirm → apply. Re-uses the underlying install() command
 * function so behavior is identical to the flag CLI.
 *
 * The auth step is a tree:
 *
 *                ┌─ Use saved Secrets Manager ARN  (saved-secret)
 *   Saved opts ─┤
 *                └─ Use saved local token file     (saved-local)
 *
 *   Use Secrets Manager  (sets DASH0_TOKEN_SECRET_ARN on the function)
 *                ├─ Paste token, save to AWS Secrets Manager  (new-paste-save-secret)
 *                └─ Use existing Secrets Manager ARN          (new-existing-arn)
 *
 *   Use literal env var  (sets DASH0_TOKEN on the function)
 *                ├─ Paste, save to local file                 (new-paste-save-local)
 *                └─ Paste, don't save                         (new-paste-no-save)
 *
 * "Saved opts" only renders when loadConfig() returned a token reference,
 * mirroring the empty-section-collapse pattern used on Home.
 *
 * After token collection (and optional save), the wizard converges to a
 * `{ usingSecret, arn?, token? }` shape that feeds install() — there's no
 * branchy logic past the auth step.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { install } from "../../commands/install.js";
import {
  loadConfig,
  loadLocalToken,
  saveConfig,
  saveTokenLocally,
  type SavedConfig,
} from "../../lib/config.js";
import { defaultSecretName, saveTokenToSecret } from "../../lib/secrets.js";
import { resolveTargets, summarizeTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";
import { runBulk, type BulkResult } from "../lib/bulk.js";
import { BulkSummary } from "../components/BulkSummary.js";
import type { ScreenProps } from "../types.js";
import { useFunctionList } from "../hooks/useFunctionList.js";

type AuthChoice =
  | "saved-secret"
  | "saved-local"
  | "new-paste-save-secret"
  | "new-paste-save-local"
  | "new-paste-no-save"
  | "new-existing-arn";

/** Resolved auth — what install() actually receives. */
type AuthResolved =
  | { usingSecret: true; arn: string; secretKey?: string; sourceLabel: string }
  | { usingSecret: false; token: string; sourceLabel: string };

type Step =
  | "pick-fn"
  | "endpoint"
  | "auth-choice"
  | "auth-token-input"
  | "auth-arn-input"
  | "auth-saving"
  | "confirm"
  | "applying"
  | "done"
  /** Setup-time failure (before bulk apply): bad token, secrets manager
   *  failed, etc. Not used for per-target install failures — those go to
   *  the BulkSummary on the "done" screen. */
  | "error";

export const Install: React.FC<ScreenProps> = ({ state, setState }) => {
  // Resolve targets up-front. Selection wins over focused.
  const resolved = resolveTargets(state);
  const [step, setStep] = useState<Step>(
    resolved.names.length > 0 ? "endpoint" : "pick-fn",
  );
  const [fn, setFn] = useState<string | undefined>(resolved.names[0]);
  const [endpoint, setEndpoint] = useState("");
  const [savedCfg, setSavedCfg] = useState<SavedConfig>({});
  const [authChoice, setAuthChoice] = useState<AuthChoice | undefined>();
  const [resolvedAuth, setResolvedAuth] = useState<AuthResolved | undefined>();
  /** What we tell the user we're doing in the "auth-saving" step. */
  const [savingMessage, setSavingMessage] = useState<string>("");
  const [bulkRows, setBulkRows] = useState<BulkResult[]>([]);
  const [error, setError] = useState<string | undefined>();

  // Load saved defaults on mount.
  useEffect(() => {
    loadConfig().then((cfg) => {
      setSavedCfg(cfg);
      if (!endpoint && cfg.endpoint) setEndpoint(cfg.endpoint);
    });
  }, []);

  const region = state.region;

  /** Drive the post-choice path: maybe collect token, maybe save, then confirm. */
  const advanceFromChoice = async (choice: AuthChoice) => {
    setAuthChoice(choice);
    setError(undefined);
    if (choice === "saved-secret") {
      // Already have an ARN saved. Resolve and skip ahead.
      if (!savedCfg.tokenSecretArn) return;
      setResolvedAuth({
        usingSecret: true,
        arn: savedCfg.tokenSecretArn,
        secretKey: savedCfg.tokenSecretKey,
        sourceLabel: "saved Secrets Manager ARN",
      });
      setStep("confirm");
      return;
    }
    if (choice === "saved-local") {
      // Read the local file now so a missing file fails loudly here, not
      // during apply.
      if (!savedCfg.tokenLocalFile) return;
      setStep("auth-saving");
      setSavingMessage("Reading saved local token…");
      try {
        const tok = await loadLocalToken(savedCfg.tokenLocalFile);
        if (!tok) throw new Error(`local token file is empty or missing: ${savedCfg.tokenLocalFile}`);
        setResolvedAuth({
          usingSecret: false,
          token: tok,
          sourceLabel: `saved local file (${savedCfg.tokenLocalFile})`,
        });
        setStep("confirm");
      } catch (err) {
        setError((err as Error).message);
        setStep("error");
      }
      return;
    }
    if (choice === "new-existing-arn") {
      setStep("auth-arn-input");
      return;
    }
    // All "new-paste-*" variants need the token first.
    setStep("auth-token-input");
  };

  /** Fired by the token-input form. Branches on what to do with the token. */
  const onTokenEntered = async (token: string) => {
    setError(undefined);
    if (authChoice === "new-paste-no-save") {
      setResolvedAuth({
        usingSecret: false,
        token,
        sourceLabel: "one-shot (not saved)",
      });
      setStep("confirm");
      return;
    }
    if (authChoice === "new-paste-save-local") {
      setStep("auth-saving");
      setSavingMessage("Saving token to local file…");
      try {
        const { configRelativePath } = await saveTokenLocally(token);
        await saveConfig({
          region,
          endpoint,
          tokenLocalFile: configRelativePath,
          // Make sure no stale ARN sticks around.
          tokenSecretArn: undefined,
          tokenSecretKey: undefined,
        });
        setSavedCfg((c) => ({
          ...c,
          tokenLocalFile: configRelativePath,
          tokenSecretArn: undefined,
          tokenSecretKey: undefined,
        }));
        setResolvedAuth({
          usingSecret: false,
          token,
          sourceLabel: `local file (${configRelativePath})`,
        });
        setStep("confirm");
      } catch (err) {
        setError((err as Error).message);
        setStep("error");
      }
      return;
    }
    if (authChoice === "new-paste-save-secret") {
      setStep("auth-saving");
      const name = defaultSecretName({ region });
      setSavingMessage(`Saving token to AWS Secrets Manager (${name})…`);
      try {
        const r = await saveTokenToSecret({
          region,
          name,
          token,
          shape: "string",
        });
        await saveConfig({
          region,
          endpoint,
          tokenSecretArn: r.arn,
          tokenSecretKey: r.key,
          tokenLocalFile: undefined,
        });
        setSavedCfg((c) => ({
          ...c,
          tokenSecretArn: r.arn,
          tokenSecretKey: r.key,
          tokenLocalFile: undefined,
        }));
        setResolvedAuth({
          usingSecret: true,
          arn: r.arn,
          secretKey: r.key,
          sourceLabel: r.created
            ? "newly-created Secrets Manager secret"
            : "rotated Secrets Manager secret",
        });
        setStep("confirm");
      } catch (err) {
        setError((err as Error).message);
        setStep("error");
      }
      return;
    }
  };

  const onArnEntered = (arn: string) => {
    setResolvedAuth({
      usingSecret: true,
      arn,
      sourceLabel: "manually-entered ARN",
    });
    setStep("confirm");
  };

  const onApply = async () => {
    if (!resolvedAuth) return;
    setStep("applying");
    setBulkRows([]);
    const targets = resolved.names.length > 0 ? resolved.names : fn ? [fn] : [];
    // Best-effort bulk: each target gets its own try/catch via runBulk.
    // One bad target (e.g. invalid IAM role) doesn't abort the rest.
    // captureConsole swallows printPlan / ok / warn output from install()
    // so the TUI shows the structured BulkSummary instead of raw logs.
    try {
      await captureConsole({ onLine: () => undefined }, async () => {
        await runBulk(
          targets,
          (name) =>
            install({
              function: name,
              region,
              endpoint,
              token: resolvedAuth.usingSecret ? undefined : resolvedAuth.token,
              tokenSecretArn: resolvedAuth.usingSecret
                ? resolvedAuth.arn
                : undefined,
              tokenSecretKey: resolvedAuth.usingSecret
                ? resolvedAuth.secretKey
                : undefined,
            }).then(() => undefined),
          setBulkRows,
        );
        // Endpoint is non-sensitive and helpful to remember even when the
        // user picked one-shot auth.
        await saveConfig({ region, endpoint });
      });
      setStep("done");
    } catch (err) {
      // Only thrown by saveConfig (the per-target loop never throws). If
      // it does fail, we still show whatever bulk rows we accumulated.
      setError((err as Error).message);
      setStep("done");
    }
  };

  // Render per step.
  if (step === "pick-fn")
    return (
      <PickFunction
        state={state}
        setFn={(name) => {
          setFn(name);
          setStep("endpoint");
        }}
      />
    );
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
          setStep("auth-choice");
        }}
      />
    );
  if (step === "auth-choice")
    return (
      <AuthChooser
        savedCfg={savedCfg}
        onPick={(c) => void advanceFromChoice(c)}
      />
    );
  if (step === "auth-token-input")
    return (
      <Form
        title="Step 3 of 4 — Dash0 token"
        prompt={tokenPromptFor(authChoice)}
        mask
        validate={(v) =>
          /^auth_[A-Za-z0-9]{32,}$/.test(v.trim())
            ? null
            : "expecting 'auth_' + 32+ chars"
        }
        onSubmit={(v) => void onTokenEntered(v.trim())}
      />
    );
  if (step === "auth-arn-input")
    return (
      <Form
        title="Step 3 of 4 — Secrets Manager ARN"
        prompt="ARN:"
        defaultValue={savedCfg.tokenSecretArn ?? ""}
        validate={(v) =>
          /^arn:aws:secretsmanager:/.test(v.trim())
            ? null
            : "must be a Secrets Manager ARN"
        }
        onSubmit={(v) => onArnEntered(v.trim())}
      />
    );
  if (step === "auth-saving")
    return (
      <Box flexDirection="column">
        <Text bold>
          <Spinner type="dots" /> {savingMessage}
        </Text>
      </Box>
    );
  if (step === "confirm" && resolvedAuth) {
    const targets = resolved.names.length > 0 ? resolved.names : fn ? [fn] : [];
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
            {resolvedAuth.usingSecret
              ? `DASH0_TOKEN_SECRET_ARN=${resolvedAuth.arn}`
              : "DASH0_TOKEN (set on each function)"}
          </Text>
          <Text dimColor>  source: {resolvedAuth.sourceLabel}</Text>
        </Box>
        <Box marginTop={1}>
          <Pick
            title="Apply?"
            items={[
              {
                label: `Yes — install on ${targets.length} function(s)`,
                value: "yes",
              },
              { label: "No — back to home", value: "no" },
            ]}
            onSelect={(v) => {
              if (v === "yes") void onApply();
              else setState((s) => ({ ...s, screen: "home", back: [] }));
            }}
          />
        </Box>
      </Box>
    );
  }
  if (step === "applying" || step === "done") {
    return (
      <Box flexDirection="column">
        <BulkSummary
          title={step === "applying" ? "Installing Dash0…" : "Install complete"}
          rows={bulkRows}
          phase={step === "applying" ? "running" : "done"}
        />
        {step === "done" && error && (
          <Box marginTop={1}>
            <Text color="yellow">! post-step warning: {error}</Text>
          </Box>
        )}
      </Box>
    );
  }
  if (step === "error") {
    // Setup-time failure (token save, secrets manager, etc.). Not a
    // per-target install failure — those land in BulkSummary above.
    return (
      <Box flexDirection="column">
        <Text bold color="red">
          ✘ {error ?? "Setup failed."}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text bold>esc</Text> to return.
          </Text>
        </Box>
      </Box>
    );
  }
  return <Text>?</Text>;
};

function tokenPromptFor(c: AuthChoice | undefined): string {
  switch (c) {
    case "new-paste-save-secret":
      return "Token (will be stored in AWS Secrets Manager):";
    case "new-paste-save-local":
      return "Token (will be saved locally at chmod 0600):";
    case "new-paste-no-save":
      return "Token (one-shot, not saved):";
    default:
      return "Token (input is masked):";
  }
}

/**
 * Sectioned auth chooser. Same hand-rolled list pattern as Home.tsx so
 * we can mix non-selectable headers + selectable rows. Saved options
 * collapse to nothing when there's nothing saved.
 */
const AuthChooser: React.FC<{
  savedCfg: SavedConfig;
  onPick: (c: AuthChoice) => void;
}> = ({ savedCfg, onPick }) => {
  const hasSavedSecret = !!savedCfg.tokenSecretArn;
  const hasSavedLocal = !!savedCfg.tokenLocalFile;
  const hasAnySaved = hasSavedSecret || hasSavedLocal;

  type Row =
    | { kind: "header"; label: string }
    | {
        kind: "action";
        label: string;
        value: AuthChoice;
        recommended?: boolean;
        hint?: string;
      };

  const rows: Row[] = [];
  if (hasAnySaved) {
    rows.push({ kind: "header", label: "Saved options" });
    if (hasSavedSecret) {
      rows.push({
        kind: "action",
        label: `Use saved Secrets Manager ARN`,
        value: "saved-secret",
        hint: savedCfg.tokenSecretArn,
      });
    }
    if (hasSavedLocal) {
      rows.push({
        kind: "action",
        label: `Use saved local token file`,
        value: "saved-local",
        hint: savedCfg.tokenLocalFile,
      });
    }
  }
  rows.push({
    kind: "header",
    label: "Use Secrets Manager  (function reads DASH0_TOKEN_SECRET_ARN at runtime)",
  });
  rows.push({
    kind: "action",
    label: "Paste token, save to AWS Secrets Manager",
    value: "new-paste-save-secret",
    recommended: true,
    hint: "Creates/rotates a secret. Sets DASH0_TOKEN_SECRET_ARN on the function. Function role needs secretsmanager:GetSecretValue.",
  });
  rows.push({
    kind: "action",
    label: "Use existing Secrets Manager ARN",
    value: "new-existing-arn",
    hint: "Paste an ARN you've already created. Sets DASH0_TOKEN_SECRET_ARN on the function.",
  });
  rows.push({
    kind: "header",
    label: "Use literal env var  (sets DASH0_TOKEN directly on the function)",
  });
  rows.push({
    kind: "action",
    label: "Paste token, save to local file (DASH0_TOKEN)",
    value: "new-paste-save-local",
    hint: "Saves to ./.dash0-lambda.token (chmod 0600, auto-gitignored) for next time. Sets DASH0_TOKEN on the Lambda.",
  });
  rows.push({
    kind: "action",
    label: "Paste token, don't save (DASH0_TOKEN, one-shot)",
    value: "new-paste-no-save",
    hint: "Re-enter on the next install. Sets DASH0_TOKEN on the Lambda; nothing persisted on your machine.",
  });

  const firstSelectable = rows.findIndex((r) => r.kind === "action");
  const [cursor, setCursor] = useState(firstSelectable);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => stepCursor(rows, c, -1));
    if (key.downArrow) setCursor((c) => stepCursor(rows, c, +1));
    if (key.return) {
      const r = rows[cursor];
      if (r?.kind === "action") onPick(r.value);
    }
  });

  const focused = rows[cursor];
  const hint = focused?.kind === "action" ? focused.hint : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>Step 2 of 4 — Authentication</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) =>
          r.kind === "header" ? (
            <Box key={i} marginTop={i === 0 ? 0 : 1}>
              <Text bold color="cyan">
                {r.label}
              </Text>
            </Box>
          ) : (
            <Box key={i} paddingLeft={2}>
              <Text
                color={i === cursor ? "cyan" : undefined}
                bold={i === cursor}
              >
                {i === cursor ? "❯ " : "  "}
                {r.label}
              </Text>
              {r.recommended && (
                <Text color="green" dimColor={i !== cursor}>
                  {"  ★ recommended"}
                </Text>
              )}
            </Box>
          ),
        )}
      </Box>
      {hint && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
    </Box>
  );
};

function stepCursor(
  rows: Array<{ kind: "header" } | { kind: "action" }>,
  from: number,
  direction: -1 | 1,
): number {
  const n = rows.length;
  if (n === 0) return 0;
  let i = from;
  for (let steps = 0; steps < n; steps++) {
    i = (i + direction + n) % n;
    if (rows[i]?.kind === "action") return i;
  }
  return from;
}

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
