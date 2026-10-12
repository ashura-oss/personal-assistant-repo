import { useCallback, useEffect, useState } from "react";
import { AppState as NativeAppState, Platform } from "react-native";
import type { AppController } from "../core";

const MAX_TIMEOUT = 2_147_000_000;

function currentForeground() {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    return document.visibilityState === "visible";
  }
  const state = NativeAppState.currentState;
  return state !== "background" && state !== "inactive";
}

/** Runs local matching only after load, on foreground transitions, or at a local due time. */
export function useProactiveClock(
  controller: AppController,
  loading: boolean,
  nextCheckAt?: string,
) {
  const [foreground, setForeground] = useState(currentForeground);
  const evaluate = useCallback(() => {
    void controller.evaluateLocalCandidates().catch(() => {
      // The controller records a fixed, user-safe integrity status in local state.
    });
  }, [controller]);

  useEffect(() => {
    let wasForeground = currentForeground();
    if (!loading && wasForeground) evaluate();

    if (Platform.OS === "web" && typeof document !== "undefined") {
      const onVisibilityChange = () => {
        const visible = document.visibilityState === "visible";
        if (visible !== wasForeground) {
          wasForeground = visible;
          setForeground(visible);
          if (visible && !loading) evaluate();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () =>
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    const subscription = NativeAppState.addEventListener(
      "change",
      (nextState) => {
        const active = nextState === "active";
        if (active !== wasForeground) {
          wasForeground = active;
          setForeground(active);
          if (active && !loading) evaluate();
        }
      },
    );
    return () => subscription.remove();
  }, [evaluate, loading]);

  useEffect(() => {
    if (loading || !foreground || !nextCheckAt) return;
    const date = Date.parse(nextCheckAt);
    if (!Number.isFinite(date)) return;
    const delay = Math.min(MAX_TIMEOUT, Math.max(250, date - Date.now() + 1));
    const timer = setTimeout(evaluate, delay);
    return () => clearTimeout(timer);
  }, [evaluate, foreground, loading, nextCheckAt]);
}
