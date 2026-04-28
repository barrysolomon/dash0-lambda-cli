import { describe, expect, it } from "vitest";
import { promptDash0Token, promptLine } from "../src/lib/prompt.js";

describe("promptLine", () => {
  it("throws ValidationError when there is no TTY", async () => {
    // Vitest runs without a TTY by default; assert the loud failure path
    // so CI never hangs waiting on input.
    await expect(promptLine("test")).rejects.toThrow(/no TTY available/);
  });

  it("promptDash0Token routes through the same TTY check", async () => {
    await expect(promptDash0Token()).rejects.toThrow(/no TTY available/);
  });
});
