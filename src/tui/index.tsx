// dash0-lambda-cli · © 2026 Barry Solomon · Apache-2.0
/**
 * TUI entry point.
 *
 * Switches the terminal into the alternate screen buffer (the same mode
 * vim / less / htop / k9s use), renders the Ink app filling the full
 * terminal dimensions, and restores the original screen on exit so your
 * shell history isn't clobbered.
 *
 * Mouse-tracking is left alone — Ink doesn't need it, and enabling it
 * confuses some terminals' selection.
 */

import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { ValidationError } from "../lib/errors.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ValidationError(
      "the TUI requires an interactive TTY. " +
        "Use the flag-driven commands (e.g. `dash0-lambda install ...`) for scripts/CI.",
    );
  }

  // Move into the alt screen *before* render so Ink's first frame paints
  // on a clean canvas. We write hide-cursor too — Ink will manage the
  // visible cursor for text inputs as needed.
  process.stdout.write(ENTER_ALT_SCREEN + CLEAR_SCREEN + CURSOR_HOME + HIDE_CURSOR);

  const restore = () => {
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  };

  // Belt-and-suspenders: restore on every kind of exit signal so the
  // user's shell prompt comes back clean even on a hard SIGTERM.
  for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig as NodeJS.Signals & "exit", restore);
  }

  const region = process.env.AWS_REGION ?? "us-west-2";
  const region0 = region;
  const initialRegion = region0;

  const initialColumns = process.stdout.columns ?? 100;
  const initialRows = process.stdout.rows ?? 30;

  const { waitUntilExit } = render(<App initialRegion={initialRegion} />, {
    // Ink ≥3 supports `exitOnCtrlC` and `patchConsole`. We let Ink patch
    // console so writes from underlying commands are queued/redrawn cleanly.
    exitOnCtrlC: true,
    patchConsole: true,
  });

  try {
    await waitUntilExit();
  } finally {
    restore();
  }

  // Reference initial dims to silence noUncheckedIndexedAccess complaints
  // if anything ends up importing them from this module later.
  void initialColumns;
  void initialRows;
}
