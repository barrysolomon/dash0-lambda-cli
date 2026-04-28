/**
 * Run a function while capturing its `console.log` / `console.error` /
 * `console.warn` output line-by-line, so a TUI screen can display the
 * underlying command's text inside its own panel without the writes
 * leaking onto the live terminal.
 *
 * **Why console.* and not process.stdout.write**: Ink renders its frames
 * via `process.stdout.write` directly (cursor positioning, full clear+
 * redraw on every state change). If we intercepted stdout.write, we'd
 * also capture Ink's frame stream — those bytes (with ANSI escapes) end
 * up stored in our `logs` state and then re-rendered inside a Box, which
 * looks like the entire UI shrunk and stacked. Capturing console.* dodges
 * that because Ink's frame writes don't go through console.
 *
 * The function passed in still gets a "real" console.log experience
 * (return value true, no async hiccups) — we just capture the formatted
 * line into the supplied callback.
 */

export interface CaptureOptions {
  onLine: (line: string) => void;
  /** Maximum number of args to format per call. Default: unlimited. */
  maxArgs?: number;
}

export async function captureConsole<T>(
  opts: CaptureOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;

  const capture = (...args: unknown[]) => {
    const limited =
      opts.maxArgs === undefined ? args : args.slice(0, opts.maxArgs);
    const text = limited
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ");
    // Split on real newlines so multi-line writes show up as separate rows.
    for (const line of text.split("\n")) {
      if (line.length > 0) opts.onLine(line);
    }
  };

  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    console.info = origInfo;
  }
}

function safeStringify(v: unknown): string {
  try {
    if (v === null || v === undefined) return String(v);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  } catch {
    return "[unserializable]";
  }
}
