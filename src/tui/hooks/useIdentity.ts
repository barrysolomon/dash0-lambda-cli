/**
 * Hook: probe sts:GetCallerIdentity once on mount and on region change.
 *
 * Crucially we DO NOT swallow the SDK error here — App.tsx uses the
 * original Error (with its real name + message) to decide whether to
 * auto-route to the auth-error screen. probeIdentity() in menu/banner.ts
 * is a soft "best-effort" probe that masks errors; this hook needs the
 * real one.
 */

import { useEffect, useState } from "react";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import type { AwsIdentity } from "../../menu/banner.js";

export interface IdentityHookResult {
  identity: AwsIdentity | undefined;
  loading: boolean;
  /** The raw Error (with .name/.$metadata) when the probe failed. */
  rawError?: Error;
  reload: () => void;
}

export function useIdentity(region: string): IdentityHookResult {
  const [identity, setIdentity] = useState<AwsIdentity | undefined>();
  const [loading, setLoading] = useState(true);
  const [rawError, setRawError] = useState<Error | undefined>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRawError(undefined);
    const sts = new STSClient({ region, maxAttempts: 1 });
    sts
      .send(new GetCallerIdentityCommand({}))
      .then((out) => {
        if (cancelled) return;
        setIdentity({
          account: out.Account,
          arn: out.Arn,
          userId: out.UserId,
          region,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setIdentity({ region });
        setRawError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [region, tick]);

  return { identity, loading, rawError, reload: () => setTick((t) => t + 1) };
}
