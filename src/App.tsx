import { invoke } from "@tauri-apps/api/core";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import HoverTooltip, { type HoverTooltipHandle } from "./HoverTooltip";
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
  appTimeline?: (string | null)[];
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

type AppRuntimeProfile = {
  startedHidden: boolean;
};

type HeatmapCell = HeatmapDay & { level: 0 | 1 | 2 | 3 | 4 };
type ShareTarget = "x" | "reddit";
type ThemeMode = "light" | "dark";

const HEATMAP_DAYS = 365;
const TIMELINE_BUCKET_MINUTES = 5;
const DENSITY_BUCKET_MINUTES = 30;
const MINUTES_PER_DAY = 1_440;
const DEFAULT_SLEEP_START_MINUTE = 23 * 60;
const DEFAULT_SLEEP_END_MINUTE = 7 * 60;
const DASHBOARD_PRIMARY_REFRESH_MS = 30_000;
const DASHBOARD_SUPPLEMENTAL_REFRESH_MS = 5 * 60_000;
const CHECKOUT_POLL_INITIAL_DELAY_MS = 4_000;
const CHECKOUT_POLL_MAX_DELAY_MS = 20_000;
const CHECKOUT_POLL_MAX_ELAPSED_MS = 10 * 60 * 1000;
const PAYWALL_LOCKED_ERROR = "PAYWALL_LOCKED";
const INPUT_MONITORING_REQUIRED_ERROR = "INPUT_MONITORING_REQUIRED";
const THEME_STORAGE_KEY = "trackr-theme-mode";
const PAYWALL_API_BASE_URL = (
  (import.meta.env.VITE_PAYWALL_API_BASE_URL as string | undefined)?.trim() ||
  (import.meta.env.DEV ? "http://localhost:3010" : "")
).replace(/\/$/, "");
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() ?? "0.1.0";
const PrivateTimelineIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M7 11V8a5 5 0 0 1 10 0v3" />
    <path d="M6 11h12v9H6z" />
    <path d="M12 15v2" />
  </svg>
);

const MenuBarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 5h16v11H4z" />
    <path d="M8 20h8" />
    <path d="M10 16v4" />
    <path d="M14 16v4" />
    <path d="M7 8h.01" />
    <path d="M10 8h.01" />
    <path d="M13 8h.01" />
  </svg>
);

const FiveMinuteIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M9 2h6" />
    <path d="M12 8v5l3 2" />
    <path d="M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
  </svg>
);

const LocalArchiveIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 7h14l1 4H4z" />
    <path d="M5 11h14v8H5z" />
    <path d="M9 15h6" />
  </svg>
);

const FocusScoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 14a8 8 0 0 1 16 0" />
    <path d="M7 18h10" />
    <path d="m12 14 4-4" />
    <path d="M12 14h.01" />
  </svg>
);

const QuietDesignIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 3 5 6v5c0 4.5 2.8 7.6 7 10 4.2-2.4 7-5.5 7-10V6z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const PAYWALL_CAPABILITIES = [
  { label: "Private timeline", Icon: PrivateTimelineIcon },
  { label: "Menu bar native", Icon: MenuBarIcon },
  { label: "Five minute slices", Icon: FiveMinuteIcon },
  { label: "Local archive", Icon: LocalArchiveIcon },
  { label: "Focus score", Icon: FocusScoreIcon },
  { label: "Quiet by design", Icon: QuietDesignIcon },
] as const;
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

const formatHeaderDateTime = (isoDate?: string | null, updatedAt?: Date | null) => {
  const date = isoDate ? parseLocalDate(isoDate) : new Date();
  const dateLabel = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeLabel = (updatedAt ?? new Date()).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${dateLabel} / ${timeLabel}`;
};

const buildTooltipPosition = (
  clientX: number,
  clientY: number,
  tooltipWidth = 300,
  tooltipHeight = 72,
) => {
  const margin = 12;
  const estimatedWidth = tooltipWidth;
  const estimatedHeight = tooltipHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const left = Math.max(
    margin,
    Math.min(clientX - estimatedWidth * 0.5, viewportWidth - estimatedWidth - margin),
  );
  const top = Math.max(
    margin,
    Math.min(clientY - estimatedHeight - 18, viewportHeight - estimatedHeight - margin),
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

const formatMinuteRange = (startMinute: number, durationMinutes: number) =>
  `${minuteToLocalLabel(startMinute)}-${minuteToLocalLabel(startMinute + durationMinutes)}`;

const previewAppNameForMinute = (minute: number, daySeed: number) => {
  const apps = ["Figma", "Slack", "VS Code", "Chrome", "Notion"];
  const appIndex = Math.abs(Math.floor((minute / 37 + daySeed) % apps.length));
  return apps[appIndex];
};

const shareTargetLabel = (target: ShareTarget) => (target === "x" ? "X" : "Reddit");

const initialThemeMode = (): ThemeMode => {
  if (typeof window === "undefined") return "light";
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

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
  let payload: unknown = {};

  if (rawText) {
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      if (response.ok) {
        throw new Error("Received an invalid response from the paywall server.");
      }
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: string }).error ?? "Request failed")
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as TResponse;
};

const hasTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const localIsoDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const previewSleepWindow: SleepWindow = {
  enabled: true,
  startMinute: DEFAULT_SLEEP_START_MINUTE,
  endMinute: DEFAULT_SLEEP_END_MINUTE,
};

const buildPreviewDay = (dateKey = localIsoDate()): TodayTimeline => {
  const now = new Date();
  const todayKey = localIsoDate(now);
  const isToday = dateKey === todayKey;
  const lastObservedMinute = isToday
    ? now.getHours() * 60 + now.getMinutes()
    : MINUTES_PER_DAY - 1;
  const parsedDate = parseLocalDate(dateKey);
  const daySeed = parsedDate.getDate() + parsedDate.getMonth() * 7;
  const timeline = new Array<number>(MINUTES_PER_DAY).fill(0);
  const appTimeline = new Array<string | null>(MINUTES_PER_DAY).fill(null);
  let monitoredMinutes = 0;
  let activeMinutes = 0;

  for (let minute = 0; minute <= lastObservedMinute; minute += 1) {
    if (isMinuteInSleepWindow(minute, previewSleepWindow)) {
      continue;
    }

    monitoredMinutes += 1;
    const workdayMinute = minute >= 8 * 60 && minute <= 18 * 60 + 30;
    const focusWave = Math.sin((minute + daySeed * 17) * 0.037);
    const meetingWave = Math.cos((minute + daySeed * 9) * 0.011);
    const isActive = workdayMinute && focusWave + meetingWave > -0.35;

    appTimeline[minute] = previewAppNameForMinute(minute, daySeed);

    if (isActive) {
      timeline[minute] = 1;
      activeMinutes += 1;
    }
  }

  const currentMinute = Math.min(lastObservedMinute, MINUTES_PER_DAY - 1);

  return {
    date: dateKey,
    timeline,
    appTimeline,
    activeMinutes,
    idleMinutes: Math.max(0, monitoredMinutes - activeMinutes),
    currentlyActive: isToday && timeline[currentMinute] === 1,
    sleepMode: isToday && isMinuteInSleepWindow(currentMinute, previewSleepWindow),
    sleepWindow: previewSleepWindow,
    listenerError: null,
  };
};

const buildPreviewHeatmap = (days: number): HeatmapDay[] => {
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const day = buildPreviewDay(localIsoDate(date));
    return {
      date: day.date,
      activeMinutes: day.activeMinutes,
    };
  });
};

const previewInvoke = async <TResponse,>(
  command: string,
  args?: Record<string, unknown>,
): Promise<TResponse> => {
  const today = buildPreviewDay();

  switch (command) {
    case "get_app_runtime_profile":
      return { startedHidden: false } as TResponse;
    case "get_tracking_permission_status":
    case "request_tracking_permission_access":
      return {
        supported: true,
        inputMonitoringGranted: true,
        allGranted: true,
      } as TResponse;
    case "get_paywall_status":
      return {
        status: "unlocked",
        deviceId: "browser-preview",
        entitlement: null,
        lastSyncAtEpochMs: Date.now(),
        nextSyncAtEpochMs: null,
        pendingSessionId: null,
        reason: null,
      } as TResponse;
    case "get_today_timeline":
      return today as TResponse;
    case "get_day_timeline":
      return buildPreviewDay(String(args?.date ?? today.date)) as TResponse;
    case "get_heatmap": {
      const days = Number(args?.days ?? HEATMAP_DAYS);
      return buildPreviewHeatmap(Number.isFinite(days) ? days : HEATMAP_DAYS) as TResponse;
    }
    case "get_storage_status":
      return {
        storePath: "browser-preview",
        persistedDayCount: HEATMAP_DAYS,
        storeFileExists: false,
        storeFileSizeBytes: 0,
        lastPersistedAtEpochMs: Date.now(),
      } as TResponse;
    case "set_sleep_window":
      return {
        enabled: Boolean(args?.enabled),
        startMinute: Number(args?.startMinute ?? DEFAULT_SLEEP_START_MINUTE),
        endMinute: Number(args?.endMinute ?? DEFAULT_SLEEP_END_MINUTE),
      } as TResponse;
    case "set_pending_checkout_session":
    case "apply_entitlement":
      return undefined as TResponse;
    default:
      throw new Error(`No browser preview handler for ${command}.`);
  }
};

const invokeApp = async <TResponse,>(
  command: string,
  args?: Record<string, unknown>,
): Promise<TResponse> => {
  if (hasTauriRuntime()) {
    return invoke<TResponse>(command, args);
  }

  return previewInvoke<TResponse>(command, args);
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
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = useState<boolean | null>(null);
  const [launchAtLoginLoading, setLaunchAtLoginLoading] = useState(true);
  const [launchAtLoginSaving, setLaunchAtLoginSaving] = useState(false);
  const [launchAtLoginError, setLaunchAtLoginError] = useState<string | null>(null);
  const [sharingTarget, setSharingTarget] = useState<ShareTarget | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const [runtimeProfile, setRuntimeProfile] = useState<AppRuntimeProfile | null>(null);
  const shareCaptureRef = useRef<HTMLElement | null>(null);
  const hoverTooltipRef = useRef<HoverTooltipHandle | null>(null);
  const hoveredTooltipTargetRef = useRef<HTMLElement | null>(null);
  const hoveredTooltipTextRef = useRef<string | null>(null);
  const autoPermissionRequestAttemptedRef = useRef(false);
  const dashboardSupplementalRefreshAtRef = useRef(0);
  const appBootstrappedRef = useRef(false);
  const mountedRef = useRef(true);
  const paywallBootstrapPromiseRef = useRef<Promise<void> | null>(null);

  const refreshPaywallStatus = async () => invokeApp<PaywallStatus>("get_paywall_status");
  const refreshTrackingPermissionStatus = async () =>
    invokeApp<TrackingPermissionStatus>("get_tracking_permission_status");
  const requestTrackingPermissionAccess = async () =>
    invokeApp<TrackingPermissionStatus>("request_tracking_permission_access");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    const syncPageVisibility = () => {
      setPageVisible(document.visibilityState !== "hidden");
    };

    document.addEventListener("visibilitychange", syncPageVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncPageVisibility);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenFocusChange: (() => void) | null = null;

    if (!hasTauriRuntime()) {
      const syncBrowserFocus = () => {
        if (!active) return;
        setWindowFocused(document.hasFocus());
      };

      window.addEventListener("focus", syncBrowserFocus);
      window.addEventListener("blur", syncBrowserFocus);
      syncBrowserFocus();

      return () => {
        active = false;
        window.removeEventListener("focus", syncBrowserFocus);
        window.removeEventListener("blur", syncBrowserFocus);
      };
    }

    const currentWindow = getCurrentWindow();

    const syncWindowFocus = async () => {
      try {
        const focused = await currentWindow.isFocused();
        if (!active) return;
        setWindowFocused(focused);
      } catch (windowFocusError) {
        console.warn("Trackr window focus fallback", windowFocusError);
        if (!active) return;
        setWindowFocused(document.hasFocus());
      }
    };

    void syncWindowFocus();
    void currentWindow
      .onFocusChanged(({ payload }) => {
        if (!active) return;
        setWindowFocused(payload);
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        unlistenFocusChange = unlisten;
      })
      .catch((windowFocusListenError) => {
        console.warn("Trackr focus listener fallback", windowFocusListenError);
      });

    return () => {
      active = false;
      unlistenFocusChange?.();
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadRuntimeProfile = async () => {
      try {
        const profile = await invokeApp<AppRuntimeProfile>("get_app_runtime_profile");
        if (!active) return;
        setRuntimeProfile(profile);
      } catch (runtimeProfileError) {
        console.warn("Trackr runtime profile fallback", runtimeProfileError);
        if (!active) return;
        setRuntimeProfile({ startedHidden: false });
      }
    };

    void loadRuntimeProfile();

    return () => {
      active = false;
    };
  }, []);

  const appForeground = pageVisible && windowFocused;
  const shouldDeferForegroundBoot = runtimeProfile?.startedHidden === true && !appForeground;

  const refreshLaunchAtLogin = useEffectEvent(async () => {
    try {
      const enabled = hasTauriRuntime() ? await isAutostartEnabled() : false;
      if (!mountedRef.current) return;
      setLaunchAtLoginEnabled(enabled);
      setLaunchAtLoginError(null);
    } catch (launchAtLoginStatusError) {
      if (!mountedRef.current) return;
      setLaunchAtLoginError(friendlyLaunchAtLoginErrorMessage(launchAtLoginStatusError));
    } finally {
      if (!mountedRef.current) return;
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

  const syncPendingCheckoutState = (status: PaywallStatus) => {
    setPollingSessionId(status.pendingSessionId);
    setPollingMessage(
      status.pendingSessionId ? "Finish payment in your browser to continue." : null,
    );
  };

  const bootstrapPaywallStatus = useEffectEvent(async () => {
    if (paywallBootstrapPromiseRef.current) {
      return paywallBootstrapPromiseRef.current;
    }

    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        let status = await refreshPaywallStatus();
        if (!mountedRef.current) return;

        setPaywallError(null);
        setPaywallStatus(status);
        syncPendingCheckoutState(status);

        setAppMode(status.status === "unlocked" ? "unlocked" : "locked");
      } catch (paywallInitError) {
        if (!mountedRef.current) return;
        setPaywallError(
          friendlyUserErrorMessage(paywallInitError, "Trackr couldn't verify access right now."),
        );
        setAppMode("locked");
      }
    })().finally(() => {
      if (paywallBootstrapPromiseRef.current === task) {
        paywallBootstrapPromiseRef.current = null;
      }
    });

    paywallBootstrapPromiseRef.current = task;
    return task;
  });

  const refreshTrackingAccess = useEffectEvent(async (prompt: boolean) => {
    if (prompt) {
      setRequestingTrackingPermission(true);
    }

    try {
      const status = prompt
        ? await requestTrackingPermissionAccess()
        : await refreshTrackingPermissionStatus();
      if (!mountedRef.current) return false;

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
      if (!mountedRef.current) return false;
      setTrackingPermissionError(
        friendlyUserErrorMessage(
          trackingAccessError,
          "Trackr couldn't verify background tracking access.",
        ),
      );
      setAppMode("permissions");
      return false;
    } finally {
      if (prompt && mountedRef.current) {
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
      if (!mountedRef.current) return true;
      enterPermissionMode(status);
    } catch (trackingAccessError) {
      if (!mountedRef.current) return true;
      const fallbackStatus = trackingPermissionStatus ?? {
        supported: false,
        inputMonitoringGranted: false,
        allGranted: false,
      };
      enterPermissionMode(
        {
          ...fallbackStatus,
          supported: fallbackStatus.supported,
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

  useEffect(() => {
    if (!runtimeProfile || appBootstrappedRef.current || shouldDeferForegroundBoot) return;
    appBootstrappedRef.current = true;

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
            if (active && mountedRef.current) {
              setRequestingTrackingPermission(false);
            }
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
  }, [runtimeProfile, shouldDeferForegroundBoot, bootstrapPaywallStatus]);

  useEffect(() => {
    if (!runtimeProfile || shouldDeferForegroundBoot) return;
    void refreshLaunchAtLogin();
  }, [runtimeProfile, shouldDeferForegroundBoot, refreshLaunchAtLogin]);

  useEffect(() => {
    if (appMode !== "unlocked") {
      dashboardSupplementalRefreshAtRef.current = 0;
    }
  }, [appMode]);

  useEffect(() => {
    if (appMode !== "permissions" || !appForeground) return;
    if (trackingPermissionStatus?.supported === false) return;

    let active = true;
    let timer: number | null = null;
    let polling = false;
    let shouldReschedule = true;
    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const status = await refreshTrackingPermissionStatus();
        if (!active) return;

        setTrackingPermissionStatus(status);
        if (!status.supported) {
          shouldReschedule = false;
          enterPermissionMode(status);
          return;
        }
        if (status.allGranted) {
          setTrackingPermissionError(null);
          setAppMode("loading");
          shouldReschedule = false;
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
        if (active && shouldReschedule) {
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
  }, [appMode, appForeground, trackingPermissionStatus?.supported]);

  useEffect(() => {
    if (appMode !== "unlocked" || !appForeground) return;
    let active = true;
    let timer: number | null = null;
    let polling = false;

    const refresh = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const shouldRefreshSupplemental =
          dashboardSupplementalRefreshAtRef.current === 0 ||
          Date.now() >= dashboardSupplementalRefreshAtRef.current;

        const todayData = await invokeApp<TodayTimeline>("get_today_timeline");
        if (!active) return;

        setToday(todayData);
        setError(friendlyListenerErrorMessage(todayData.listenerError));
        setSelectedDate((current) => current ?? todayData.date);
        setSelectedDay((current) => {
          if (!current) return todayData;
          if (current.date === todayData.date) return todayData;
          return current;
        });

        if (shouldRefreshSupplemental) {
          const [heatmapData, storageData] = await Promise.all([
            invokeApp<HeatmapDay[]>("get_heatmap", { days: HEATMAP_DAYS }),
            invokeApp<StorageStatus>("get_storage_status"),
          ]);
          if (!active) return;

          setHeatmap(heatmapData);
          setStorage(storageData);
          dashboardSupplementalRefreshAtRef.current = Date.now() + DASHBOARD_SUPPLEMENTAL_REFRESH_MS;
        }

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
          }, DASHBOARD_PRIMARY_REFRESH_MS);
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
  }, [appMode, appForeground]);

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
  const headerDateTimeLabel = formatHeaderDateTime(displayedDay?.date, lastUpdated);
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
    const appTimeline = displayedDay?.appTimeline ?? [];

    return Array.from({ length: MINUTES_PER_DAY / TIMELINE_BUCKET_MINUTES }, (_, index) => {
      const bucketStartMinute = index * TIMELINE_BUCKET_MINUTES;
      let activeMinutes = 0;
      let sleepMinutes = 0;
      const appMinuteCounts = new Map<string, number>();

      for (let minute = bucketStartMinute; minute < bucketStartMinute + TIMELINE_BUCKET_MINUTES; minute += 1) {
        if (isMinuteInSleepWindow(minute, effectiveSleepWindow)) {
          sleepMinutes += 1;
          continue;
        }

        if ((raw[minute] ?? 0) > 0) {
          activeMinutes += 1;
        }

        const appName = appTimeline[minute]?.trim();
        if (appName) {
          appMinuteCounts.set(appName, (appMinuteCounts.get(appName) ?? 0) + 1);
        }
      }

      const topApp = Array.from(appMinuteCounts.entries()).sort(
        ([appA, minutesA], [appB, minutesB]) =>
          minutesB - minutesA || appA.localeCompare(appB),
      )[0];
      const monitoredMinutes = TIMELINE_BUCKET_MINUTES - sleepMinutes;
      return {
        index,
        bucketStartMinute,
        active: activeMinutes > 0,
        activeMinutes,
        monitoredMinutes,
        topAppName: topApp?.[0] ?? null,
        topAppMinutes: topApp?.[1] ?? 0,
      };
    }).filter((bucket) => bucket.monitoredMinutes > 0);
  }, [displayedDay?.timeline, displayedDay?.appTimeline, effectiveSleepWindow]);

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

  const densityBuckets = useMemo(() => {
    const raw = displayedDay?.timeline ?? [];

    return Array.from({ length: MINUTES_PER_DAY / DENSITY_BUCKET_MINUTES }, (_, index) => {
      const bucketStartMinute = index * DENSITY_BUCKET_MINUTES;
      let activeMinutes = 0;
      let monitoredMinutes = 0;

      for (
        let minute = bucketStartMinute;
        minute < bucketStartMinute + DENSITY_BUCKET_MINUTES;
        minute += 1
      ) {
        if (isMinuteInSleepWindow(minute, effectiveSleepWindow)) {
          continue;
        }

        monitoredMinutes += 1;
        if ((raw[minute] ?? 0) > 0) {
          activeMinutes += 1;
        }
      }

      return {
        index,
        bucketStartMinute,
        activeMinutes,
        monitoredMinutes,
        density: monitoredMinutes > 0 ? activeMinutes / monitoredMinutes : 0,
      };
    }).filter((bucket) => bucket.monitoredMinutes > 0);
  }, [displayedDay?.timeline, effectiveSleepWindow]);

  const densityStyle = useMemo(
    () =>
      ({
        gridTemplateColumns: `repeat(${Math.max(densityBuckets.length, 1)}, minmax(0, 1fr))`,
      }) as CSSProperties,
    [densityBuckets.length],
  );

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
  const nowMinuteOfDay = viewingToday
    ? new Date().getHours() * 60 + new Date().getMinutes()
    : Number.POSITIVE_INFINITY;
  const displayedMonitoredMinutes =
    (displayedDay?.activeMinutes ?? 0) + (displayedDay?.idleMinutes ?? 0);
  const displayedDensityPercent =
    displayedMonitoredMinutes > 0
      ? Math.round(((displayedDay?.activeMinutes ?? 0) / displayedMonitoredMinutes) * 100)
      : 0;

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
      const dayData = await invokeApp<TodayTimeline>("get_day_timeline", { date });
      if (!mountedRef.current) return;
      setSelectedDay(dayData);
    } catch (selectionError) {
      if (await handleTrackingAccessRequired(selectionError)) {
        return;
      }
      if (!mountedRef.current) return;
      setDaySelectionError(
        friendlyUserErrorMessage(selectionError, `Couldn't load ${formatIsoDate(date)}.`),
      );
    } finally {
      if (mountedRef.current) {
        setSelectingDay(false);
      }
    }
  };

  const saveSleepWindow = async (draft: SleepSettingsDraft = sleepDraft) => {
    const startMinute = clockToMinute(draft.startTime);
    const endMinute = clockToMinute(draft.endTime);

    if (startMinute === null || endMinute === null) {
      setSleepSaveError("Please use valid 24-hour times for the sleep window.");
      return;
    }

    setSavingSleep(true);
    setSleepSaveError(null);
    try {
      const saved = await invokeApp<SleepWindow>("set_sleep_window", {
        enabled: draft.enabled,
        startMinute,
        endMinute,
      });
      if (!mountedRef.current) return;
      setSleepDraft({
        enabled: saved.enabled,
        startTime: minuteToClock(saved.startMinute),
        endTime: minuteToClock(saved.endMinute),
      });
      setSleepDirty(false);

      const [todayData, heatmapData, storageData] = await Promise.all([
        invokeApp<TodayTimeline>("get_today_timeline"),
        invokeApp<HeatmapDay[]>("get_heatmap", { days: HEATMAP_DAYS }),
        invokeApp<StorageStatus>("get_storage_status"),
      ]);
      if (!mountedRef.current) return;
      setToday(todayData);
      setHeatmap(heatmapData);
      setStorage(storageData);
      setError(friendlyListenerErrorMessage(todayData.listenerError));
      setLastUpdated(new Date());
      dashboardSupplementalRefreshAtRef.current = Date.now() + DASHBOARD_SUPPLEMENTAL_REFRESH_MS;
    } catch (saveError) {
      if (await handleTrackingAccessRequired(saveError)) {
        return;
      }
      if (!mountedRef.current) return;
      setSleepSaveError(
        friendlyUserErrorMessage(saveError, "Couldn't save your sleep window."),
      );
    } finally {
      if (mountedRef.current) {
        setSavingSleep(false);
      }
    }
  };

  const setSleepWindowEnabled = (enabled: boolean) => {
    const nextDraft = { ...sleepDraft, enabled };
    setSleepDraft(nextDraft);
    setSleepDirty(true);
    setSleepSaveError(null);
    void saveSleepWindow(nextDraft);
  };

  const hideHoverTooltip = () => {
    hoveredTooltipTargetRef.current = null;
    hoveredTooltipTextRef.current = null;
    hoverTooltipRef.current?.hide();
  };

  const handleDelegatedMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-tooltip]",
    );
    if (target) {
      const text = target.dataset.tooltip!;
      const appName = target.dataset.appName;
      const appMinutes = Number(target.dataset.appMinutes ?? 0);
      const tooltipKey = `${text}|${appName ?? ""}|${appMinutes || ""}`;
      if (hoveredTooltipTargetRef.current !== target || hoveredTooltipTextRef.current !== tooltipKey) {
        hoveredTooltipTargetRef.current = target;
        hoveredTooltipTextRef.current = tooltipKey;
        hoverTooltipRef.current?.show(text, event.clientX, event.clientY, {
          appName,
          appMinutes: Number.isFinite(appMinutes) ? appMinutes : 0,
        });
        return;
      }
      hoverTooltipRef.current?.move(event.clientX, event.clientY);
    } else {
      hideHoverTooltip();
    }
  };

  const setLaunchAtLogin = useEffectEvent(async (nextEnabled: boolean) => {
    const previousValue = launchAtLoginEnabled ?? false;

    setLaunchAtLoginSaving(true);
    setLaunchAtLoginError(null);
    setLaunchAtLoginEnabled(nextEnabled);

    try {
      if (hasTauriRuntime()) {
        if (nextEnabled) {
          await enableAutostart();
        } else {
          await disableAutostart();
        }
      }
      const enabled = hasTauriRuntime() ? await isAutostartEnabled() : nextEnabled;
      if (!mountedRef.current) return;
      setLaunchAtLoginEnabled(enabled);
    } catch (launchAtLoginUpdateError) {
      if (!mountedRef.current) return;
      setLaunchAtLoginEnabled(previousValue);
      setLaunchAtLoginError(friendlyLaunchAtLoginErrorMessage(launchAtLoginUpdateError));
    } finally {
      if (mountedRef.current) {
        setLaunchAtLoginSaving(false);
      }
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

    const { default: html2canvas } = await import("html2canvas");
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
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
      setShareMessage(`${action} ${shareTargetLabel(target)} opened in your browser.`);
    } catch (shareError) {
      if (!mountedRef.current) return;
      console.error("Trackr share error", shareError);
      setShareMessage(`Share failed: ${String(shareError)}`);
    } finally {
      if (mountedRef.current) {
        setSharingTarget(null);
      }
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
      if (!mountedRef.current) return;
      await invokeApp("set_pending_checkout_session", { sessionId: response.sessionId });
      if (!mountedRef.current) return;
      setPollingSessionId(response.sessionId);
      setPaywallStatus((current) =>
        current ? { ...current, pendingSessionId: response.sessionId } : current,
      );
      setPollingMessage("Checkout opened in your browser. Finish payment, then return to Trackr.");
      await openUrl(response.checkoutUrl);
    } catch (checkoutError) {
      if (!mountedRef.current) return;
      setPaywallError(
        friendlyUserErrorMessage(checkoutError, "Couldn't start checkout right now."),
      );
    } finally {
      if (mountedRef.current) {
        setUnlocking(false);
      }
    }
  };


  useEffect(() => {
    if (!pollingSessionId || appMode === "unlocked" || !paywallStatus?.deviceId) return;
    if (!appForeground) return;

    let active = true;
    let timer: number | null = null;
    let polling = false;
    let shouldReschedule = true;
    const startedAt = Date.now();
    let retryCount = 0;

    const stopPolling = (message: string) => {
      setPollingMessage(message);
      setPollingSessionId(null);
      shouldReschedule = false;
    };

    const scheduleNextPoll = (delayMs: number) => {
      if (!active) return;
      timer = window.setTimeout(() => {
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (!active || polling) return;
      if (!appForeground) return;
      if (Date.now() - startedAt > CHECKOUT_POLL_MAX_ELAPSED_MS) {
        stopPolling("Checkout is taking longer than expected. Click Check payment status to try again.");
        return;
      }

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
          retryCount += 1;
          return;
        }
        if (result.status === "expired") {
          setPollingMessage("Your checkout session expired. Start checkout again.");
          shouldReschedule = false;
          setPollingSessionId(null);
          await invokeApp("set_pending_checkout_session", { sessionId: null });
          if (!active) return;
          setPaywallStatus((current) =>
            current ? { ...current, pendingSessionId: null } : current,
          );
          return;
        }

        await invokeApp<PaywallStatus>("apply_entitlement", { entitlement: result.entitlement });
        await invokeApp("set_pending_checkout_session", { sessionId: null });
        const unlockedStatus = await refreshPaywallStatus();
        if (!active) return;

        shouldReschedule = false;
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
          shouldReschedule = false;
          setPollingSessionId(null);
          return;
        }

        const message = parseErrorMessage(pollError);
        if (/Failed to fetch|NetworkError|network request/i.test(message)) {
          setPaywallError(null);
          setPollingMessage("Confirming your payment...");
          retryCount += 1;
          return;
        }

        setPaywallError(
          friendlyUserErrorMessage(pollError, "Trackr couldn't finish unlocking automatically."),
        );
        setPollingMessage("Trackr couldn't finish unlocking automatically.");
        shouldReschedule = false;
        setPollingSessionId(null);
      } finally {
        polling = false;
        if (active && shouldReschedule) {
          const delayMs = Math.min(
            CHECKOUT_POLL_INITIAL_DELAY_MS + retryCount * 2_000,
            CHECKOUT_POLL_MAX_DELAY_MS,
          );
          scheduleNextPoll(delayMs);
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
  }, [pollingSessionId, appMode, paywallStatus?.deviceId, appForeground]);

  if (appMode === "loading") {
    return (
      <main className="app-shell paywall-shell" data-theme="dark">
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
      <main className="app-shell paywall-shell" data-theme="dark">
        <div className="paywall-ambient" aria-hidden="true">
          <span className="paywall-orb orb-a" />
          <span className="paywall-orb orb-b" />
          <span className="paywall-orb orb-c" />
        </div>
        <section className="paywall-card paywall-enter">
          <div className="paywall-grid">
            <div className="paywall-main">
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
      <main className="app-shell paywall-shell paywall-shell-hero" data-theme="dark">
        <section className="paywall-hero paywall-enter">
          <h1 className="paywall-title paywall-title-hero">Private Mac activity tracking.</h1>
          <p className="paywall-subtle paywall-hero-copy">
            Trackr turns on-device keyboard and pointer activity into a calm local timeline, so
            focus, idle drift, and daily rhythm stay easy to read.
          </p>
          <div className="paywall-actions paywall-hero-actions">
            <button
              type="button"
              className="paywall-hero-button paywall-hero-button-primary"
              onClick={() => void launchCheckout()}
              disabled={unlocking}
            >
              {unlocking ? "Opening checkout..." : "Unlock Now"}
            </button>
            {paywallStatus?.pendingSessionId ? (
              <button
                type="button"
                className="paywall-hero-button paywall-hero-button-secondary"
                onClick={() => setPollingSessionId(paywallStatus.pendingSessionId)}
              >
                Check Payment
              </button>
            ) : (
              <span className="paywall-price-note">Lifetime access / $4.99</span>
            )}
          </div>
          {pollingMessage ? <p className="paywall-meta paywall-hero-meta">{pollingMessage}</p> : null}
          {paywallError ? <p className="error inline-error paywall-hero-error">{paywallError}</p> : null}
          <p className="paywall-hero-footnote">macOS 11+ / local history / private by default</p>
        </section>
        <div className="paywall-feature-strip" aria-label="Trackr highlights">
          <div className="paywall-feature-track">
            {PAYWALL_CAPABILITIES.map(({ label, Icon }) => (
              <span key={`primary-${label}`} className="paywall-feature-item">
                <span className="paywall-feature-glyph" aria-hidden="true">
                  <Icon />
                </span>
                {label}
              </span>
            ))}
            {PAYWALL_CAPABILITIES.map(({ label, Icon }) => (
              <span key={`mirror-${label}`} className="paywall-feature-item" aria-hidden="true">
                <span className="paywall-feature-glyph">
                  <Icon />
                </span>
                {label}
              </span>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell" data-theme={themeMode}>
      <UpdateChecker enabled={hasTauriRuntime() && !shouldDeferForegroundBoot && appForeground} />
      <header className="top-header">
        <div>
          <h1>{selectedDateLabel}</h1>
          <p className="header-subtitle">{headerDateTimeLabel}</p>
        </div>
        <div className="theme-segmented" aria-label="Color mode">
          {(["light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={themeMode === mode ? "selected" : ""}
              onClick={() => setThemeMode(mode)}
            >
              {mode === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </header>

      <section className="metrics-row">
        <article className="metric-card">
          <span>Focus score</span>
          <strong>{displayedDensityPercent}%</strong>
        </article>
        <article className="metric-card">
          <span>Today active</span>
          <strong>{toHours(displayedDay?.activeMinutes ?? 0)}h</strong>
        </article>
        <article className="metric-card">
          <span>Today idle</span>
          <strong>{toHours(displayedDay?.idleMinutes ?? 0)}h</strong>
        </article>
        <article className="metric-card">
          <span>Days Tracked</span>
          <strong>{storage?.persistedDayCount ?? 0}</strong>
        </article>
      </section>

      <section className="panel share-capture" ref={shareCaptureRef}>
        <div className="panel-heading panel-heading-share">
          <h2>{selectedDateLabel} Timeline</h2>
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
        <div
          className="timeline"
          style={timelineStyle}
          onMouseMove={handleDelegatedMouseMove}
          onMouseLeave={hideHoverTooltip}
        >
          {timelineBuckets.map((bucket) => {
            const isFuture = bucket.index > nowBucket;
            const className = isFuture
              ? "timeline-cell future"
              : bucket.active
                ? "timeline-cell active"
                : "timeline-cell idle";
            const tooltip =
              bucket.monitoredMinutes === TIMELINE_BUCKET_MINUTES
                ? `${formatRange(bucket.index)}\n${bucket.activeMinutes}/${TIMELINE_BUCKET_MINUTES} active minutes`
                : `${formatRange(bucket.index)}\n${bucket.activeMinutes}/${bucket.monitoredMinutes} active monitored minutes`;
            return (
              <div
                key={bucket.index}
                className={className}
                data-tooltip={tooltip}
                data-app-name={bucket.topAppName ?? undefined}
                data-app-minutes={bucket.topAppMinutes || undefined}
              />
            );
          })}
        </div>
        <div className="timeline-axis">
          {timelineAxisMinutes.map((minute, index) => (
            <span key={`${minute}-${index}`}>{minuteToLocalLabel(minute)}</span>
          ))}
        </div>
        {shareMessage ? (
          <p className="share-caption" data-html2canvas-ignore="true">
            {shareMessage}
          </p>
        ) : null}
      </section>

      <section className="panel density-panel">
        <div className="panel-heading density-heading">
          <div>
            <h2>Activity Density</h2>
            <p>30-minute windows across {selectedDateLabel.toLowerCase()}.</p>
          </div>
          <strong>{displayedDensityPercent}% active</strong>
        </div>
        <div
          key={`density-${displayedDay?.date ?? "empty"}`}
          className="activity-density-chart"
          style={densityStyle}
          onMouseMove={handleDelegatedMouseMove}
          onMouseLeave={hideHoverTooltip}
        >
          {densityBuckets.map((bucket) => {
            const isFuture = bucket.bucketStartMinute > nowMinuteOfDay;
            const height = isFuture
              ? 12
              : bucket.activeMinutes > 0
                ? Math.round(22 + bucket.density * 78)
                : 14;
            const tooltip = `${formatMinuteRange(
              bucket.bucketStartMinute,
              DENSITY_BUCKET_MINUTES,
            )}\n${bucket.activeMinutes}/${bucket.monitoredMinutes} active minutes`;

            return (
              <div
                key={bucket.index}
                className={`density-bar ${
                  isFuture ? "future" : bucket.activeMinutes > 0 ? "active" : "idle"
                }`}
                data-tooltip={tooltip}
                style={
                  {
                    "--density-height": `${height}%`,
                    "--density-index": `${bucket.index}`,
                  } as CSSProperties
                }
              />
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Work History</h2>
        </div>
        <div className="heatmap">
          <div className="month-row">
            {heatmapWeeks.monthLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
          <div
            className="heatmap-grid"
            onMouseMove={handleDelegatedMouseMove}
            onMouseLeave={hideHoverTooltip}
            onClick={(event) => {
              const target = (event.target as HTMLElement).closest<HTMLElement>("[data-date]");
              if (target?.dataset.date) {
                void selectDay(target.dataset.date);
              }
            }}
          >
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
                      data-tooltip={tooltip}
                      data-date={cell.date}
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
                  onChange={(event) => setSleepWindowEnabled(event.target.checked)}
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
          <div className="settings-card tracking-info">
            <h3>How Trackr measures activity</h3>
            <br/>
            <p>
              Trackr samples recent keyboard and mouse activity every 15 seconds and rolls that
              into per-minute active or idle states.
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

      <HoverTooltip ref={hoverTooltipRef} buildPosition={buildTooltipPosition} />

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
};

export default App;
