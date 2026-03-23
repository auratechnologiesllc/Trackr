import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useState } from "react";

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; progress: number }
  | { status: "ready" }
  | { status: "error"; message: string };

const UpdateChecker = () => {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const checkForUpdate = async () => {
      try {
        setState({ status: "checking" });
        const update = await check();

        if (update) {
          setState({ status: "available", version: update.version });
        } else {
          setState({ status: "idle" });
        }
      } catch (e) {
        console.warn("Update check failed:", e);
        setState({ status: "idle" });
      }
    };

    // Check after a short delay so the app loads first
    const timer = setTimeout(checkForUpdate, 3000);
    return () => clearTimeout(timer);
  }, []);

  const handleInstall = async () => {
    try {
      setState({ status: "downloading", progress: 0 });

      const update = await check();
      if (!update) {
        setState({ status: "error", message: "Update no longer available." });
        return;
      }

      let totalBytes = 0;
      let downloadedBytes = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          setState({ status: "downloading", progress });
        } else if (event.event === "Finished") {
          setState({ status: "ready" });
        }
      });

      setState({ status: "ready" });
    } catch (e) {
      setState({
        status: "error",
        message: e instanceof Error ? e.message : "Update failed.",
      });
    }
  };

  const handleRelaunch = async () => {
    await relaunch();
  };

  if (dismissed || state.status === "idle" || state.status === "checking") {
    return null;
  }

  return (
    <div className="update-banner">
      {state.status === "available" && (
        <>
          <span>Update v{state.version} is available</span>
          <button className="update-btn" onClick={handleInstall}>
            Install update
          </button>
          <button className="update-dismiss" onClick={() => setDismissed(true)}>
            Later
          </button>
        </>
      )}

      {state.status === "downloading" && (
        <>
          <span>Downloading update... {state.progress}%</span>
          <div className="update-progress-bar">
            <div
              className="update-progress-fill"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </>
      )}

      {state.status === "ready" && (
        <>
          <span>Update installed. Restart to apply.</span>
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
