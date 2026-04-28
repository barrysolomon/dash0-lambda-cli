/** Hook: live list of Lambda functions in a region, with refresh. */

import { useCallback, useEffect, useState } from "react";
import { LambdaWrapper, type FunctionSnapshot } from "../../lib/lambda.js";

export function useFunctionList(region: string): {
  functions: FunctionSnapshot[];
  loading: boolean;
  error?: string;
  rawError?: Error;
  refresh: () => void;
  lastRefreshAt?: number;
} {
  const [functions, setFunctions] = useState<FunctionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [rawError, setRawError] = useState<Error | undefined>();
  const [tick, setTick] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | undefined>();

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setRawError(undefined);
    const out: FunctionSnapshot[] = [];
    const lambda = new LambdaWrapper({ region, dryRun: true });
    (async () => {
      try {
        for await (const fn of lambda.listFunctions()) {
          if (cancelled) return;
          out.push(fn);
        }
        if (cancelled) return;
        out.sort((a, b) => a.functionName.localeCompare(b.functionName));
        setFunctions(out);
        setLastRefreshAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setRawError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [region, tick]);

  return { functions, loading, error, rawError, refresh, lastRefreshAt };
}
