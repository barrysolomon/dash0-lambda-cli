/**
 * Root TUI component. Holds global state, renders the persistent banner
 * (top), current screen (middle, flex-grow), and footer (bottom). Sized
 * to fill the entire terminal — the alt-screen-buffer escape codes in
 * src/tui/index.tsx clear the canvas before this mounts.
 *
 * Global hotkeys (handled here so every screen gets them):
 *   Ctrl-C  → exit
 *   q       → exit (when on home screen)
 *   esc     → back (pop screen stack)
 *   ?       → help overlay
 *   a       → switch profile overlay
 *   R       → switch region overlay
 *
 * Screen-specific hotkeys are owned by each screen.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { Banner } from "./Banner.js";
import { Footer } from "./Footer.js";
import { TargetsBanner, TARGETS_BANNER_HIDDEN_SCREENS } from "./TargetsBanner.js";
import { resolveTargets } from "./lib/targets.js";
import { useIdentity } from "./hooks/useIdentity.js";
import { initialState, type AppState, type Screen } from "./types.js";

import { Home } from "./screens/Home.js";
import { Functions } from "./screens/Functions.js";
import { Install } from "./screens/Install.js";
import { Validate } from "./screens/Validate.js";
import { Uninstall } from "./screens/Uninstall.js";
import { Migrate } from "./screens/Migrate.js";
import { Generate } from "./screens/Generate.js";
import { ConsoleScreen } from "./screens/Console.js";
import { ConfigScreen } from "./screens/Config.js";
import { SwitchRegion } from "./screens/SwitchRegion.js";
import { SwitchProfile } from "./screens/SwitchProfile.js";
import { Help } from "./screens/Help.js";
import { AuthError } from "./screens/AuthError.js";
import { Secret } from "./screens/Secret.js";
import { EnvManage } from "./screens/EnvManage.js";
import { SwitchVendor } from "./screens/SwitchVendor.js";
import { UpdateLayer } from "./screens/UpdateLayer.js";
import { isAwsAuthError } from "../menu/auth.js";

/** Hook: terminal dimensions, kept fresh on resize. */
function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout?.rows ?? 30,
    columns: stdout?.columns ?? 100,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setSize({ rows: stdout.rows ?? 30, columns: stdout.columns ?? 100 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

export const App: React.FC<{ initialRegion: string }> = ({ initialRegion }) => {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>(() => initialState(initialRegion));
  const { identity, rawError: identityError } = useIdentity(state.region);
  const { rows, columns } = useTerminalSize();

  // Keep identity in sync. If the identity probe failed with an auth
  // error, auto-route to the AuthError screen so the user gets a fix-it
  // path immediately instead of being stuck with "account not detected".
  useEffect(() => {
    setState((s) => ({ ...s, identity }));
  }, [identity]);
  useEffect(() => {
    if (!identityError) return;
    if (!isAwsAuthError(identityError)) return;
    setState((s) => {
      if (s.suppressAuthAutoRoute) return s;
      if (s.screen === "auth-error") return s;
      return { ...s, back: [...s.back, s.screen], screen: "auth-error" };
    });
  }, [identityError]);

  // Global hotkeys.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (input === "q" && state.screen === "home") {
      exit();
      return;
    }
    if (key.escape) {
      setState((s) => {
        const isLeavingAuthError = s.screen === "auth-error";
        const next: AppState = { ...s };
        if (isLeavingAuthError) next.suppressAuthAutoRoute = true;
        if (s.back.length === 0) {
          next.screen = "home";
        } else {
          const back = [...s.back];
          next.screen = back.pop()!;
          next.back = back;
        }
        return next;
      });
      return;
    }
    if (input === "?" && state.screen !== "help") navigate("help");
    if (input === "a" && state.screen !== "switch-profile") navigate("switch-profile");
    if (input === "R" && state.screen !== "switch-region") navigate("switch-region");
  });

  function navigate(screen: Screen) {
    setState((s) => ({
      ...s,
      back: [...s.back, s.screen],
      screen,
    }));
  }

  // Layout heights:
  //   banner: 3 rows (top + content + bottom of border)
  //   targets banner: 3 rows when selection/focus is non-empty AND screen
  //     wants it shown; 0 otherwise (TargetsBanner returns null).
  //   footer: status (0–1) + hotkey bar (3 rows)
  //   content: everything between
  const showTargets =
    !TARGETS_BANNER_HIDDEN_SCREENS.includes(state.screen) &&
    resolveTargets(state).names.length > 0;
  const footerHeight = state.status ? 4 : 3;
  const bannerHeight = 3;
  const targetsHeight = showTargets ? 3 : 0;
  const contentHeight = Math.max(
    5,
    rows - bannerHeight - targetsHeight - footerHeight,
  );

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
    >
      <Banner state={state} />
      {showTargets && <TargetsBanner state={state} />}
      <Box
        flexDirection="column"
        height={contentHeight}
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        <ScreenRouter state={state} setState={setState} />
      </Box>
      <Footer state={state} />
    </Box>
  );
};

const ScreenRouter: React.FC<{
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
}> = ({ state, setState }) => {
  switch (state.screen) {
    case "home":
      return <Home state={state} setState={setState} />;
    case "functions":
      return <Functions state={state} setState={setState} />;
    case "install":
      return <Install state={state} setState={setState} />;
    case "validate":
      return <Validate state={state} setState={setState} />;
    case "uninstall":
      return <Uninstall state={state} setState={setState} />;
    case "migrate":
      return <Migrate state={state} setState={setState} />;
    case "generate":
      return <Generate state={state} setState={setState} />;
    case "console":
      return <ConsoleScreen state={state} setState={setState} />;
    case "config":
      return <ConfigScreen state={state} setState={setState} />;
    case "switch-region":
      return <SwitchRegion state={state} setState={setState} />;
    case "switch-profile":
      return <SwitchProfile state={state} setState={setState} />;
    case "help":
      return <Help state={state} setState={setState} />;
    case "auth-error":
      return <AuthError state={state} setState={setState} />;
    case "switch-vendor":
      return <SwitchVendor state={state} setState={setState} />;
    case "update-layer":
      return <UpdateLayer state={state} setState={setState} />;
    case "secret":
      return <Secret state={state} setState={setState} />;
    case "env-manage":
      return <EnvManage state={state} setState={setState} />;
    default:
      return <Text>Unknown screen: {state.screen}</Text>;
  }
};
