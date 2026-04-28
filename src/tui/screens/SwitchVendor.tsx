/**
 * Vendor toggle screen — flip the highlighted/selected functions between
 * Dash0 and Lumigo by changing AWS_LAMBDA_EXEC_WRAPPER.
 *
 * Per-function plan: detect current vendor, propose the opposite as the
 * target. If the targets disagree (some on Dash0, some on Lumigo), pick
 * the one to converge on explicitly.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { LambdaWrapper, type FunctionSnapshot } from "../../lib/lambda.js";
import {
  buildSwitchPlan,
  inspectVendor,
  type ActiveVendor,
  type Vendor,
} from "../../lib/vendor.js";
import { switchVendor } from "../../commands/switchVendor.js";
import { resolveTargets, summarizeTargets } from "../lib/targets.js";
import { captureConsole } from "../lib/captureConsole.js";
import type { ScreenProps } from "../types.js";

type Stage = "loading" | "choose-target" | "review" | "applying" | "done" | "error";

interface FnInfo {
  name: string;
  active: ActiveVendor;
  hasDash0: boolean;
  hasLumigo: boolean;
  runtime: string;
}

export const SwitchVendor: React.FC<ScreenProps> = ({ state }) => {
  const targets = resolveTargets(state).names;
  const [stage, setStage] = useState<Stage>("loading");
  const [info, setInfo] = useState<FnInfo[]>([]);
  const [target, setTarget] = useState<Vendor>("dash0");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  // Load each target's current vendor state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lambda = new LambdaWrapper({ region: state.region, dryRun: true });
      const out: FnInfo[] = [];
      for (const name of targets) {
        if (cancelled) return;
        try {
          const fn = await lambda.getFunction(name);
          const v = inspectVendor(fn);
          out.push({
            name,
            active: v.active,
            hasDash0: v.hasDash0Layer,
            hasLumigo: v.hasLumigoLayer,
            runtime: fn.runtime,
          });
        } catch (e) {
          out.push({
            name,
            active: "none",
            hasDash0: false,
            hasLumigo: false,
            runtime: "?",
          });
        }
      }
      if (cancelled) return;
      setInfo(out);
      // Default suggestion: if everything is on Dash0 → suggest Lumigo, else
      // default to Dash0.
      const allDash0 = out.every((i) => i.active === "dash0");
      setTarget(allDash0 ? "lumigo" : "dash0");
      setStage("choose-target");
    })();
    return () => {
      cancelled = true;
    };
  }, [targets.join("|")]);

  if (targets.length === 0) {
    return (
      <Text dimColor>
        No function focused or selected. Open Functions, highlight a row (or
        ␣ select multiple), then press 's' to come here.
      </Text>
    );
  }

  if (stage === "loading")
    return (
      <Text>
        <Spinner type="dots" /> reading current vendor state for {targets.length} function(s)…
      </Text>
    );

  // Build plans against the chosen target.
  const plans = info.map((i) => {
    const p =
      i.hasDash0 && i.hasLumigo
        ? null
        : "missing layer for chosen target";
    return { info: i, p };
  });

  if (stage === "choose-target")
    return (
      <Box flexDirection="column">
        <Text bold>Switch vendor — wrapper toggle (no layer changes)</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Targets ({targets.length}):</Text>
          {info.slice(0, 8).map((i) => (
            <Text key={i.name}>
              {"  "}
              <Text bold>{padR(i.name, 36)}</Text>{" "}
              <Text dimColor>{padR(i.runtime, 14)}</Text>
              <Text>
                {tag("dash0", i.hasDash0)} {tag("lumigo", i.hasLumigo)}
              </Text>
              {"  active: "}
              <ActiveBadge active={i.active} />
            </Text>
          ))}
          {info.length > 8 && <Text dimColor>  …and {info.length - 8} more</Text>}
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              {
                key: "dash0",
                label: "Switch to Dash0  (AWS_LAMBDA_EXEC_WRAPPER=/opt/wrapper, LUMIGO_SWITCH_OFF=true if Lumigo present)",
                value: "dash0",
              },
              {
                key: "lumigo",
                label: "Switch to Lumigo  (Java: /opt/lumigo_wrapper · Node/Python: unset wrapper, clear LUMIGO_SWITCH_OFF)",
                value: "lumigo",
              },
            ]}
            initialIndex={target === "dash0" ? 0 : 1}
            onSelect={(item) => {
              setTarget(item.value as Vendor);
              setStage("review");
            }}
          />
        </Box>
      </Box>
    );

  if (stage === "review") {
    return (
      <Review
        info={info}
        target={target}
        region={state.region}
        onCancel={() => setStage("choose-target")}
        onConfirm={async () => {
          setStage("applying");
          try {
            await captureConsole(
              { onLine: (l) => setLogs((p) => [...p, l].slice(-40)) },
              async () => {
                for (const fn of info) {
                  await switchVendor({
                    function: fn.name,
                    region: state.region,
                    target,
                  });
                }
              },
            );
            setStage("done");
          } catch (e) {
            setError((e as Error).message);
            setStage("error");
          }
        }}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>
        {stage === "applying" ? (
          <>
            <Spinner type="dots" /> Switching {info.length} function(s) → {target}…
          </>
        ) : stage === "done" ? (
          <Text color="green">✔ Done — switched to {target}</Text>
        ) : (
          <Text color="red">✘ {error}</Text>
        )}
      </Text>
      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
      >
        {logs.length === 0 ? (
          <Text dimColor>(no output yet)</Text>
        ) : (
          logs.map((l, i) => <Text key={i}>{l}</Text>)
        )}
      </Box>
    </Box>
  );
};

const Review: React.FC<{
  info: FnInfo[];
  target: Vendor;
  region: string;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ info, target, region, onCancel, onConfirm }) => {
  // Pre-compute summary by fetching each plan's blocker/changes counts.
  const [details, setDetails] = useState<
    Array<{ name: string; blocker?: string; numChanges: number; warnings: string[] }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lambda = new LambdaWrapper({ region, dryRun: true });
      const out: typeof details = [];
      for (const i of info) {
        if (cancelled) return;
        try {
          const fn = await lambda.getFunction(i.name);
          const plan = buildSwitchPlan(fn, target);
          out.push({
            name: i.name,
            blocker: plan.blocker,
            numChanges: plan.envChanges.length,
            warnings: plan.warnings,
          });
        } catch (e) {
          out.push({
            name: i.name,
            blocker: (e as Error).message,
            numChanges: 0,
            warnings: [],
          });
        }
      }
      if (!cancelled) setDetails(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [info.map((i) => i.name).join("|"), target, region]);

  const blockedCount = details.filter((d) => d.blocker).length;
  const noopCount = details.filter((d) => !d.blocker && d.numChanges === 0).length;
  const willChange = details.filter((d) => !d.blocker && d.numChanges > 0).length;

  return (
    <Box flexDirection="column">
      <Text bold>Review — switch to {target}</Text>
      <Box marginTop={1} flexDirection="column">
        {details.length === 0 ? (
          <Text>
            <Spinner type="dots" /> computing per-function plans…
          </Text>
        ) : (
          <>
            <Text>
              <Text color="green">{willChange}</Text> will change ·{" "}
              <Text dimColor>{noopCount} already on target</Text> ·{" "}
              <Text color="red">{blockedCount} blocked (missing layer)</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              {details.slice(0, 10).map((d) => (
                <Box key={d.name}>
                  <Text>
                    {"  "}
                    {d.blocker ? (
                      <Text color="red">✘</Text>
                    ) : d.numChanges === 0 ? (
                      <Text dimColor>·</Text>
                    ) : (
                      <Text color="green">✓</Text>
                    )}{" "}
                    {padR(d.name, 36)}
                  </Text>
                  <Text>
                    {d.blocker ? (
                      <Text dimColor>{d.blocker}</Text>
                    ) : d.numChanges === 0 ? (
                      <Text dimColor>(no-op)</Text>
                    ) : (
                      <Text>{d.numChanges} env change(s)</Text>
                    )}
                  </Text>
                </Box>
              ))}
              {details.length > 10 && (
                <Text dimColor>  …and {details.length - 10} more</Text>
              )}
            </Box>
            <Box marginTop={1}>
              <SelectInput
                items={[
                  {
                    key: "yes",
                    label: `Apply (skips ${blockedCount + noopCount} of ${details.length})`,
                    value: "yes",
                  },
                  { key: "no", label: "Cancel — back to target picker", value: "no" },
                ]}
                onSelect={(i) => (i.value === "yes" ? onConfirm() : onCancel())}
              />
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
};

const ActiveBadge: React.FC<{ active: ActiveVendor }> = ({ active }) => {
  if (active === "dash0") return <Text color="green">Dash0</Text>;
  if (active === "lumigo") return <Text color="yellow">Lumigo</Text>;
  if (active === "ambiguous") return <Text color="red">ambiguous</Text>;
  return <Text dimColor>none</Text>;
};

function tag(label: string, present: boolean): string {
  return present ? `[${label}]` : `[${" ".repeat(label.length)}]`;
}
function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}

export type { Vendor };
