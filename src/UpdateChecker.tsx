import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; progress: number }
  | { status: "installing"; version: string }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

type UpdateCheckerProps = {
  enabled: boolean;
};

const INITIAL_UPDATE_CHECK_DELAY_MS = 3000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const updateErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Update failed.";

const UpdateChecker = ({ enabled }: UpdateCheckerProps) => {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);
  const installInFlightRef = useRef(false);
  const readyVersionRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const installUpdate = useCallback(async (update: Update) => {
    if (installInFlightRef.current) return;
    installInFlightRef.current = true;

    try {
      setDismissed(false);
      setState({ status: "downloading", progress: 0 });

      let totalBytes = 0;
      let downloadedBytes = 0;

      await update.downloadAndInstall((event) => {
        if (!mountedRef.current) return;
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          setState({ status: "downloading", progress });
        } else if (event.event === "Finished") {
          setState({ status: "installing", version: update.version });
        }
      });

      if (!mountedRef.current) return;
      readyVersionRef.current = update.version;
      setState({ status: "ready", version: update.version });
    } catch (error) {
      if (!mountedRef.current) return;
      setState({
        status: "error",
        message: updateErrorMessage(error),
      });
    } finally {
      installInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || readyVersionRef.current) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const checkAndInstallUpdate = async () => {
      if (cancelled || installInFlightRef.current || readyVersionRef.current) {
        return;
      }

      try {
        setState((current) => (current.status === "idle" ? { status: "checking" } : current));
        const update = await check();
        if (cancelled || !mountedRef.current || readyVersionRef.current) return;

        if (update) {
          await installUpdate(update);
          return;
        }

        setState((current) => (current.status === "checking" ? { status: "idle" } : current));
      } catch (error) {
        console.warn("Update check failed:", error);
        if (!mountedRef.current || cancelled) return;
        setState((current) => (current.status === "checking" ? { status: "idle" } : current));
      }
    };

    const scheduleCheck = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void checkAndInstallUpdate().finally(() => {
          if (!cancelled && mountedRef.current && !readyVersionRef.current) {
            scheduleCheck(UPDATE_CHECK_INTERVAL_MS);
          }
        });
      }, delayMs);
    };

    scheduleCheck(INITIAL_UPDATE_CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [enabled, installUpdate]);

  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch (error) {
      if (!mountedRef.current) return;
      setState({
        status: "error",
        message: updateErrorMessage(error),
      });
    }
  };

  if (dismissed || state.status === "idle" || state.status === "checking") {
    return null;
  }

  return (
    <div className="update-banner">
      {state.status === "downloading" && (
        <>
          <span>Downloading update automatically... {state.progress}%</span>
          <div className="update-progress-bar">
            <div
              className="update-progress-fill"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </>
      )}

      {state.status === "installing" && (
        <>
          <span>Installing update v{state.version}...</span>
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: "100%" }} />
          </div>
        </>
      )}

      {state.status === "ready" && (
        <>
          <span>Update v{state.version} installed. Restart to apply.</span>
          <button className="update-btn" onClick={handleRelaunch}>
            Restart now
          </button>
          <button className="update-dismiss" onClick={() => setDismissed(true)}>
            Later
          </button>
        </>
      )}

      {state.status === "error" && (
        <>
          <span>Update error: {state.message}</span>
          <button className="update-dismiss" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
};

export default UpdateChecker;
