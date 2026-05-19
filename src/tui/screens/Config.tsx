/**
 * Config screen — view, edit, and clear saved defaults in
 * .dash0-lambda.json. Sectioned hand-rolled list (same pattern as Home /
 * AuthError) so we can mix headers, value rows, and action rows.
 *
 * Token-storage fields (tokenSecretArn / tokenSecretKey / tokenLocalFile)
 * are mutually exclusive. Editing them as plain strings risks landing in
 * an ambiguous state, so they're behind a dedicated chooser that mirrors
 * the Install wizard's auth chooser. One model, one source of truth.
 *
 * Endpoint URLs are warned (not rejected) when the port isn't 4317/4318 —
 * OTLP HTTP/protobuf is :4318, gRPC is :4317; other ports usually mean a
 * local proxy or a typo. We let the user proceed either way.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  clearConfig,
  configPath,
  loadConfig,
  saveConfig,
  saveTokenLocally,
  type SavedConfig,
} from "../../lib/config.js";
import { defaultSecretName, saveTokenToSecret } from "../../lib/secrets.js";
import { SECRETS_DISABLED } from "../../lib/features.js";
import type { ScreenProps } from "../types.js";

type FieldKey =
  | "region"
  | "profile"
  | "endpoint"
  | "dataset"
  | "layerOwner"
  | "layerVersion";

interface FieldDef {
  key: FieldKey;
  label: string;
  /** Returns null if value is acceptable, error string otherwise. */
  validate?: (v: string) => string | null;
  /** Optional warning (yellow) — doesn't block save. */
  warn?: (v: string) => string | null;
  /** Coerce string from TextInput into the schema-correct type. */
  coerce?: (v: string) => unknown;
}

const FIELDS: FieldDef[] = [
  {
    key: "region",
    label: "region",
    validate: (v) =>
      /^[a-z]{2,}-[a-z]+-\d+$/.test(v.trim())
        ? null
        : "expecting an AWS region (e.g. us-west-2)",
  },
  {
    key: "profile",
    label: "profile",
  },
  {
    key: "endpoint",
    label: "endpoint",
    validate: (v) => {
      try {
        new URL(v.trim());
        return null;
      } catch {
        return "must be a valid URL (https://…:4318)";
      }
    },
    warn: (v) => {
      try {
        const u = new URL(v.trim());
        if (u.port && u.port !== "4317" && u.port !== "4318") {
          return `OTLP usually runs on :4318 (HTTP/protobuf) or :4317 (gRPC); you set ${u.port}.`;
        }
      } catch {
        // validate handles it.
      }
      return null;
    },
  },
  { key: "dataset", label: "dataset" },
  {
    key: "layerOwner",
    label: "layerOwner",
    validate: (v) =>
      /^\d{12}$/.test(v.trim())
        ? null
        : "must be a 12-digit AWS account ID",
  },
  {
    key: "layerVersion",
    label: "layerVersion",
    validate: (v) =>
      /^\d+$/.test(v.trim()) && parseInt(v.trim(), 10) > 0
        ? null
        : "must be a positive integer",
    coerce: (v) => parseInt(v.trim(), 10),
  },
];

type Mode =
  | { kind: "menu" }
  | { kind: "edit-field"; field: FieldDef }
  | { kind: "token-chooser" }
  | { kind: "token-paste"; target: "secret" | "local" }
  | { kind: "saving"; message: string }
  | { kind: "confirm-clear" };

type Row =
  | { kind: "header"; label: string }
  | { kind: "field"; field: FieldDef; value: string }
  | {
      kind: "action";
      label: string;
      hint?: string;
      onPick: () => void;
    };

export const ConfigScreen: React.FC<ScreenProps> = () => {
  const [cfg, setCfg] = useState<SavedConfig | undefined>();
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [statusMsg, setStatusMsg] = useState<
    { text: string; tone: "ok" | "warn" | "error" } | undefined
  >();

  const refresh = () => loadConfig().then(setCfg);
  useEffect(() => {
    void refresh();
  }, []);

  if (!cfg) {
    return (
      <Text>
        <Spinner type="dots" /> loading…
      </Text>
    );
  }

  // ── Mode dispatchers ──────────────────────────────────────────────
  if (mode.kind === "edit-field") {
    return (
      <FieldEditor
        field={mode.field}
        currentValue={String(cfg[mode.field.key] ?? "")}
        onCancel={() => setMode({ kind: "menu" })}
        onSave={async (rawValue) => {
          setMode({ kind: "saving", message: `Saving ${mode.field.label}…` });
          try {
            const trimmed = rawValue.trim();
            const value =
              trimmed === ""
                ? undefined
                : mode.field.coerce
                  ? mode.field.coerce(trimmed)
                  : trimmed;
            await saveConfig({ [mode.field.key]: value } as SavedConfig);
            await refresh();
            setStatusMsg({
              text: trimmed === ""
                ? `Cleared ${mode.field.label}.`
                : `Saved ${mode.field.label}.`,
              tone: "ok",
            });
            setMode({ kind: "menu" });
          } catch (err) {
            setStatusMsg({ text: (err as Error).message, tone: "error" });
            setMode({ kind: "menu" });
          }
        }}
      />
    );
  }

  if (mode.kind === "token-chooser") {
    return (
      <TokenChooser
        cfg={cfg}
        onCancel={() => setMode({ kind: "menu" })}
        onPickStorage={(target) => setMode({ kind: "token-paste", target })}
        onClear={async () => {
          setMode({ kind: "saving", message: "Clearing token storage…" });
          try {
            await saveConfig({
              tokenSecretArn: undefined,
              tokenSecretKey: undefined,
              tokenLocalFile: undefined,
            });
            await refresh();
            setStatusMsg({ text: "Cleared token storage.", tone: "ok" });
            setMode({ kind: "menu" });
          } catch (err) {
            setStatusMsg({ text: (err as Error).message, tone: "error" });
            setMode({ kind: "menu" });
          }
        }}
      />
    );
  }

  if (mode.kind === "token-paste") {
    const target = mode.target;
    return (
      <TokenPaste
        target={target}
        onCancel={() => setMode({ kind: "token-chooser" })}
        onSubmit={async (token) => {
          setMode({
            kind: "saving",
            message:
              target === "secret"
                ? "Saving token to AWS Secrets Manager…"
                : "Saving token to local file…",
          });
          try {
            if (target === "secret") {
              const region = cfg.region;
              if (!region) {
                throw new Error(
                  "set 'region' first — Secrets Manager calls need a region",
                );
              }
              const r = await saveTokenToSecret({
                region,
                name: defaultSecretName({ region }),
                token,
                shape: "string",
              });
              await saveConfig({
                tokenSecretArn: r.arn,
                tokenSecretKey: r.key,
                tokenLocalFile: undefined,
              });
              setStatusMsg({
                text: r.created
                  ? "Created Secrets Manager secret + saved ARN."
                  : "Rotated Secrets Manager secret + saved ARN.",
                tone: "ok",
              });
            } else {
              const { configRelativePath } = await saveTokenLocally(token);
              await saveConfig({
                tokenLocalFile: configRelativePath,
                tokenSecretArn: undefined,
                tokenSecretKey: undefined,
              });
              setStatusMsg({
                text: `Saved token to ${configRelativePath} (chmod 0600).`,
                tone: "ok",
              });
            }
            await refresh();
            setMode({ kind: "menu" });
          } catch (err) {
            setStatusMsg({ text: (err as Error).message, tone: "error" });
            setMode({ kind: "menu" });
          }
        }}
      />
    );
  }

  if (mode.kind === "saving") {
    return (
      <Text>
        <Spinner type="dots" /> {mode.message}
      </Text>
    );
  }

  if (mode.kind === "confirm-clear") {
    return (
      <ConfirmClear
        onConfirm={async () => {
          const removed = await clearConfig();
          await refresh();
          setStatusMsg({
            text: removed ? "Config cleared." : "No config existed.",
            tone: removed ? "ok" : "warn",
          });
          setMode({ kind: "menu" });
        }}
        onCancel={() => setMode({ kind: "menu" })}
      />
    );
  }

  // ── Menu mode ─────────────────────────────────────────────────────
  return (
    <ConfigMenu
      cfg={cfg}
      statusMsg={statusMsg}
      clearStatus={() => setStatusMsg(undefined)}
      onEditField={(field) => {
        setStatusMsg(undefined);
        setMode({ kind: "edit-field", field });
      }}
      onOpenTokenChooser={() => {
        setStatusMsg(undefined);
        setMode({ kind: "token-chooser" });
      }}
      onClearAll={() => {
        setStatusMsg(undefined);
        setMode({ kind: "confirm-clear" });
      }}
    />
  );
};

// ── Menu ──────────────────────────────────────────────────────────────

const ConfigMenu: React.FC<{
  cfg: SavedConfig;
  statusMsg?: { text: string; tone: "ok" | "warn" | "error" };
  clearStatus: () => void;
  onEditField: (field: FieldDef) => void;
  onOpenTokenChooser: () => void;
  onClearAll: () => void;
}> = ({ cfg, statusMsg, onEditField, onOpenTokenChooser, onClearAll }) => {
  const tokenSummary = describeTokenStorage(cfg);

  const rows: Row[] = [];
  rows.push({ kind: "header", label: "Defaults" });
  for (const f of FIELDS.slice(0, 4)) {
    rows.push({
      kind: "field",
      field: f,
      value: String(cfg[f.key] ?? ""),
    });
  }

  rows.push({ kind: "header", label: "Token storage  (mutually exclusive)" });
  rows.push({
    kind: "action",
    label: `Set / change token storage${tokenSummary ? "" : ""}`,
    hint: tokenSummary
      ? `Currently: ${tokenSummary}. Enter to change, choose Clear to unset.`
      : "Choose Secrets Manager, a local file, or paste an existing ARN.",
    onPick: onOpenTokenChooser,
  });

  rows.push({ kind: "header", label: "Advanced" });
  for (const f of FIELDS.slice(4)) {
    rows.push({ kind: "field", field: f, value: String(cfg[f.key] ?? "") });
  }

  rows.push({ kind: "header", label: "Maintenance" });
  rows.push({
    kind: "action",
    label: "Clear all saved config",
    hint: `Removes ${configPath()} entirely. Locally-stored token files (if any) are left in place.`,
    onPick: onClearAll,
  });

  const firstSelectable = rows.findIndex(
    (r) => r.kind === "field" || r.kind === "action",
  );
  const [cursor, setCursor] = useState(firstSelectable);

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => stepCursor(rows, c, -1));
    if (key.downArrow) setCursor((c) => stepCursor(rows, c, +1));
    if (key.return) {
      const r = rows[cursor];
      if (r?.kind === "field") onEditField(r.field);
      else if (r?.kind === "action") r.onPick();
    }
  });

  const focusedRow = rows[cursor];
  const hint =
    focusedRow?.kind === "action" ? focusedRow.hint : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>Saved config</Text>
      <Text dimColor>{configPath()}</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) => (
          <RowView key={i} row={r} highlighted={i === cursor} />
        ))}
      </Box>
      {hint && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>
          <Text bold>⏎</Text> edit · <Text bold>esc</Text> back
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

const RowView: React.FC<{ row: Row; highlighted: boolean }> = ({
  row,
  highlighted,
}) => {
  if (row.kind === "header") {
    return (
      <Box marginTop={1}>
        <Text bold color="cyan">
          {row.label}
        </Text>
      </Box>
    );
  }
  if (row.kind === "field") {
    return (
      <Box paddingLeft={2}>
        <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
          {highlighted ? "❯ " : "  "}
          {padR(row.field.label, 16)}
        </Text>
        {row.value === "" ? (
          <Text dimColor>(unset)</Text>
        ) : (
          <Text>{row.value}</Text>
        )}
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text color={highlighted ? "cyan" : undefined} bold={highlighted}>
        {highlighted ? "❯ " : "  "}
        {row.label}
      </Text>
    </Box>
  );
};

// ── Field editor ──────────────────────────────────────────────────────

const FieldEditor: React.FC<{
  field: FieldDef;
  currentValue: string;
  onSave: (v: string) => void | Promise<void>;
  onCancel: () => void;
}> = ({ field, currentValue, onSave, onCancel }) => {
  const [value, setValue] = useState(currentValue);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Edit {field.label}</Text>
      <Text dimColor>
        Leave blank to clear. <Text bold>esc</Text> to cancel.
      </Text>
      <Box marginTop={1}>
        <Text>{field.label}: </Text>
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            // Live-validate so users see issues as they type.
            const trimmed = v.trim();
            if (trimmed === "") {
              setError(null);
              setWarn(null);
              return;
            }
            const e = field.validate?.(trimmed) ?? null;
            setError(e);
            setWarn(e ? null : (field.warn?.(trimmed) ?? null));
          }}
          onSubmit={(v) => {
            const trimmed = v.trim();
            if (trimmed === "") return void onSave("");
            const e = field.validate?.(trimmed) ?? null;
            if (e) {
              setError(e);
              return;
            }
            void onSave(trimmed);
          }}
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">✘ {error}</Text>
        </Box>
      )}
      {!error && warn && (
        <Box marginTop={1}>
          <Text color="yellow">! {warn}</Text>
          <Text dimColor> (saved anyway)</Text>
        </Box>
      )}
    </Box>
  );
};

// ── Token chooser + paste ─────────────────────────────────────────────

const TokenChooser: React.FC<{
  cfg: SavedConfig;
  onCancel: () => void;
  onPickStorage: (target: "secret" | "local") => void;
  onClear: () => void;
}> = ({ cfg, onCancel, onPickStorage, onClear }) => {
  const summary = describeTokenStorage(cfg);
  type Choice = "secret" | "local" | "clear";
  const items: Array<{ label: string; hint: string; value: Choice }> = [];
  if (!SECRETS_DISABLED) {
    items.push({
      label: "Save token to AWS Secrets Manager",
      hint: "Creates or rotates a secret; saves the ARN here for future installs to reference.",
      value: "secret",
    });
  }
  items.push({
    label: "Save token to local file",
    hint: "Writes ./.dash0-lambda.token at chmod 0600 and auto-gitignores it. Token gets baked into DASH0_TOKEN env var on each install.",
    value: "local",
  });
  if (summary) {
    items.push({
      label: "Clear token storage",
      hint: "Forget the saved reference. The Install wizard will then ask each time.",
      value: "clear",
    });
  }
  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (key.return) {
      const v = items[cursor]!.value;
      if (v === "clear") onClear();
      else onPickStorage(v);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Token storage</Text>
      {summary && <Text dimColor>Currently: {summary}</Text>}
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
      {items[cursor] && (
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{items[cursor]!.hint}</Text>
        </Box>
      )}
    </Box>
  );
};

const TokenPaste: React.FC<{
  target: "secret" | "local";
  onSubmit: (token: string) => void | Promise<void>;
  onCancel: () => void;
}> = ({ target, onSubmit, onCancel }) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Paste Dash0 token
      </Text>
      <Text dimColor>
        {target === "secret"
          ? "Will be stored in AWS Secrets Manager."
          : "Will be saved locally at chmod 0600."}{" "}
        <Text bold>esc</Text> to cancel.
      </Text>
      <Box marginTop={1}>
        <Text>token: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          mask="*"
          onSubmit={(v) => {
            const t = v.trim();
            if (!/^auth_[A-Za-z0-9]{32,}$/.test(t)) {
              setError("expecting 'auth_' + 32+ chars");
              return;
            }
            void onSubmit(t);
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

// ── Confirm clear ─────────────────────────────────────────────────────

const ConfirmClear: React.FC<{
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ onConfirm, onCancel }) => {
  const items = [
    { label: "No — back", value: "no" },
    { label: "Yes — delete .dash0-lambda.json", value: "yes" },
  ];
  const [cursor, setCursor] = useState(0);
  useInput((_, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    if (key.return) {
      if (items[cursor]!.value === "yes") onConfirm();
      else onCancel();
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        ! Clear all saved config?
      </Text>
      <Text dimColor>
        Removes {configPath()}. Locally-stored token files (if any) are left
        in place — delete them by hand if you want them gone.
      </Text>
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

// ── Helpers ───────────────────────────────────────────────────────────

function describeTokenStorage(cfg: SavedConfig): string | undefined {
  if (cfg.tokenSecretArn) {
    const k = cfg.tokenSecretKey ? ` (json key: ${cfg.tokenSecretKey})` : "";
    return `Secrets Manager ${shorten(cfg.tokenSecretArn, 50)}${k}`;
  }
  if (cfg.tokenLocalFile) {
    return `local file ${cfg.tokenLocalFile}`;
  }
  return undefined;
}

function stepCursor(rows: Row[], from: number, direction: -1 | 1): number {
  const n = rows.length;
  if (n === 0) return 0;
  let i = from;
  for (let steps = 0; steps < n; steps++) {
    i = (i + direction + n) % n;
    const r = rows[i];
    if (r && (r.kind === "field" || r.kind === "action")) return i;
  }
  return from;
}

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function shorten(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}
