/**
 * Tiny TTY prompt helpers. We avoid pulling in inquirer/prompts to keep the
 * dependency footprint small — the CLI is a single-purpose tool.
 */

import { createInterface } from "node:readline";
import { ValidationError } from "./errors.js";

export interface PromptOptions {
  /** When set, validates the input. Return null to accept; string to reject with that message. */
  validate?: (value: string) => string | null;
  /** Hide keystrokes (for tokens, passwords). */
  secret?: boolean;
  /** Allow up to N retries on validation failure. Defaults to 3. */
  retries?: number;
}

/**
 * Read a line from the user, optionally masking input. Throws ValidationError
 * if there's no TTY (so non-interactive sessions fail loudly instead of hanging).
 */
export async function promptLine(
  label: string,
  opts: PromptOptions = {},
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ValidationError(
      `${label}: no TTY available. Pass the value via flag or environment variable instead.`,
    );
  }
  const retries = opts.retries ?? 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    const value = await readOne(label, !!opts.secret);
    const trimmed = value.trim();
    if (opts.validate) {
      const err = opts.validate(trimmed);
      if (err) {
        process.stderr.write(`  ${err}\n`);
        continue;
      }
    }
    return trimmed;
  }
  throw new ValidationError(
    `${label}: too many invalid attempts; aborting.`,
  );
}

function readOne(label: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (secret) {
      // Mute stdout writes between question and answer so keystrokes don't echo.
      // Adapted from the standard "hide readline input" pattern.
      // We still print "*" per character so users see something happening.
      const out = process.stdout as unknown as {
        write: (chunk: string, ...rest: unknown[]) => boolean;
      };
      const originalWrite = out.write.bind(out);
      let promptShown = false;
      out.write = ((chunk: string, ...rest: unknown[]) => {
        if (!promptShown) {
          promptShown = true;
          return originalWrite(chunk, ...rest);
        }
        // Echo "*" once per actual character typed, swallow everything else
        // (readline writes the typed character itself).
        if (typeof chunk === "string" && chunk.length === 1 && chunk !== "\r" && chunk !== "\n") {
          return originalWrite("*", ...rest);
        }
        if (chunk === "\n" || chunk === "\r\n") {
          return originalWrite(chunk, ...rest);
        }
        return true;
      }) as typeof out.write;

      rl.question(`${label}: `, (answer: string) => {
        out.write = originalWrite;
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(`${label}: `, (answer: string) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/** Domain-specific helper: prompt for a Dash0 auth token. */
export async function promptDash0Token(): Promise<string> {
  return promptLine("Dash0 token", {
    secret: true,
    validate: (v) => {
      if (!v) return "token is required";
      if (!/^auth_[A-Za-z0-9]{32,}$/.test(v))
        return "token must look like 'auth_' + 32+ alphanumeric chars";
      return null;
    },
  });
}
