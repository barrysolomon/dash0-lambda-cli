/** Shared TUI types — screen routing keys, global state shape. */

import type { FunctionSnapshot } from "../lib/lambda.js";
import type { AwsIdentity } from "../menu/banner.js";

export type Screen =
  | "home"
  | "functions"
  | "install"
  | "validate"
  | "uninstall"
  | "migrate"
  | "generate"
  | "console"
  | "config"
  | "switch-region"
  | "switch-profile"
  | "help"
  | "auth-error"
  | "switch-vendor"
  | "update-layer"
  | "secret"
  | "env-manage"
  | "exit";

/**
 * Global state. Mutated via setState from any screen — React re-renders
 * everywhere needed. We deliberately keep this small; per-screen ephemeral
 * state lives in each screen's local hooks.
 */
export interface AppState {
  screen: Screen;
  /** Stack of screens for "back" navigation. Top of stack = current. */
  back: Screen[];
  region: string;
  profile?: string;
  identity?: AwsIdentity;
  /** Functions selected via spacebar on the Functions screen. */
  selected: Set<string>;
  /** Single function focus — set when entering install/validate/etc. for one. */
  focused?: FunctionSnapshot;
  /** Last status line shown in the footer. */
  status?: { text: string; tone: "info" | "warn" | "error" | "ok" };
  /**
   * When true, App stops auto-routing to the AuthError screen even when
   * useIdentity / useFunctionList still reports a credential failure.
   * Set by AuthError when the user explicitly cancels, so they can poke
   * around the rest of the TUI (e.g. read-only screens, generate IaC)
   * without being yanked back into the SSO picker.
   */
  suppressAuthAutoRoute?: boolean;
}

export const initialState = (region: string): AppState => ({
  screen: "home",
  back: [],
  region,
  selected: new Set(),
  suppressAuthAutoRoute: false,
});

export interface ScreenProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
}
