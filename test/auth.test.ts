import { describe, expect, it } from "vitest";
import { isAwsAuthError } from "../src/menu/auth.js";

function err(name: string, message: string, status?: number): Error {
  const e = new Error(message);
  e.name = name;
  if (status) (e as Error & { $metadata?: { httpStatusCode?: number } }).$metadata = {
    httpStatusCode: status,
  };
  return e;
}

describe("isAwsAuthError", () => {
  it("recognizes InvalidClientTokenId", () => {
    const e = err(
      "InvalidClientTokenId",
      "The security token included in the request is invalid.",
    );
    expect(isAwsAuthError(e)).toBeTruthy();
  });

  it("recognizes ExpiredTokenException", () => {
    const e = err("ExpiredTokenException", "The token expired.");
    expect(isAwsAuthError(e)).toBeTruthy();
  });

  it("recognizes credentials-loading failures from the SDK chain", () => {
    const e = err(
      "CredentialsProviderError",
      "Could not load credentials from any providers",
    );
    expect(isAwsAuthError(e)).toBeTruthy();
  });

  it("recognizes message-only matches when name is generic", () => {
    const e = err(
      "Error",
      "The security token included in the request is invalid",
    );
    expect(isAwsAuthError(e)).toBeTruthy();
  });

  it("recognizes 403 + token in message", () => {
    const e = err("BadRequest", "missing or expired token", 403);
    expect(isAwsAuthError(e)).toBeTruthy();
  });

  it("does not flag unrelated errors as auth issues", () => {
    expect(
      isAwsAuthError(err("ResourceNotFoundException", "function not found")),
    ).toBe(false);
    expect(isAwsAuthError(err("Error", "rate limited"))).toBe(false);
    expect(isAwsAuthError("string error")).toBe(false);
  });
});
