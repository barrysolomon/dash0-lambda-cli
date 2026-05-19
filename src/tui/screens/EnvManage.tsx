/**
 * Per-function Dash0 env manager.
 *
 * Lists the Dash0/OTel-relevant env vars on a single focused function,
 * lets the user edit values in place, and writes back to AWS only after
 * an explicit diff-confirm step. Storage-mode transitions (literal token
 * ↔ Secrets Manager) are out of scope here — those live in `Migrate`.
 *
 * Design notes:
 *   - The visible field list is fixed (KNOWN_FIELDS) so users see a
 *     consistent set even when keys are unset. Other env vars on the
 *     function are preserved on write but not editable from this screen.
 *   - DASH0_TOKEN is masked by default; press R to toggle reveal in both
 *     the read view and the editor.
 *   - We send AWS the *full* env map (other keys preserved) along with
 *     the snapshot's RevisionId so concurrent edits surface as
 *     ResourceConflictException rather than silently overwriting.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { LambdaWrapper, type FunctionSnapshot } from "../../lib/lambda.js";
import { resolveTargets } from "../lib/targets.js";
import { SECRETS_DISABLED } from "../../lib/features.js";
import type { ScreenProps } from "../types.js";

interface FieldDef {
  key: string;
  label: string;
  /** Sensitive — mask in display, mask=* in editor. */
  secret?: boolean;
  /**
   * Tied to AWS Secrets Manager support. When SECRETS_DISABLED is true,
   * fields marked here are filtered out of the editable list and only
   * surfaced read-only when already set on the function.
   */
  secretsRelated?: boolean;
  hint?: string;
  /** Optional validator; null means OK, string is the error message. */
  validate?: (v: string) => string | null;
}

const KNOWN_FIELDS: FieldDef[] = [
  {
    key: "DASH0_TOKEN",
    label: "DASH0_TOKEN",
    secret: true,
    hint: "Literal auth token. Mutually exclusive with DASH0_TOKEN_SECRET_ARN.",
    validate: (v) =>
      /^auth_[A-Za-z0-9]{32,}$/.test(v) ? null : "expecting 'auth_' + 32+ chars",
  },
  {
    key: "DASH0_TOKEN_SECRET_ARN",
    label: "DASH0_TOKEN_SECRET_ARN",
    secretsRelated: true,
    hint: "Full ARN of an AWS Secrets Manager secret holding the token.",
    validate: (v) =>
      /^arn:aws:secretsmanager:/.test(v)
        ? null
        : "must be an arn:aws:secretsmanager:… ARN",
  },
  {
    key: "DASH0_TOKEN_SECRET_KEY",
    label: "DASH0_TOKEN_SECRET_KEY",
    secretsRelated: true,
    hint: "JSON key inside the secret (omit if the secret value is the raw token).",
  },
  {
    key: "DASH0_ENDPOINT",
    label: "DASH0_ENDPOINT",
    hint: "https://ingress.<region>.aws.dash0.com:4318",
    validate: (v) => {
      try {
        new URL(v);
        return null;
      } catch {
        return "must be a valid URL";
      }
    },
  },
  {
    key: "DASH0_DATASET",
    label: "DASH0_DATASET",
    hint: "Optional. Routes telemetry to a named dataset in Dash0.",
  },
  {
    key: "OTEL_SERVICE_NAME",
    label: "OTEL_SERVICE_NAME",
    hint: "Logical service name shown in Dash0. Defaults to the function name.",
  },
  {
    key: "OTEL_RESOURCE_ATTRIBUTES",
    label: "OTEL_RESOURCE_ATTRIBUTES",
    hint: "Comma-separated key=value pairs (e.g. service.namespace=billing,deployment.environment=prod).",
  },
  {
    key: "OTEL_PROPAGATORS",
    label: "OTEL_PROPAGATORS",
    hint: "e.g. tracecontext,baggage,xray",
  },
  {
    key: "AWS_LAMBDA_EXEC_WRAPPER",
    label: "AWS_LAMBDA_EXEC_WRAPPER",
    hint: "Set to /opt/dash0_wrapper by the install flow. Don't change unless you know why.",
  },
];

const KNOWN_KEYS = new Set(KNOWN_FIELDS.map((f) => f.key));

/**
 * Subset of KNOWN_FIELDS the cursor can actually land on. When secrets
 * are disabled we hide the secret-related fields from editing — but the
 * full KNOWN_FIELDS list is still used for baseline / save bookkeeping
 * so that an already-set DASH0_TOKEN_SECRET_ARN is preserved on write
 * rather than silently dropped.
 */
const EDITABLE_FIELDS: FieldDef[] = SECRETS_DISABLED
  ? KNOWN_FIELDS.filter((f) => !f.secretsRelated)
  : KNOWN_FIELDS;

type Mode =
  | { kind: "loading" }
  | { kind: "menu" }
  | { kind: "edit"; field: FieldDef }
  | { kind: "confirm" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

interface State {
  /** The snapshot we read from AWS — used for revisionId + non-Dash0 vars. */
  snapshot?: FunctionSnapshot;
  /** Working copy of just the known fields (key → value, "" = unset). */
  draft: Record<string, string>;
  /** Original baseline so we can compute the diff. */
  baseline: Record<string, string>;
}

export const EnvManage: React.FC<ScreenProps> = ({ state, setState }) => {
  const fnName = resolveTargets(state).names[0];
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [s, setS] = useState<State>({ draft: {}, baseline: {} });
  const [statusMsg, setStatusMsg] = useState<
    { text: string; tone: "ok" | "warn" | "error" } | undefined
  >();
  const [reveal, setReveal] = useState(false);
  const [cursor, setCursor] = useState(0);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    if (!fnName) {
      setMode({ kind: "error", message: "No function focused." });
      return;
    }
    (async () => {
      try {
        const lambda = new LambdaWrapper({ region: state.region, dryRun: true });
        const snap = await lambda.getFunction(fnName);
        if (cancelled) return;
        const baseline: Record<string, string> = {};
        for (const f of KNOWN_FIELDS) baseline[f.key] = snap.env[f.key] ?? "";
        setS({ snapshot: snap, draft: { ...baseline }, baseline });
        setMode({ kind: "menu" });
      } catch (err) {
        if (!cancelled)
          setMode({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fnName, state.region]);

  // Menu-mode hotkeys.
  useInput((input, key) => {
    if (mode.kind !== "menu") return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow)
      setCursor((c) => Math.min(EDITABLE_FIELDS.length - 1, c + 1));
    if (input === "r" || input === "R") setReveal((v) => !v);
    if (key.return) {
      const f = EDITABLE_FIELDS[cursor]!;
      setMode({ kind: "edit", field: f });
    }
    if (input === "c" || input === "C" || input === "d" || input === "D") {
      // Stage a deletion of the value at cursor. If the key was set on AWS
      // this will remove it from the function's env map on save; if it was
      // already unset, this is a no-op. `d` and `c` both bind here — `d`
      // reads as "delete" for users who already typed a value and want it
      // gone, `c` reads as "clear" for users editing a draft.
      const f = EDITABLE_FIELDS[cursor]!;
      const wasSet = (s.baseline[f.key] ?? "") !== "";
      setS((prev) => ({ ...prev, draft: { ...prev.draft, [f.key]: "" } }));
      setStatusMsg({
        text: wasSet
          ? `Marked ${f.key} for deletion on save.`
          : `${f.key} is already unset.`,
        tone: wasSet ? "ok" : "warn",
      });
    }
    if (input === "x" || input === "X") {
      // Revert all edits.
      setS((prev) => ({ ...prev, draft: { ...prev.baseline } }));
      setStatusMsg({ text: "Reverted unsaved edits.", tone: "ok" });
    }
    if (input === "s" || input === "S") {
      const changes = computeDiff(s.baseline, s.draft);
      if (changes.length === 0) {
        setStatusMsg({ text: "Nothing to save.", tone: "warn" });
        return;
      }
      // Token-storage exclusivity check — refuse to save when both
      // DASH0_TOKEN and DASH0_TOKEN_SECRET_ARN end up set.
      if (s.draft.DASH0_TOKEN && s.draft.DASH0_TOKEN_SECRET_ARN) {
        setStatusMsg({
          text: "DASH0_TOKEN and DASH0_TOKEN_SECRET_ARN are mutually exclusive — clear one.",
          tone: "error",
        });
        return;
      }
      setMode({ kind: "confirm" });
    }
  });

  if (!fnName) {
    return (
      <Text dimColor>
        No function focused. Pick one on the Functions screen first (highlight a
        row, press 'e').
      </Text>
    );
  }

  if (mode.kind === "loading") {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Reading env for {fnName}…</Text>
      </Box>
    );
  }

  if (mode.kind === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">✘ {mode.message}</Text>
        <Text dimColor>Press esc to go back.</Text>
      </Box>
    );
  }

  if (mode.kind === "edit") {
    const f = mode.field;
    return (
      <FieldEditor
        field={f}
        currentValue={s.draft[f.key] ?? ""}
        reveal={reveal}
        onReveal={() => setReveal((v) => !v)}
        onCancel={() => setMode({ kind: "menu" })}
        onSubmit={(v) => {
          const wasSet = (s.baseline[f.key] ?? "") !== "";
          setS((prev) => ({ ...prev, draft: { ...prev.draft, [f.key]: v } }));
          setStatusMsg({
            text:
              v === ""
                ? wasSet
                  ? `Marked ${f.key} for deletion on save.`
                  : `${f.key} is unset (no change).`
                : `Updated ${f.key} (not yet saved).`,
            tone: "ok",
          });
          setMode({ kind: "menu" });
        }}
      />
    );
  }

  if (mode.kind === "confirm") {
    const changes = computeDiff(s.baseline, s.draft);
    return (
      <ConfirmDiff
        functionName={fnName}
        changes={changes}
        reveal={reveal}
        onCancel={() => setMode({ kind: "menu" })}
        onConfirm={async () => {
          setMode({ kind: "saving" });
          try {
            // Build the full env map: start with everything on the function
            // (including non-Dash0 keys we don't manage) and overlay the
            // draft. Empty strings in the draft mean "remove this key".
            const fullEnv: Record<string, string> = {
              ...(s.snapshot?.env ?? {}),
            };
            for (const f of KNOWN_FIELDS) {
              const v = s.draft[f.key] ?? "";
              if (v === "") delete fullEnv[f.key];
              else fullEnv[f.key] = v;
            }
            const lambda = new LambdaWrapper({ region: state.region });
            await lambda.updateEnvOnly({
              name: fnName,
              env: fullEnv,
              revisionId: s.snapshot?.revisionId,
            });
            // Re-fetch so baseline + revisionId update for any further edits.
            const fresh = await new LambdaWrapper({
              region: state.region,
              dryRun: true,
            }).getFunction(fnName);
            const baseline: Record<string, string> = {};
            for (const f of KNOWN_FIELDS) baseline[f.key] = fresh.env[f.key] ?? "";
            setS({ snapshot: fresh, draft: { ...baseline }, baseline });
            const deletes = changes.filter((c) => c.op === "delete").length;
            const others = changes.length - deletes;
            const summary = [
              others > 0 ? `${others} change(s)` : null,
              deletes > 0 ? `${deletes} deletion(s)` : null,
            ]
              .filter(Boolean)
              .join(", ");
            setStatusMsg({
              text: `Saved ${summary} to ${fnName}.`,
              tone: "ok",
            });
            // Push the refreshed snapshot back into App state so other
            // screens see the new env immediately.
            setState((p) => ({ ...p, focused: fresh }));
            setMode({ kind: "menu" });
          } catch (err) {
            const e = err as Error & { name?: string };
            const detail =
              e.name === "ResourceConflictException" ||
              /RevisionId|preconditionfailed/i.test(e.message)
                ? "another deploy raced this update — press esc and reopen to refetch."
                : e.message;
            setStatusMsg({
              text: `Save failed: ${detail}`,
              tone: "error",
            });
            setMode({ kind: "menu" });
          }
        }}
      />
    );
  }

  if (mode.kind === "saving") {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Updating env for {fnName}…</Text>
      </Box>
    );
  }

  // Menu mode.
  const dirty = computeDiff(s.baseline, s.draft);
  return (
    <Box flexDirection="column">
      <Text bold>Dash0 env — {fnName}</Text>
      <Text dimColor>
        Edit or delete Dash0/OTel env vars in place. Non-Dash0 env vars on
        this function are preserved.
      </Text>

      <Box marginTop={1} flexDirection="column">
        {EDITABLE_FIELDS.map((f, i) => {
          const value = s.draft[f.key] ?? "";
          const baseline = s.baseline[f.key] ?? "";
          const changed = value !== baseline;
          const highlighted = i === cursor;
          return (
            <FieldRow
              key={f.key}
              field={f}
              value={value}
              baseline={baseline}
              changed={changed}
              highlighted={highlighted}
              reveal={reveal}
            />
          );
        })}
      </Box>

      {EDITABLE_FIELDS[cursor]?.hint && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{EDITABLE_FIELDS[cursor]!.hint}</Text>
        </Box>
      )}

      {/*
        Read-only audit panel. When SECRETS_DISABLED is true and the
        function is currently wired to Secrets Manager, surface those
        values here so users can see what's deployed without giving them
        an editor for it. Use the migrate flow / CLI to change them.
      */}
      {SECRETS_DISABLED &&
        KNOWN_FIELDS.some(
          (f) => f.secretsRelated && (s.baseline[f.key] ?? "") !== "",
        ) && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              Secrets Manager fields (read-only — feature disabled):
            </Text>
            {KNOWN_FIELDS.filter(
              (f) => f.secretsRelated && (s.baseline[f.key] ?? "") !== "",
            ).map((f) => (
              <Box key={f.key} paddingLeft={2}>
                <Box width={28} flexShrink={0} marginRight={1}>
                  <Text dimColor>{f.label}</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {s.baseline[f.key]}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

      <Box marginTop={1} paddingX={1}>
        <Text dimColor>
          <Text bold>⏎</Text> edit · <Text bold>d</Text>/<Text bold>c</Text>{" "}
          delete at cursor · <Text bold>x</Text> revert all ·{" "}
          <Text bold>R</Text> reveal · <Text bold>s</Text> save{" "}
          {dirty.length > 0 ? (
            <Text color="yellow">({dirty.length} unsaved)</Text>
          ) : (
            <Text dimColor>(no changes)</Text>
          )}
        </Text>
      </Box>

      {statusMsg && (
        <Box marginTop={1} paddingX={1}>
          <Text
            color={
              statusMsg.tone === "ok"
                ? "green"
                : statusMsg.tone === "warn"
                  ? "yellow"
                  : "red"
            }
          >
            {statusMsg.tone === "ok"
              ? "✔ "
              : statusMsg.tone === "warn"
                ? "! "
                : "✘ "}
            {statusMsg.text}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ── Subcomponents ────────────────────────────────────────────────────────

const FieldRow: React.FC<{
  field: FieldDef;
  value: string;
  baseline: string;
  changed: boolean;
  highlighted: boolean;
  reveal: boolean;
}> = ({ field, value, baseline, changed, highlighted, reveal }) => {
  const display =
    value === ""
      ? ""
      : field.secret && !reveal
        ? redact(value)
        : value;
  // Distinguish a pending deletion (was set → now empty) from a pending
  // update / add. Deletions render with a red `−`; other changes use a
  // yellow `•`.
  const willDelete = changed && value === "" && baseline !== "";
  const marker = willDelete ? "−" : changed ? "•" : " ";
  const markerColor = willDelete ? "red" : changed ? "yellow" : undefined;
  return (
    <Box paddingLeft={2}>
      <Box width={2} flexShrink={0}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {highlighted ? "❯" : " "}
        </Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color={markerColor} bold={changed}>
          {marker}
        </Text>
      </Box>
      <Box width={28} flexShrink={0} marginRight={1}>
        <Text
          color={highlighted ? "cyan" : undefined}
          bold={highlighted}
          wrap="truncate-end"
        >
          {field.label}
        </Text>
      </Box>
      <Box flexShrink={1}>
        {display === "" ? (
          willDelete ? (
            <Text color="red">(will delete on save)</Text>
          ) : (
            <Text dimColor>(unset)</Text>
          )
        ) : (
          <Text wrap="truncate-end">{display}</Text>
        )}
      </Box>
    </Box>
  );
};

const FieldEditor: React.FC<{
  field: FieldDef;
  currentValue: string;
  reveal: boolean;
  onReveal: () => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}> = ({ field, currentValue, reveal, onReveal, onSubmit, onCancel }) => {
  const [value, setValue] = useState(currentValue);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) onCancel();
    // Allow R to toggle reveal even mid-edit, but only when the editor
    // owns the input. ink-text-input swallows printable chars, so we
    // gate on Ctrl-R instead to avoid shadowing typed text.
    if (key.ctrl && (input === "r" || input === "R")) onReveal();
  });

  const masked = field.secret && !reveal;

  return (
    <Box flexDirection="column">
      <Text bold>Edit {field.label}</Text>
      <Text dimColor>
        Leave blank to delete the env var on save.{" "}
        <Text bold>esc</Text> to cancel.
        {field.secret ? (
          <>
            {" "}<Text bold>Ctrl-R</Text> reveal/hide.
          </>
        ) : null}
      </Text>
      {field.hint && (
        <Box marginTop={1}>
          <Text dimColor>{field.hint}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>{field.label}: </Text>
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            const trimmed = v.trim();
            if (trimmed === "") {
              setError(null);
              return;
            }
            setError(field.validate?.(trimmed) ?? null);
          }}
          {...(masked ? { mask: "*" } : {})}
          onSubmit={(v) => {
            const trimmed = v.trim();
            if (trimmed === "") return onSubmit("");
            const e = field.validate?.(trimmed) ?? null;
            if (e) {
              setError(e);
              return;
            }
            onSubmit(trimmed);
          }}
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">✘ {error}</Text>
        </Box>
      )}
    </Box>
  );
};

interface DiffEntry {
  key: string;
  before: string;
  after: string;
  secret: boolean;
  /**
   * "set"    — was unset, now has a value (AWS sees a new key)
   * "update" — was set, value changed (AWS overwrites)
   * "delete" — was set, now empty (AWS sees the key removed)
   */
  op: "set" | "update" | "delete";
}

const ConfirmDiff: React.FC<{
  functionName: string;
  changes: DiffEntry[];
  reveal: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ functionName, changes, reveal, onConfirm, onCancel }) => {
  const [cursor, setCursor] = useState(0);
  const items = [
    { label: "No — back to editing", value: "no" as const },
    { label: "Yes — apply changes", value: "yes" as const },
  ];
  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (input === "r" || input === "R") {
      // Toggle handled by parent; but we render in real time so a re-render
      // is enough. We don't have a setter here — surfacing reveal toggle on
      // the confirm screen would require lifting state, which isn't worth
      // it. Users can press esc, toggle, re-enter.
    }
    if (key.return) {
      if (items[cursor]!.value === "yes") onConfirm();
      else onCancel();
    }
  });

  const deletes = changes.filter((c) => c.op === "delete").length;
  const others = changes.length - deletes;
  const summary =
    deletes > 0 && others === 0
      ? `Delete ${deletes} env var(s) from ${functionName}?`
      : deletes > 0
        ? `Apply ${others} change(s) and delete ${deletes} env var(s) on ${functionName}?`
        : `Apply ${changes.length} env change(s) to ${functionName}?`;
  return (
    <Box flexDirection="column">
      <Text bold>{summary}</Text>
      <Text dimColor>
        Sends UpdateFunctionConfiguration with the function's RevisionId — a
        concurrent deploy will fail this call, not silently overwrite.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {changes.map((c) => (
          <DiffRow key={c.key} change={c} reveal={reveal} />
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {items.map((it, i) => (
          <Box key={it.value} paddingLeft={2}>
            <Text color={i === cursor ? "cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}
              {it.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const DiffRow: React.FC<{ change: DiffEntry; reveal: boolean }> = ({
  change,
  reveal,
}) => {
  const renderVal = (v: string) => {
    if (v === "") return <Text dimColor>(unset)</Text>;
    const display = change.secret && !reveal ? redact(v) : v;
    return <Text>{display}</Text>;
  };
  const opLabel =
    change.op === "delete"
      ? { text: "DELETE", color: "red" as const }
      : change.op === "set"
        ? { text: "ADD", color: "green" as const }
        : { text: "UPDATE", color: "yellow" as const };
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={opLabel.color}>
          [{opLabel.text}]
        </Text>
        <Text>{" "}</Text>
        <Text bold color="cyan">
          {change.key}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="red">- </Text>
        {renderVal(change.before)}
      </Box>
      {change.op !== "delete" && (
        <Box paddingLeft={2}>
          <Text color="green">+ </Text>
          {renderVal(change.after)}
        </Box>
      )}
    </Box>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────────

function computeDiff(
  baseline: Record<string, string>,
  draft: Record<string, string>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  // Iterate the editable subset — when secrets are disabled, secret-
  // related fields aren't even rendered, so they should never appear
  // in a diff. (Their baseline values are still preserved on save via
  // the full-env passthrough in the save handler.)
  for (const f of EDITABLE_FIELDS) {
    const before = baseline[f.key] ?? "";
    const after = draft[f.key] ?? "";
    if (before === after) continue;
    const op: DiffEntry["op"] =
      before === "" ? "set" : after === "" ? "delete" : "update";
    out.push({
      key: f.key,
      before,
      after,
      secret: f.secret ?? false,
      op,
    });
  }
  return out;
}

function redact(tok: string): string {
  if (tok.length <= 12) return "***";
  return `${tok.slice(0, 8)}…${tok.slice(-4)}`;
}

// Re-export KNOWN_KEYS for tests / future use; suppresses unused warnings
// without affecting the bundle.
export { KNOWN_KEYS };
