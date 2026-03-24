import { invoke } from "@tauri-apps/api/core";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import html2canvas from "html2canvas";
import { createPortal } from "react-dom";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import UpdateChecker from "./UpdateChecker";
import "./App.css";

type SleepWindow = {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
};

type TodayTimeline = {
  date: string;
  timeline: number[];
  activeMinutes: number;
  idleMinutes: number;
  currentlyActive: boolean;
  sleepMode: boolean;
  sleepWindow: SleepWindow;
  listenerError: string | null;
};

type HeatmapDay = {
  date: string;
  activeMinutes: number;
};

type StorageStatus = {
  storePath: string;
  persistedDayCount: number;
  storeFileExists: boolean;
  storeFileSizeBytes: number;
  lastPersistedAtEpochMs: number | null;
};

type TrackingPermissionStatus = {
  supported: boolean;
  inputMonitoringGranted: boolean;
  allGranted: boolean;
};

type EntitlementCertificate = {
  deviceId: string;
  sessionId: string;
  paymentIntentId: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
  signatureBase64: string;
};

type PaywallStatus = {
  status: "locked" | "unlocked";
  deviceId: string;
  entitlement: EntitlementCertificate | null;
  lastSyncAtEpochMs: number | null;
  nextSyncAtEpochMs: number | null;
  pendingSessionId: string | null;
  reason: string | null;
};

type SleepSettingsDraft = {
  enabled: boolean;
  startTime: string;
  endTime: string;
};

type HoverTooltip = {
  text: string;
  left: number;
  top: number;
};

type HeatmapCell = HeatmapDay & { level: 0 | 1 | 2 | 3 | 4 };
type ColorTheme = "evergreen" | "sunrise" | "ocean" | "dark";
type ShareTarget = "x" | "reddit";
type LockedPreviewBar = {
  tone: "active" | "idle";
  height: number;
};

const HEATMAP_DAYS = 365;
const TIMELINE_BUCKET_MINUTES = 5;
const MINUTES_PER_DAY = 1_440;
const DEFAULT_SLEEP_START_MINUTE = 23 * 60;
const DEFAULT_SLEEP_END_MINUTE = 7 * 60;
const PAYWALL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAYWALL_LOCKED_ERROR = "PAYWALL_LOCKED";
const INPUT_MONITORING_REQUIRED_ERROR = "INPUT_MONITORING_REQUIRED";
const PAYWALL_API_BASE_URL = (
  (import.meta.env.VITE_PAYWALL_API_BASE_URL as string | undefined)?.trim() ||
  (import.meta.env.DEV ? "http://localhost:3010" : "")
).replace(/\/$/, "");
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() ?? "0.1.0";
const COLOR_THEME_OPTIONS: Array<{
  id: ColorTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
}> = [
  {
    id: "evergreen",
    label: "Evergreen",
    description: "Fresh greens and cool blues for focus.",
    swatches: ["#149954", "#5674e2", "#e24a4a"],
  },
  {
    id: "sunrise",
    label: "Sunrise",
    description: "Warm coral and amber with soft mint.",
    swatches: ["#f08b42", "#f7bc52", "#d75456"],
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep teal tones with calm sky accents.",
    swatches: ["#127a95", "#2d94b5", "#de6b51"],
  },
  {
    id: "dark",
    label: "Dark",
    description: "Pure black with high-contrast accents.",
    swatches: ["#000000", "#1a1a1a", "#2cae82"],
  },
];
const LOCKED_PAYWALL_PREVIEW_BARS: LockedPreviewBar[] = Array.from(
  { length: 60 },
  (_, index) => {
    const progress = index / 59;
    const baseHeight = 18 + progress * 60;
    const variation = Math.sin(index * 0.78) * 7 + Math.cos(index * 0.31) * 4;
    const height = Math.max(16, Math.min(88, baseHeight + variation));
    const value = (index * 17 + 9) % 23;

    return {
      tone: value < 7 ? "idle" : "active",
      height,
    };
  },
);
const toHours = (minutes: number) => (minutes / 60).toFixed(1);

const parseLocalDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  return new Date(year, month - 1, day);
};

const formatIsoDate = (isoDate?: string | null) => {
  if (!isoDate) return "--";
  return parseLocalDate(isoDate).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const buildTooltipPosition = (clientX: number, clientY: number) => {
  const margin = 12;
  const estimatedWidth = 320;
  const estimatedHeight = 48;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const left = Math.max(
    margin,
    Math.min(clientX + 14, viewportWidth - estimatedWidth - margin),
  );
  const top = Math.max(
    margin,
    Math.min(clientY - 40, viewportHeight - estimatedHeight - margin),
  );

  return { left, top };
};

const minuteToClock = (minuteValue: number) => {
  const minute = ((Math.floor(minuteValue) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minute / 60)
    .toString()
    .padStart(2, "0");
  const mins = (minute % 60).toString().padStart(2, "0");
  return `${hour}:${mins}`;
};

const minuteToLocalLabel = (minuteValue: number) => {
  const minute = ((Math.floor(minuteValue) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(minute / 60);
  const minutes = minute % 60;
  const meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  if (minutes === 0) {
    return `${hour12}${meridiem}`;
  }
  return `${hour12}:${minutes.toString().padStart(2, "0")}${meridiem}`;
};

const clockToMinute = (clockValue: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(clockValue.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return hour * 60 + minute;
};

const isMinuteInSleepWindow = (minuteOfDay: number, sleepWindow?: SleepWindow | null) => {
  if (!sleepWindow?.enabled) return false;

  const start = ((sleepWindow.startMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const end = ((sleepWindow.endMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const minute = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  if (start === end) return false;
  if (start < end) {
    return minute >= start && minute < end;
  }

  return minute >= start || minute < end;
};

const bucketIndexForNow = () => {
  const now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / TIMELINE_BUCKET_MINUTES);
};

const activityLevel = (minutes: number): 0 | 1 | 2 | 3 | 4 => {
  if (minutes <= 0) return 0;
  if (minutes <= 60) return 1;
  if (minutes <= 180) return 2;
  if (minutes <= 360) return 3;
  return 4;
};

const formatRange = (bucket: number) => {
  const start = bucket * TIMELINE_BUCKET_MINUTES;
  const end = start + TIMELINE_BUCKET_MINUTES;
  return `${minuteToLocalLabel(start)}-${minuteToLocalLabel(end)}`;
};

const shareTargetLabel = (target: ShareTarget) => (target === "x" ? "X" : "Reddit");

const XIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M18.9 2h3.2l-7 8 8.3 12h-6.5l-5.1-7.3-6.4 7.3H2.2l7.5-8.6L1.8 2h6.6l4.6 6.7L18.9 2Zm-1.1 18h1.8L7.4 3.9H5.5L17.8 20Z"
      fill="currentColor"
    />
  </svg>
);

const RedditIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M19.7 10.2c-.7 0-1.3.3-1.7.8-1.6-1.1-3.7-1.8-6-1.9l1-3.2 2.8.7c0 1 .8 1.8 1.8 1.8s1.8-.8 1.8-1.8-.8-1.8-1.8-1.8c-.8 0-1.5.5-1.7 1.2l-3.2-.8c-.2-.1-.5.1-.5.3l-1.1 3.6c-2.4.1-4.5.8-6.1 2-.3-.5-.9-.8-1.6-.8-1 0-1.8.8-1.8 1.8 0 .7.4 1.4 1.1 1.7-.1.4-.1.7-.1 1.1 0 3.1 3.6 5.7 8 5.7s8-2.5 8-5.7c0-.4 0-.8-.1-1.1.7-.3 1.1-.9 1.1-1.7 0-1-.8-1.8-1.8-1.8Zm-11.4 4.2c0-.8.7-1.5 1.5-1.5.8 0 1.5.7 1.5 1.5 0 .8-.7 1.5-1.5 1.5-.8 0-1.5-.6-1.5-1.5Zm7.3 3.2c-.9.9-2.2 1.4-3.6 1.4-1.4 0-2.7-.5-3.6-1.4-.2-.2-.2-.5 0-.7.2-.2.5-.2.7 0 .7.7 1.8 1.1 2.9 1.1 1.1 0 2.1-.4 2.9-1.1.2-.2.5-.2.7 0 .1.2.1.5 0 .7Zm-1.3-1.7c-.8 0-1.5-.6-1.5-1.5 0-.8.7-1.5 1.5-1.5.8 0 1.5.7 1.5 1.5 0 .9-.6 1.5-1.5 1.5Z"
      fill="currentColor"
    />
  </svg>
);

const friendlyLaunchAtLoginErrorMessage = (raw: unknown) => {
  const message = parseErrorMessage(raw).trim();
  if (!message) {
    return "Couldn't update launch at login right now.";
  }
  if (/unsupported|not supported|unavailable/i.test(message)) {
    return "Launch at login isn't available in this Trackr build.";
  }

  return "Couldn't update launch at login right now.";
};

type CheckoutStartResponse = {
  checkoutUrl: string;
  sessionId: string;
  expiresAtEpochMs: number;
};

type CheckoutStatusResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "paid"; entitlement: EntitlementCertificate };

type EntitlementRefreshResponse =
  | { status: "active"; entitlement: EntitlementCertificate; nextSyncAtEpochMs: number }
  | { status: "revoked"; reason: string };

const paywallApiUrl = (path: string) => {
  if (!PAYWALL_API_BASE_URL) {
    throw new Error(
      "VITE_PAYWALL_API_BASE_URL is not configured. Set it in .env or run the paywall API on http://localhost:3010 in dev.",
    );
  }
  return `${PAYWALL_API_BASE_URL}${path}`;
};

const parseErrorMessage = (raw: unknown) => {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  return String(raw);
};

const friendlyUserErrorMessage = (raw: unknown, fallback: string) => {
  const message = parseErrorMessage(raw).trim();

  if (!message) return fallback;
  if (/VITE_PAYWALL_API_BASE_URL|PAYWALL_API_BASE_URL/i.test(message)) {
    return fallback;
  }
  if (/Failed to fetch|NetworkError|network request/i.test(message)) {
    return "Couldn't connect right now. Check your connection and try again.";
  }
  if (/TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64|signature verification failed|public key/i.test(message)) {
    return "This Trackr build couldn't verify the access certificate it received. If you're running locally, make sure the desktop app and paywall API use the same entitlement key.";
  }
  if (/Request failed \(\d{3}\)/i.test(message)) {
    return fallback;
  }

  return message;
};

const looksLikeEntitlementApplyError = (raw: unknown) => {
  const message = parseErrorMessage(raw).trim();
  if (!message) return false;

  return /TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64|entitlement|signature|verification|public key/i.test(
    message,
  );
};

const friendlyListenerErrorMessage = (message: string | null) => {
  if (!message) return null;
  if (/Input Monitoring permission/i.test(message)) {
    return "Trackr needs Input Monitoring access in macOS Settings to track activity.";
  }
  if (/paused by macOS|stopped unexpectedly/i.test(message)) {
    return "Trackr is reconnecting to activity tracking.";
  }
  if (/run loop source|Failed to start Windows input listener/i.test(message)) {
    return "Trackr hit a problem starting activity tracking. It will retry automatically.";
  }
  if (/only implemented .*macOS/i.test(message)) {
    return "Activity tracking is currently available on macOS and Windows.";
  }

  return message;
};

const fetchPaywallJson = async <TResponse,>(
  path: string,
  init?: RequestInit,
): Promise<TResponse> => {
  const includeJsonContentType = Boolean(init?.body);
  const response = await fetch(paywallApiUrl(path), {
    ...init,
    headers: {
      ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const rawText = await response.text();
  const payload = rawText ? (JSON.parse(rawText) as unknown) : {};

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: string }).error ?? "Request failed")
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as TResponse;
};

const App = () => {
  const [appMode, setAppMode] = useState<"loading" | "permissions" | "locked" | "unlocked">(
    "loading",
  );
  const [trackingPermissionStatus, setTrackingPermissionStatus] =
    useState<TrackingPermissionStatus | null>(null);
  const [trackingPermissionError, setTrackingPermissionError] = useState<string | null>(null);
  const [requestingTrackingPermission, setRequestingTrackingPermission] = useState(false);
  const [paywallStatus, setPaywallStatus] = useState<PaywallStatus | null>(null);
  const [paywallError, setPaywallError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [pollingSessionId, setPollingSessionId] = useState<string | null>(null);
  const [pollingMessage, setPollingMessage] = useState<string | null>(null);
  const [syncingEntitlement, setSyncingEntitlement] = useState(false);
  const [today, setToday] = useState<TodayTimeline | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<TodayTimeline | null>(null);
  const [selectingDay, setSelectingDay] = useState(false);
  const [daySelectionError, setDaySelectionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [sleepDraft, setSleepDraft] = useState<SleepSettingsDraft>({
    enabled: false,
    startTime: minuteToClock(DEFAULT_SLEEP_START_MINUTE),
    endTime: minuteToClock(DEFAULT_SLEEP_END_MINUTE),
  });
  const [sleepDirty, setSleepDirty] = useState(false);
  const [sleepSaveError, setSleepSaveError] = useState<string | null>(null);
  const [savingSleep, setSavingSleep] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltip | null>(null);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = useState<boolean | null>(null);
  const [launchAtLoginLoading, setLaunchAtLoginLoading] = useState(true);
  const [launchAtLoginSaving, setLaunchAtLoginSaving] = useState(false);
  const [launchAtLoginError, setLaunchAtLoginError] = useState<string | null>(null);
  const [colorTheme, setColorTheme] = useState<ColorTheme>("evergreen");
  const [sharingTarget, setSharingTarget] = useState<ShareTarget | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const shareCaptureRef = useRef<HTMLElement | null>(null);
  const autoPermissionRequestAttemptedRef = useRef(false);

  const refreshPaywallStatus = async () => invoke<PaywallStatus>("get_paywall_status");
  const refreshTrackingPermissionStatus = async () =>
    invoke<TrackingPermissionStatus>("get_tracking_permission_status");
  const requestTrackingPermissionAccess = async () =>
    invoke<TrackingPermissionStatus>("request_tracking_permission_access");

  useEffect(() => {
    const syncPageVisibility = () => {
      setPageVisible(document.visibilityState !== "hidden");
    };

    document.addEventListener("visibilitychange", syncPageVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncPageVisibility);
    };
  }, []);

  const refreshLaunchAtLogin = useEffectEvent(async () => {
    try {
      setLaunchAtLoginEnabled(await isAutostartEnabled());
      setLaunchAtLoginError(null);
    } catch (launchAtLoginStatusError) {
      setLaunchAtLoginError(friendlyLaunchAtLoginErrorMessage(launchAtLoginStatusError));
    } finally {
      setLaunchAtLoginLoading(false);
    }
  });

  const enterPermissionMode = (status: TrackingPermissionStatus, errorMessage?: string) => {
    setTrackingPermissionStatus(status);
    setAppMode("permissions");
    setError(null);
    setToday(null);
    setHeatmap([]);
    setStorage(null);
    setSelectedDay(null);
    setSelectedDate(null);
    setLastUpdated(null);
    setDaySelectionError(null);
    setSleepSaveError(null);
    setTrackingPermissionError(errorMessage ?? null);
  };

  const bootstrapPaywallStatus = async () => {
    try {
      let status = await refreshPaywallStatus();

      setPaywallStatus(status);
      setPollingSessionId(status.pendingSessionId);
      if (status.pendingSessionId) {
        setPollingMessage("Finish payment in your browser to continue.");
      } else {
        setPollingMessage(null);
      }

      if (status.status === "unlocked") {
        status = await syncEntitlementIfDue(status);
        setPaywallStatus(status);
      }

      setPaywallError(null);
      setAppMode(status.status === "unlocked" ? "unlocked" : "locked");
    } catch (paywallInitError) {
      setPaywallError(
        friendlyUserErrorMessage(paywallInitError, "Trackr couldn't verify access right now."),
      );
      setAppMode("locked");
    }
  };

  const refreshTrackingAccess = useEffectEvent(async (prompt: boolean) => {
    if (prompt) {
      setRequestingTrackingPermission(true);
    }

    try {
      const status = prompt
        ? await requestTrackingPermissionAccess()
        : await refreshTrackingPermissionStatus();
      setTrackingPermissionStatus(status);

      if (!status.allGranted) {
        setAppMode("permissions");
        setTrackingPermissionError(null);
        return false;
      }

      setTrackingPermissionError(null);
      setAppMode("loading");
      await bootstrapPaywallStatus();
      return true;
    } catch (trackingAccessError) {
      setTrackingPermissionError(
        friendlyUserErrorMessage(
          trackingAccessError,
          "Trackr couldn't verify background tracking access.",
        ),
      );
      setAppMode("permissions");
      return false;
    } finally {
      if (prompt) {
        setRequestingTrackingPermission(false);
      }
    }
  });

  const handleTrackingAccessRequired = async (raw: unknown) => {
    const message = parseErrorMessage(raw);
    if (!message.includes(INPUT_MONITORING_REQUIRED_ERROR)) {
      return false;
    }

    try {
      const status = await refreshTrackingPermissionStatus();
      enterPermissionMode(status);
    } catch (trackingAccessError) {
      enterPermissionMode(
        {
          supported: true,
          inputMonitoringGranted: false,
          allGranted: false,
        },
        friendlyUserErrorMessage(
          trackingAccessError,
          "Trackr couldn't verify background tracking access.",
        ),
      );
    }

    return true;
  };

  const syncEntitlementIfDue = async (currentStatus: PaywallStatus) => {
    if (currentStatus.status !== "unlocked" || !currentStatus.entitlement) return currentStatus;
    if (!PAYWALL_API_BASE_URL || !navigator.onLine) return currentStatus;
    if (
      currentStatus.nextSyncAtEpochMs !== null &&
      currentStatus.nextSyncAtEpochMs > Date.now()
    ) {
      return currentStatus;
    }

    setSyncingEntitlement(true);
    try {
      const response = await fetchPaywallJson<EntitlementRefreshResponse>("/api/entitlement/refresh", {
        method: "POST",
        body: JSON.stringify({
          deviceId: currentStatus.deviceId,
          entitlement: currentStatus.entitlement,
        }),
      });

      if (response.status === "revoked") {
        await invoke("clear_entitlement");
        setPaywallError(`Your access is no longer available: ${response.reason}`);
        return refreshPaywallStatus();
      }

      await invoke<PaywallStatus>("apply_entitlement", { entitlement: response.entitlement });
      return refreshPaywallStatus();
    } catch (syncError) {
      setPaywallError(
        friendlyUserErrorMessage(syncError, "Couldn't refresh your access right now."),
      );
      return currentStatus;
    } finally {
      setSyncingEntitlement(false);
    }
  };

  useEffect(() => {
    let active = true;

    const bootstrapApp = async () => {
      try {
        let permissionStatus = await refreshTrackingPermissionStatus();
        if (!active) return;

        if (
          !permissionStatus.allGranted &&
          permissionStatus.supported &&
          !autoPermissionRequestAttemptedRef.current
        ) {
          autoPermissionRequestAttemptedRef.current = true;
          setRequestingTrackingPermission(true);
          try {
            permissionStatus = await requestTrackingPermissionAccess();
            if (!active) return;
          } finally {
            setRequestingTrackingPermission(false);
          }
        }

        setTrackingPermissionStatus(permissionStatus);
        if (!permissionStatus.allGranted) {
          enterPermissionMode(permissionStatus);
          return;
        }

        await bootstrapPaywallStatus();
      } catch (bootstrapError) {
        if (!active) return;
        setTrackingPermissionError(
          friendlyUserErrorMessage(
            bootstrapError,
            "Trackr couldn't verify background tracking access.",
          ),
        );
        setAppMode("permissions");
      }
    };

    void bootstrapApp();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void refreshLaunchAtLogin();
  }, [refreshLaunchAtLogin]);

  useEffect(() => {
    if (appMode !== "permissions" || !pageVisible) return;

    let active = true;
    let timer: number | null = null;
    let polling = false;
    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const status = await refreshTrackingPermissionStatus();
        if (!active) return;

        setTrackingPermissionStatus(status);
        if (status.allGranted) {
          setTrackingPermissionError(null);
          setAppMode("loading");
          await bootstrapPaywallStatus();
        }
      } catch (trackingAccessError) {
        if (!active) return;
        setTrackingPermissionError(
          friendlyUserErrorMessage(
            trackingAccessError,
            "Trackr couldn't verify background tracking access.",
          ),
        );
      } finally {
        polling = false;
        if (active) {
          timer = window.setTimeout(() => {
            void refresh();
          }, 3_000);
        }
      }
    };

    void refresh();

    return () => {
      active = false;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [appMode, pageVisible]);

  useEffect(() => {
    if (appMode !== "unlocked" || !pageVisible) return;
    let active = true;
    let timer: number | null = null;
    let polling = false;

    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const permissionStatus = await refreshTrackingPermissionStatus();
        if (!active) return;
        setTrackingPermissionStatus(permissionStatus);
        if (!permissionStatus.allGranted) {
          enterPermissionMode(permissionStatus);
          return;
        }

        const [todayData, heatmapData, storageData] = await Promise.all([
          invoke<TodayTimeline>("get_today_timeline"),
          invoke<HeatmapDay[]>("get_heatmap", { days: HEATMAP_DAYS }),
          invoke<StorageStatus>("get_storage_status"),
        ]);

        if (!active) return;

        setToday(todayData);
        setHeatmap(heatmapData);
        setStorage(storageData);
        setError(friendlyListenerErrorMessage(todayData.listenerError));
        setSelectedDate((current) => current ?? todayData.date);
        setSelectedDay((current) => {
          if (!current) return todayData;
          if (current.date === todayData.date) return todayData;
          return current;
        });
        setLastUpdated(new Date());
      } catch (fetchError) {
        if (!active) return;
        if (await handleTrackingAccessRequired(fetchError)) {
          return;
        }
        const message = parseErrorMessage(fetchError);
        if (message.includes(PAYWALL_LOCKED_ERROR)) {
          const lockedStatus = await refreshPaywallStatus();
          if (!active) return;
          setPaywallStatus(lockedStatus);
          setPaywallError("Payment is required to access Trackr.");
          setAppMode("locked");
          return;
        }
        setError(friendlyUserErrorMessage(fetchError, "Couldn't load your activity right now."));
      } finally {
        polling = false;
        if (active) {
          timer = window.setTimeout(() => {
            void refresh();
          }, 15_000);
        }
      }
    };

    void refresh();

    return () => {
      active = false;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [appMode, pageVisible]);

  useEffect(() => {
    if (!today) return;
    if (!selectedDate) {
      setSelectedDate(today.date);
      setSelectedDay(today);
      return;
    }

    if (selectedDate === today.date) {
      setSelectedDay(today);
    }
  }, [today, selectedDate]);

  const displayedDay = selectedDay ?? today;
  const viewingToday = displayedDay?.date === today?.date;
  const selectedDateLabel = viewingToday ? "Today" : formatIsoDate(displayedDay?.date);
  const backgroundTrackingSupported = trackingPermissionStatus?.supported ?? true;
  const inputMonitoringGranted = trackingPermissionStatus?.inputMonitoringGranted ?? false;

  useEffect(() => {
    if (!today || sleepDirty || savingSleep) return;
    setSleepDraft({
      enabled: today.sleepWindow.enabled,
      startTime: minuteToClock(today.sleepWindow.startMinute),
      endTime: minuteToClock(today.sleepWindow.endMinute),
    });
  }, [today, sleepDirty, savingSleep]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", colorTheme);
    return () => {
      document.documentElement.removeAttribute("data-theme");
    };
  }, [colorTheme]);

  const effectiveSleepWindow = useMemo<SleepWindow>(() => {
    const startMinute = clockToMinute(sleepDraft.startTime);
    const endMinute = clockToMinute(sleepDraft.endTime);

    if (startMinute === null || endMinute === null) {
      return (
        displayedDay?.sleepWindow ?? {
          enabled: false,
          startMinute: DEFAULT_SLEEP_START_MINUTE,
          endMinute: DEFAULT_SLEEP_END_MINUTE,
        }
      );
    }

    return {
      enabled: sleepDraft.enabled,
      startMinute,
      endMinute,
    };
  }, [sleepDraft, displayedDay?.sleepWindow]);

  const timelineBuckets = useMemo(() => {
    const raw = displayedDay?.timeline ?? [];
    const padded = [...raw];
    if (padded.length < MINUTES_PER_DAY) {
      padded.push(...Array.from({ length: MINUTES_PER_DAY - padded.length }, () => 0));
    }

    return Array.from({ length: MINUTES_PER_DAY / TIMELINE_BUCKET_MINUTES }, (_, index) => {
      const bucketStartMinute = index * TIMELINE_BUCKET_MINUTES;
      let activeMinutes = 0;
      let sleepMinutes = 0;

      for (let minute = bucketStartMinute; minute < bucketStartMinute + TIMELINE_BUCKET_MINUTES; minute += 1) {
        if (isMinuteInSleepWindow(minute, effectiveSleepWindow)) {
          sleepMinutes += 1;
          continue;
        }

        if ((padded[minute] ?? 0) > 0) {
          activeMinutes += 1;
        }
      }

      const monitoredMinutes = TIMELINE_BUCKET_MINUTES - sleepMinutes;
      return {
        index,
        bucketStartMinute,
        active: activeMinutes > 0,
        activeMinutes,
        monitoredMinutes,
      };
    }).filter((bucket) => bucket.monitoredMinutes > 0);
  }, [displayedDay?.timeline, effectiveSleepWindow]);

  const timelineStyle = useMemo(
    () =>
      ({
        gridTemplateColumns: `repeat(${Math.max(timelineBuckets.length, 1)}, minmax(0, 1fr))`,
      }) as CSSProperties,
    [timelineBuckets.length],
  );

  const timelineAxisMinutes = useMemo(() => {
    if (timelineBuckets.length === 0) {
      return [0, 6 * 60, 12 * 60, 18 * 60, 24 * 60];
    }

    const checkpoints = [0, 0.25, 0.5, 0.75, 1];
    return checkpoints.map((fraction, index) => {
      if (index === checkpoints.length - 1) {
        const lastBucket = timelineBuckets[timelineBuckets.length - 1];
        return lastBucket.bucketStartMinute + TIMELINE_BUCKET_MINUTES;
      }

      const bucketPosition = Math.round((timelineBuckets.length - 1) * fraction);
      return timelineBuckets[bucketPosition].bucketStartMinute;
    });
  }, [timelineBuckets]);

  const heatmapWeeks = useMemo(() => {
    const cells: HeatmapCell[] = heatmap.map((day) => ({
      ...day,
      level: activityLevel(day.activeMinutes),
    }));

    if (cells.length === 0) {
      return { weeks: [] as (HeatmapCell | null)[][], monthLabels: [] as string[] };
    }

    const firstDate = parseLocalDate(cells[0].date);
    const leadingPad = firstDate.getDay();
    const padded = Array.from({ length: leadingPad }, () => null as HeatmapCell | null).concat(
      cells,
    );

    const weeks = Array.from({ length: Math.ceil(padded.length / 7) }, (_, weekIdx) => {
      const chunk = padded.slice(weekIdx * 7, weekIdx * 7 + 7);
      while (chunk.length < 7) chunk.push(null);
      return chunk;
    });

    let previousMonth = "";
    const monthLabels = weeks.map((week) => {
      const firstNonEmpty = week.find((cell) => cell !== null);
      if (!firstNonEmpty) return "";
      const month = parseLocalDate(firstNonEmpty.date).toLocaleString(undefined, {
        month: "short",
      });
      if (month === previousMonth) return "";
      previousMonth = month;
      return month;
    });

    return { weeks, monthLabels };
  }, [heatmap]);

  const nowBucket = viewingToday ? bucketIndexForNow() : Number.POSITIVE_INFINITY;
  const statusClass = !displayedDay
    ? "idle"
    : viewingToday
      ? displayedDay.sleepMode
        ? "sleep"
        : displayedDay.currentlyActive
          ? "active"
          : "idle"
      : "history";
  const statusLabel = !displayedDay
    ? "No data"
    : viewingToday
      ? displayedDay.sleepMode
        ? "Sleep mode"
        : displayedDay.currentlyActive
          ? "Active now"
          : "Idle now"
      : `Viewing ${formatIsoDate(displayedDay.date)}`;

  const updateSleepDraft = (changes: Partial<SleepSettingsDraft>) => {
    setSleepDraft((current) => ({ ...current, ...changes }));
    setSleepDirty(true);
    setSleepSaveError(null);
  };

  const selectDay = async (date: string) => {
    setSelectedDate(date);
    setDaySelectionError(null);

    if (date === today?.date) {
      setSelectedDay(today);
      return;
    }

    setSelectingDay(true);
    try {
      const dayData = await invoke<TodayTimeline>("get_day_timeline", { date });
      setSelectedDay(dayData);
    } catch (selectionError) {
      if (await handleTrackingAccessRequired(selectionError)) {
        return;
      }
      setDaySelectionError(
        friendlyUserErrorMessage(selectionError, `Couldn't load ${formatIsoDate(date)}.`),
      );
    } finally {
      setSelectingDay(false);
    }
  };

  const saveSleepWindow = async () => {
    const startMinute = clockToMinute(sleepDraft.startTime);
    const endMinute = clockToMinute(sleepDraft.endTime);

    if (startMinute === null || endMinute === null) {
      setSleepSaveError("Please use valid 24-hour times for the sleep window.");
      return;
    }

    setSavingSleep(true);
    setSleepSaveError(null);
    try {
      const saved = await invoke<SleepWindow>("set_sleep_window", {
        enabled: sleepDraft.enabled,
        startMinute,
        endMinute,
      });
      setSleepDraft({
        enabled: saved.enabled,
        startTime: minuteToClock(saved.startMinute),
        endTime: minuteToClock(saved.endMinute),
      });
      setSleepDirty(false);

      const [todayData, storageData] = await Promise.all([
        invoke<TodayTimeline>("get_today_timeline"),
        invoke<StorageStatus>("get_storage_status"),
      ]);
      setToday(todayData);
      setStorage(storageData);
      setError(friendlyListenerErrorMessage(todayData.listenerError));
      setLastUpdated(new Date());
    } catch (saveError) {
      if (await handleTrackingAccessRequired(saveError)) {
        return;
      }
      setSleepSaveError(
        friendlyUserErrorMessage(saveError, "Couldn't save your sleep window."),
      );
    } finally {
      setSavingSleep(false);
    }
  };

  const showHoverTooltip = (
    event: ReactMouseEvent<HTMLDivElement>,
    text: string,
  ) => {
    const position = buildTooltipPosition(event.clientX, event.clientY);
    setHoverTooltip({ text, ...position });
  };

  const moveHoverTooltip = (event: ReactMouseEvent<HTMLDivElement>) => {
    setHoverTooltip((current) => {
      if (!current) return null;
      const position = buildTooltipPosition(event.clientX, event.clientY);
      return { ...current, ...position };
    });
  };

  const hideHoverTooltip = () => {
    setHoverTooltip(null);
  };

  const setLaunchAtLogin = useEffectEvent(async (nextEnabled: boolean) => {
    const previousValue = launchAtLoginEnabled ?? false;

    setLaunchAtLoginSaving(true);
    setLaunchAtLoginError(null);
    setLaunchAtLoginEnabled(nextEnabled);

    try {
      if (nextEnabled) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }
      setLaunchAtLoginEnabled(await isAutostartEnabled());
    } catch (launchAtLoginUpdateError) {
      setLaunchAtLoginEnabled(previousValue);
      setLaunchAtLoginError(friendlyLaunchAtLoginErrorMessage(launchAtLoginUpdateError));
    } finally {
      setLaunchAtLoginSaving(false);
    }
  });

  const copyImageToClipboard = async (blob: Blob) => {
    if (!("clipboard" in navigator) || typeof ClipboardItem === "undefined") {
      return false;
    }

    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch (clipboardError) {
      console.warn("Trackr share clipboard error", clipboardError);
      return false;
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  const captureShareSnapshot = async () => {
    const captureRoot = shareCaptureRef.current;
    if (!captureRoot) {
      throw new Error("Share capture area is not ready.");
    }

    const canvas = await html2canvas(captureRoot, {
      scale: Math.min(window.devicePixelRatio || 1, 2),
      useCORS: true,
      backgroundColor: null,
    });

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });

    if (!blob) {
      throw new Error("Failed to render share image.");
    }

    return blob;
  };

  const buildShareText = () => {
    const activeHours = toHours(displayedDay?.activeMinutes ?? 0);
    const idleHours = toHours(displayedDay?.idleMinutes ?? 0);
    if (viewingToday) {
      return `Today's Trackr progress: ${activeHours}h active, ${idleHours}h idle.`;
    }
    return `My ${formatIsoDate(displayedDay?.date)} Trackr progress: ${activeHours}h active, ${idleHours}h idle.`;
  };

  const shareToTarget = async (target: ShareTarget) => {
    if (sharingTarget) return;

    setShareMessage(null);
    setSharingTarget(target);

    try {
      const imageBlob = await captureShareSnapshot();
      const copied = await copyImageToClipboard(imageBlob);
      if (!copied) {
        const fallbackDate = displayedDay?.date ?? "day";
        downloadBlob(imageBlob, `trackr-${fallbackDate}.png`);
      }

      const text = buildShareText();
      if (target === "x") {
        await openUrl(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`);
      } else {
        const title = viewingToday
          ? "Today's Trackr progress"
          : `${formatIsoDate(displayedDay?.date)} Trackr progress`;
        const body = `${text}\n\nScreenshot from Trackr desktop app.`;
        await openUrl(
          `https://www.reddit.com/submit?selftext=true&title=${encodeURIComponent(
            title,
          )}&text=${encodeURIComponent(body)}`,
        );
      }

      const action = copied
        ? "Screenshot copied to clipboard. Paste it with Cmd/Ctrl+V."
        : "Screenshot downloaded to your device.";
      setShareMessage(`${action} ${shareTargetLabel(target)} opened in your browser.`);
    } catch (shareError) {
      console.error("Trackr share error", shareError);
      setShareMessage(`Share failed: ${String(shareError)}`);
    } finally {
      setSharingTarget(null);
    }
  };

  const launchCheckout = async () => {
    if (unlocking || !paywallStatus) return;

    setUnlocking(true);
    setPaywallError(null);
    setPollingMessage(null);

    try {
      const response = await fetchPaywallJson<CheckoutStartResponse>("/api/checkout/start", {
        method: "POST",
        body: JSON.stringify({
          deviceId: paywallStatus.deviceId,
          appVersion: APP_VERSION,
        }),
      });
      await invoke("set_pending_checkout_session", { sessionId: response.sessionId });
      setPollingSessionId(response.sessionId);
      setPaywallStatus((current) =>
        current ? { ...current, pendingSessionId: response.sessionId } : current,
      );
      setPollingMessage("Checkout opened in your browser. Finish payment, then return to Trackr.");
      await openUrl(response.checkoutUrl);
    } catch (checkoutError) {
      setPaywallError(
        friendlyUserErrorMessage(checkoutError, "Couldn't start checkout right now."),
      );
    } finally {
      setUnlocking(false);
    }
  };

  const attemptEntitlementRefresh = useEffectEvent(async () => {
    if (!paywallStatus || paywallStatus.status !== "unlocked") return;
    const nextStatus = await syncEntitlementIfDue(paywallStatus);
    setPaywallStatus(nextStatus);
    if (nextStatus.status === "locked") {
      setAppMode("locked");
    }
  });

  useEffect(() => {
    if (!pollingSessionId || appMode === "unlocked" || !paywallStatus?.deviceId) return;

    let active = true;
    let timer: number | null = null;
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const result = await fetchPaywallJson<CheckoutStatusResponse>(
          `/api/checkout/status?sessionId=${encodeURIComponent(
            pollingSessionId,
          )}&deviceId=${encodeURIComponent(paywallStatus.deviceId)}`,
        );

        if (!active) return;
        if (result.status === "pending") {
          setPollingMessage("Confirming your payment...");
          return;
        }
        if (result.status === "expired") {
          setPollingMessage("Your checkout session expired. Start checkout again.");
          setPollingSessionId(null);
          await invoke("set_pending_checkout_session", { sessionId: null });
          setPaywallStatus((current) =>
            current ? { ...current, pendingSessionId: null } : current,
          );
          return;
        }

        await invoke<PaywallStatus>("apply_entitlement", { entitlement: result.entitlement });
        await invoke("set_pending_checkout_session", { sessionId: null });
        const unlockedStatus = await refreshPaywallStatus();
        if (!active) return;

        setPaywallStatus(unlockedStatus);
        setPollingSessionId(null);
        setPollingMessage("Payment confirmed. Trackr is unlocked.");
        setAppMode(unlockedStatus.status === "unlocked" ? "unlocked" : "locked");
      } catch (pollError) {
        if (!active) return;
        console.warn("Unable to verify Stripe payment yet.", pollError);
        if (looksLikeEntitlementApplyError(pollError)) {
          setPaywallError(
            friendlyUserErrorMessage(
              pollError,
              "Payment was received, but this Trackr build could not apply your license.",
            ),
          );
          setPollingMessage("Payment was received, but Trackr could not apply your license.");
          setPollingSessionId(null);
          return;
        }

        const message = parseErrorMessage(pollError);
        if (/Failed to fetch|NetworkError|network request/i.test(message)) {
          setPaywallError(null);
          setPollingMessage("Confirming your payment...");
          return;
        }

        setPaywallError(
          friendlyUserErrorMessage(pollError, "Trackr couldn't finish unlocking automatically."),
        );
        setPollingMessage("Trackr couldn't finish unlocking automatically.");
        setPollingSessionId(null);
      } finally {
        polling = false;
        if (active) {
          timer = window.setTimeout(() => {
            void poll();
          }, 4_000);
        }
      }
    };

    void poll();

    return () => {
      active = false;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [pollingSessionId, appMode, paywallStatus?.deviceId]);

  useEffect(() => {
    if (appMode !== "unlocked") return;
    const timer = window.setInterval(() => {
      void attemptEntitlementRefresh();
    }, PAYWALL_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [appMode]);

  if (appMode === "loading") {
    return (
      <main className="app-shell paywall-shell">
        <div className="paywall-ambient" aria-hidden="true">
          <span className="paywall-orb orb-a" />
          <span className="paywall-orb orb-b" />
        </div>
        <section className="paywall-card paywall-enter paywall-loading-card">
          <p className="paywall-kicker">Trackr</p>
          <h1 className="paywall-title">Checking your access</h1>
          <p className="paywall-subtle">Getting Trackr ready.</p>
          <div className="paywall-loading-bar" aria-hidden="true" />
        </section>
      </main>
    );
  }

  if (appMode === "permissions") {
    return (
      <main className="app-shell paywall-shell">
        <div className="paywall-ambient" aria-hidden="true">
          <span className="paywall-orb orb-a" />
          <span className="paywall-orb orb-b" />
          <span className="paywall-orb orb-c" />
        </div>
        <section className="paywall-card paywall-enter">
          <div className="paywall-grid">
            <div className="paywall-main">
              <div className="paywall-tag-row">
                <p className="paywall-kicker">Trackr</p>
                <span className="paywall-chip">Permission required</span>
              </div>
          <h1 className="paywall-title">
            {backgroundTrackingSupported
              ? "Allow background input tracking"
              : "Trackr needs a supported desktop OS"}
          </h1>
          <p className="paywall-subtle">
            {backgroundTrackingSupported
              ? "Trackr stays blocked until macOS allows it to watch keyboard and mouse activity while other apps are focused."
              : "This build can only track global keyboard and mouse activity on macOS and Windows."}
          </p>
          {backgroundTrackingSupported ? (
            <div className="permission-warning" role="status">
              <strong>Tracking is currently off.</strong>
              <p>
                Trackr is not recording any keyboard or mouse activity yet. Nothing is tracked
                until Trackr is enabled in macOS Input Monitoring.
              </p>
            </div>
          ) : null}

          <div className="permission-status-list">
            <div
              className={`permission-status-card ${inputMonitoringGranted ? "ready" : "pending"}`}
            >
                  <div>
                    <strong>Input Monitoring</strong>
                    <small>System Settings &gt; Privacy &amp; Security &gt; Input Monitoring</small>
                  </div>
                  <span>{inputMonitoringGranted ? "On" : "Off"}</span>
                </div>
              </div>

          <ul className="paywall-benefits">
            <li>Click Request access to let macOS show the permission prompt.</li>
            <li>Enable Trackr in Input Monitoring if macOS opens Settings instead of the prompt.</li>
            <li>Trackr only starts tracking after Input Monitoring shows On.</li>
          </ul>

              <div className="paywall-actions">
                <button
                  type="button"
                  className="save-button paywall-cta"
                  onClick={() => void refreshTrackingAccess(true)}
                  disabled={requestingTrackingPermission || !backgroundTrackingSupported}
                >
                  {requestingTrackingPermission ? "Requesting..." : "Request access"}
                </button>
                <button
                  type="button"
                  className="save-button secondary paywall-secondary"
                  onClick={() => void relaunch()}
                  disabled={requestingTrackingPermission}
                >
                  Restart &amp; check
                </button>
          </div>
          <p className="paywall-meta">
            No activity is recorded before Trackr can capture keyboard and mouse input outside the
            app.
          </p>
        </div>

        <aside className="paywall-side">
          <p className="paywall-side-label">Why Trackr blocks here</p>
          <h2>Track the whole computer</h2>
          <p>
            Trackr measures activity from anywhere on the system, not just when its own window
            is focused.
          </p>
          <p>
            Until Input Monitoring is enabled, Trackr is not tracking and your timeline will stay
            empty.
          </p>
          <p>
            If Input Monitoring is already enabled and this screen does not clear, quit and
            reopen Trackr so macOS can reload the permission state.
          </p>
        </aside>
          </div>
          {trackingPermissionError ? (
            <p className="error inline-error">{trackingPermissionError}</p>
          ) : null}
        </section>
      </main>
    );
  }

  if (appMode === "locked") {
    return (
      <main className="app-shell paywall-shell">
        <div className="paywall-ambient" aria-hidden="true">
          <span className="paywall-orb orb-a" />
          <span className="paywall-orb orb-b" />
          <span className="paywall-orb orb-c" />
        </div>
        <section className="paywall-card paywall-enter">
          <div className="paywall-grid">
            <div className="paywall-main">
              <div className="paywall-tag-row">
                <p className="paywall-kicker">Trackr</p>
                <span className="paywall-chip">One-time unlock</span>
              </div>
              <h1 className="paywall-title">Own your focus dashboard</h1>
              <div className="paywall-preview-strip" aria-hidden="true">
                {LOCKED_PAYWALL_PREVIEW_BARS.map((bar, index) => (
                  <span
                    key={`${bar.tone}-${index}`}
                    className={`paywall-preview-bar ${bar.tone}`}
                    style={{ height: `${bar.height}%` }}
                  />
                ))}
              </div>
              <p className="paywall-subtle">
                A one-time payment unlocks full tracking, history, and settings on this device.
              </p>
              <ul className="paywall-benefits">
                <li>Live activity timeline and yearly history</li>
                <li>One payment, no subscription</li>
                <li>Use Trackr offline after setup</li>
              </ul>
              <div className="paywall-actions">
                <button
                  type="button"
                  className="save-button paywall-cta"
                  onClick={() => void launchCheckout()}
                  disabled={unlocking}
                >
                  {unlocking ? "Opening checkout..." : "Unlock now"}
                </button>
                {paywallStatus?.pendingSessionId ? (
                  <button
                    type="button"
                    className="save-button secondary paywall-secondary"
                    onClick={() => setPollingSessionId(paywallStatus.pendingSessionId)}
                  >
                    Check payment status
                  </button>
                ) : null}
              </div>
              {pollingMessage ? <p className="paywall-meta">{pollingMessage}</p> : null}
              {syncingEntitlement ? <p className="paywall-meta">Refreshing access...</p> : null}
            </div>
            <aside className="paywall-side">
              <p className="paywall-side-label">Lifetime access</p>
              <h2>Private. Fast. Yours.</h2>
              <p>
                Unlock once and keep using Trackr on this device, including when you're offline.
              </p>
              <p>Your activity data stays on this device, and the app stays simple to manage.</p>
            </aside>
          </div>
          {paywallError ? <p className="error inline-error">{paywallError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <UpdateChecker />
      <header className="top-header">
        <div>
          <p className="eyebrow">Trackr</p>
          <h1>Activity dashboard</h1>
          <p className="subtle">
            See your active and idle time throughout the day. Trackr updates automatically while
            it is running and background tracking stays available.
          </p>
        </div>
        <div className={`status-pill ${statusClass}`}>{statusLabel}</div>
      </header>

      <section className="metrics-row">
        <article className="metric-card">
          <span>{selectedDateLabel} active</span>
          <strong>{toHours(displayedDay?.activeMinutes ?? 0)}h</strong>
        </article>
        <article className="metric-card">
          <span>{selectedDateLabel} idle</span>
          <strong>{toHours(displayedDay?.idleMinutes ?? 0)}h</strong>
        </article>
        <article className="metric-card">
          <span>Days tracked</span>
          <strong>{storage?.persistedDayCount ?? 0}</strong>
        </article>
        <article className="metric-card">
          <span>Updated</span>
          <strong>
            {lastUpdated
              ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "--:--"}
          </strong>
        </article>
      </section>

      <section className="panel share-capture" ref={shareCaptureRef}>
        <div className="panel-heading panel-heading-share">
          <div>
            <h2>{selectedDateLabel} Timeline</h2>
            <p>
              Green shows active time in each 5-minute block. Red shows idle time. Sleep hours are
              excluded.
              {viewingToday ? " Gray shows future time." : ""}
            </p>
          </div>
          <div className="share-actions" data-html2canvas-ignore="true">
            <button
              className="share-icon-button"
              type="button"
              onClick={() => void shareToTarget("x")}
              disabled={sharingTarget !== null}
              aria-label="Share to X"
              title="Share to X"
            >
              <XIcon />
            </button>
            <button
              className="share-icon-button secondary"
              type="button"
              onClick={() => void shareToTarget("reddit")}
              disabled={sharingTarget !== null}
              aria-label="Share to Reddit"
              title="Share to Reddit"
            >
              <RedditIcon />
            </button>
          </div>
        </div>
        <div className="timeline" style={timelineStyle}>
          {timelineBuckets.map((bucket) => {
            const isFuture = bucket.index > nowBucket;
            const className = isFuture
              ? "timeline-cell future"
              : bucket.active
                ? "timeline-cell active"
                : "timeline-cell idle";
            const tooltip =
              bucket.monitoredMinutes === TIMELINE_BUCKET_MINUTES
                ? `${formatRange(bucket.index)} • ${bucket.activeMinutes}/${TIMELINE_BUCKET_MINUTES} active minutes`
                : `${formatRange(bucket.index)} • ${bucket.activeMinutes}/${bucket.monitoredMinutes} active monitored minutes`;
            return (
              <div
                key={bucket.index}
                className={className}
                onMouseEnter={(event) => showHoverTooltip(event, tooltip)}
                onMouseMove={moveHoverTooltip}
                onMouseLeave={hideHoverTooltip}
              />
            );
          })}
        </div>
        <div className="timeline-axis">
          {timelineAxisMinutes.map((minute, index) => (
            <span key={`${minute}-${index}`}>{minuteToLocalLabel(minute)}</span>
          ))}
        </div>
        <p className="share-caption" data-html2canvas-ignore="true">
          {shareMessage ??
            "Creates a screenshot of this panel, opens your selected site, and lets you paste the image."}
        </p>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Work History</h2>
          <p>
            Select a day to view its active and idle totals. Showing data through{" "}
            {formatIsoDate(today?.date)}.
          </p>
        </div>
        <div className="heatmap">
          <div className="month-row">
            {heatmapWeeks.monthLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
          <div className="heatmap-grid">
            {heatmapWeeks.weeks.map((week, weekIndex) => (
              <div className="heatmap-week" key={weekIndex}>
                {week.map((cell, dayIndex) => {
                  if (!cell) return <div className="heatmap-cell empty" key={dayIndex} />;
                  const tooltip = `${cell.date} • ${cell.activeMinutes} active minutes`;
                  const isSelected = cell.date === selectedDate;
                  return (
                    <div
                      key={dayIndex}
                      className={`heatmap-cell level-${cell.level} ${isSelected ? "selected" : ""}`}
                      onMouseEnter={(event) => showHoverTooltip(event, tooltip)}
                      onMouseMove={moveHoverTooltip}
                      onMouseLeave={hideHoverTooltip}
                      onClick={() => void selectDay(cell.date)}
                      role="button"
                      tabIndex={0}
                      aria-label={`Load ${cell.date}`}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void selectDay(cell.date);
                        }
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <p className="selection-meta">
          {selectingDay
            ? `Loading ${formatIsoDate(selectedDate)}...`
            : `Selected: ${formatIsoDate(displayedDay?.date)}`}
        </p>
        {daySelectionError ? <p className="error inline-error">{daySelectionError}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Sleep Window</h2>
          <p>
            Trackr pauses during this time. These hours are excluded from your timeline and menu
            bar progress.
          </p>
        </div>
        <div className="sleep-shell">
          <div className="sleep-window-card">
            <div className="sleep-window-header">
              <label className="sleep-toggle">
                <input
                  type="checkbox"
                  checked={sleepDraft.enabled}
                  onChange={(event) => updateSleepDraft({ enabled: event.target.checked })}
                />
                <span>Enable sleep window</span>
              </label>
              <p className="sleep-caption">
                {sleepDraft.enabled
                  ? `Current schedule: ${sleepDraft.startTime}-${sleepDraft.endTime}`
                  : "Sleep window is currently disabled."}
              </p>
            </div>
            <div className="sleep-controls">
              <label className="sleep-field">
                <span>Start</span>
                <input
                  type="time"
                  value={sleepDraft.startTime}
                  onChange={(event) => updateSleepDraft({ startTime: event.target.value })}
                />
              </label>
              <label className="sleep-field">
                <span>End</span>
                <input
                  type="time"
                  value={sleepDraft.endTime}
                  onChange={(event) => updateSleepDraft({ endTime: event.target.value })}
                />
              </label>
              <button
                className="save-button"
                type="button"
                onClick={() => void saveSleepWindow()}
                disabled={savingSleep || !sleepDirty}
              >
                {savingSleep ? "Saving..." : sleepDirty ? "Save Sleep Window" : "Saved"}
              </button>
            </div>
          </div>
          <div className="utility-card-stack">
            <div className="update-card">
              <h3>Startup</h3>
              <p className="settings-subtle">Resume Trackr automatically after you sign in.</p>
              <label className="startup-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(launchAtLoginEnabled)}
                  onChange={(event) => void setLaunchAtLogin(event.target.checked)}
                  disabled={launchAtLoginLoading || launchAtLoginSaving}
                />
                <span>
                  {launchAtLoginSaving
                    ? "Updating launch at login..."
                    : "Launch Trackr at login"}
                </span>
              </label>
              <p className="update-caption">
                {launchAtLoginLoading
                  ? "Checking your startup setting..."
                  : launchAtLoginEnabled
                    ? "Trackr will start automatically when you sign in. If tracking is already ready, it stays hidden in the tray."
                    : "Trackr only runs after you open it manually. Turn this on if you want it to restart after you sign in."}
              </p>
              <p className="settings-subtle startup-note">
                If Trackr still needs payment or tracking access, it opens the main window at
                login so you can see why tracking is blocked.
              </p>
              {launchAtLoginError ? <p className="error inline-error">{launchAtLoginError}</p> : null}
            </div>

          </div>
        </div>

        <div className="settings-grid">
          <div className="settings-card">
            <h3>Appearance</h3>
            <p className="settings-subtle">Choose a color scheme for the dashboard.</p>
            <div className="theme-options" role="radiogroup" aria-label="Color scheme">
              {COLOR_THEME_OPTIONS.map((theme) => {
                const selected = colorTheme === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    className={`theme-option ${selected ? "selected" : ""}`}
                    onClick={() => setColorTheme(theme.id)}
                    aria-pressed={selected}
                  >
                    <span className="theme-swatches" aria-hidden="true">
                      {theme.swatches.map((swatch) => (
                        <span
                          key={`${theme.id}-${swatch}`}
                          className="theme-swatch"
                          style={{ background: swatch }}
                        />
                      ))}
                    </span>
                    <span className="theme-copy">
                      <strong>{theme.label}</strong>
                      <small>{theme.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="settings-card tracking-info">
            <h3>How Trackr measures activity</h3>
            <p>
              Trackr checks for keyboard and mouse activity every minute. Minutes with enough
              activity are marked active. Minutes without enough activity are marked idle.
            </p>
            <p>
              Trackr records nothing until background tracking is ready, and it only keeps tracking
              while the app is still running.
            </p>
            <p>
              Time inside your sleep window is excluded from the timeline, active and idle totals,
              and menu bar progress.
            </p>
            <p>
              Your data stays on this device, and the dashboard updates automatically.
            </p>
          </div>
        </div>
        {sleepSaveError ? <p className="error inline-error">{sleepSaveError}</p> : null}
      </section>

      {hoverTooltip
        ? createPortal(
            <div
              className="hover-tooltip"
              style={{ left: hoverTooltip.left, top: hoverTooltip.top }}
            >
              {hoverTooltip.text}
            </div>,
            document.body,
          )
        : null}

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
};

export default App;
