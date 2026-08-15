/**
 * Tests for the error hierarchy.
 *
 * Exit codes are this CLI's machine-readable contract — a CI pipeline that
 * runs `validate` branches on them. The load-bearing behavior is
 * `asCliError`: it must pass an existing CliError through UNCHANGED, because
 * commands wrap their AWS calls in `.catch(err => { throw asCliError(...) })`
 * at several nesting levels. If it re-wrapped, a deliberate exit code (6 for
 * "switch blocked", 2 for "bad input") would be flattened to the generic AWS
 * code 3 on its way out, and the message would grow a second context prefix.
 */
import { describe, expect, it } from "vitest";
import { AwsError, CliError, ValidationError, asCliError } from "../src/lib/errors.js";

describe("CliError", () => {
  it("defaults to exit code 1", () => {
    const e = new CliError("boom");
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe("boom");
    expect(e.name).toBe("CliError");
  });

  it("accepts an explicit exit code", () => {
    expect(new CliError("blocked", 6).exitCode).toBe(6);
  });

  it("is a real Error, so `throw` and stack traces behave", () => {
    const e = new CliError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.stack).toBeTruthy();
  });
});

describe("ValidationError", () => {
  it("always exits 2 — bad input, not an AWS failure", () => {
    const e = new ValidationError("--token is required");
    expect(e.exitCode).toBe(2);
    expect(e.name).toBe("ValidationError");
    expect(e).toBeInstanceOf(CliError);
  });
});

describe("AwsError", () => {
  it("exits 3 and keeps the original error for debugging", () => {
    const cause = new Error("ResourceConflictException");
    const e = new AwsError("failed to update fn", cause);

    expect(e.exitCode).toBe(3);
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("AwsError");
    expect(e).toBeInstanceOf(CliError);
  });

  it("accepts an overridden exit code", () => {
    expect(new AwsError("throttled", new Error("x"), 7).exitCode).toBe(7);
  });
});

describe("asCliError", () => {
  it("returns an existing CliError by identity, not a copy", () => {
    const original = new CliError("already contextualized", 6);

    expect(asCliError(original, "failed to update function foo")).toBe(original);
  });

  it("preserves a ValidationError's exit code through a wrap", () => {
    // The nesting that makes this matter: a command validates input, throws
    // ValidationError(2), and an outer .catch() runs it through asCliError.
    // Re-wrapping would report exit 3 (AWS failure) for a typo in a flag.
    const e = asCliError(new ValidationError("bad endpoint"), "failed to fetch");

    expect(e.exitCode).toBe(2);
    expect(e.message).toBe("bad endpoint");
  });

  it("does not double-prefix a message it has already contextualized", () => {
    const once = asCliError(new Error("denied"), "failed to fetch function foo");
    const twice = asCliError(once, "failed to update function foo");

    expect(twice.message).toBe("failed to fetch function foo: denied");
    expect(twice.message).not.toMatch(/failed to update/);
  });

  it("wraps a plain Error with the caller's context", () => {
    const e = asCliError(new Error("AccessDenied"), "failed to fetch function foo");

    expect(e).toBeInstanceOf(AwsError);
    expect(e.exitCode).toBe(3);
    expect(e.message).toBe("failed to fetch function foo: AccessDenied");
  });

  it("keeps the original throwable as the cause", () => {
    const cause = new Error("AccessDenied");
    const e = asCliError(cause, "ctx") as AwsError;

    expect(e.cause).toBe(cause);
  });

  it.each([
    ["a string", "just a string", "ctx: just a string"],
    ["a number", 42, "ctx: 42"],
    ["null", null, "ctx: null"],
    ["undefined", undefined, "ctx: undefined"],
  ])("stringifies %s throwable rather than crashing", (_label, thrown, expected) => {
    // AWS SDK middleware and third-party code can throw non-Errors. A
    // TypeError inside the error handler would mask the real failure.
    expect(asCliError(thrown, "ctx").message).toBe(expected);
  });

  it("stringifies a thrown object", () => {
    expect(asCliError({ code: "X" }, "ctx").message).toBe("ctx: [object Object]");
  });
});
