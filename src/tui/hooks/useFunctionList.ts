/** Hook: live list of Lambda functions in a region, with refresh. */

import { useCallback, useEffect, useState } from "react";
import { LambdaWrapper, type FunctionSnapshot } from "../../lib/lambda.js";

/**
 * Maximum simultaneous in-flight `ListTags` calls. Each list page yields
 * up to 50 functions; firing all of them at once on accounts with
 * thousands of Lambdas reliably hits control-plane throttling. Ten is
 * comfortably below where we've seen `TooManyRequestsException` in the
 * wild.
 */
const TAG_CONCURRENCY = 10;

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
    const lambda = new LambdaWrapper({ region, dryRun: true });
    (async () => {
      const out: FunctionSnapshot[] = [];
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
        return;
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Tag enrichment runs after the initial paint — grouping needs
      // it but the list shouldn't be held back for it. We patch each
      // snapshot in place once tags arrive; a tag fetch failure on one
      // function doesn't take down the rest.
      const queue = out.slice();
      const worker = async () => {
        while (!cancelled) {
          const fn = queue.shift();
          if (!fn) return;
          try {
            const tags = await lambda.listTags(fn.functionArn);
            if (cancelled) return;
            setFunctions((prev) => {
              const idx = prev.findIndex(
                (p) => p.functionArn === fn.functionArn,
              );
              if (idx === -1) return prev;
              const next = prev.slice();
              next[idx] = { ...next[idx]!, tags };
              return next;
            });
          } catch {
            if (cancelled) return;
            // Mark as fetched-but-empty so we don't keep retrying and
            // the UI doesn't stay in "tags unknown" forever.
            setFunctions((prev) => {
              const idx = prev.findIndex(
                (p) => p.functionArn === fn.functionArn,
              );
              if (idx === -1) return prev;
              const next = prev.slice();
              next[idx] = { ...next[idx]!, tags: {} };
              return next;
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: TAG_CONCURRENCY }, () => worker()),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [region, tick]);

  return { functions, loading, error, rawError, refresh, lastRefreshAt };
}
