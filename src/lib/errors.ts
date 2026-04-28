/** Named error classes so commands can catch + format them nicely. */

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ValidationError";
  }
}

export class AwsError extends CliError {
  readonly cause: unknown;
  constructor(message: string, cause: unknown, exitCode = 3) {
    super(message, exitCode);
    this.cause = cause;
    this.name = "AwsError";
  }
}

/** Wrap any thrown value as a CliError with a helpful message. */
export function asCliError(err: unknown, context: string): CliError {
  if (err instanceof CliError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AwsError(`${context}: ${msg}`, err);
}
