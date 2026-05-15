use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Local, NaiveDate, TimeZone, Timelike, Utc};
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};
#[cfg(target_os = "macos")]
use core_graphics::event_source::CGEventSourceStateID;
use ed25519_dalek::{pkcs8::DecodePublicKey, Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::ffi::{c_char, CStr};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU16, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use uuid::Uuid;

const MINUTES_PER_DAY: usize = 1_440;
const SAMPLE_INTERVAL_SECS: u64 = 15;
const IDLE_THRESHOLD_SECS: i64 = 60;
const ACTIVE_SCORE_THRESHOLD: u16 = 1;
const MAX_DAYS_STORED: usize = 730;
const MAX_APP_NAME_CHARS: usize = 128;
const MINUTES_PER_DAY_U16: u16 = MINUTES_PER_DAY as u16;
const MINUTE_ACTIVITY_SCORE_BITS: u32 = 16;
const MINUTE_ACTIVITY_SCORE_MASK: u64 = (1_u64 << MINUTE_ACTIVITY_SCORE_BITS) - 1;
const ACTIVITY_STORE_FORMAT_VERSION: u8 = 2;
const STORE_PERSIST_INTERVAL_MS: u64 = 60_000;
const TRAY_ICON_SCALE: u32 = 3;
const TRAY_ICON_WIDTH: u32 = 62 * TRAY_ICON_SCALE;
const TRAY_ICON_HEIGHT: u32 = 20 * TRAY_ICON_SCALE;
const TRAY_PILL_MARGIN_X: u32 = 2 * TRAY_ICON_SCALE;
const TRAY_PILL_HEIGHT: u32 = 12 * TRAY_ICON_SCALE;
const TRAY_INNER_INSET: u32 = TRAY_ICON_SCALE;
const TRAY_CORNER_RADIUS: u32 = 6 * TRAY_ICON_SCALE;
const TRAY_AA_FEATHER: f32 = 1.2;
const TRAY_REFRESH_SECS: u64 = 20;
const ACTIVE_SAMPLE_INTERVAL_SECS: u64 = SAMPLE_INTERVAL_SECS;
const MAX_INACTIVE_SAMPLE_INTERVAL_SECS: u64 = 5 * 60;
const LISTEN_EVENT_TAP_PROBE_BACKOFF_SECS: i64 = 15;
const CONFIRMED_PERMISSION_PREFLIGHT_RECHECK_SECS: i64 = 60;
const PAYWALL_LOCKED_ERROR: &str = "PAYWALL_LOCKED";
const INPUT_MONITORING_REQUIRED_ERROR: &str = "INPUT_MONITORING_REQUIRED";
const ACTIVITY_PERSIST_ERROR_PREFIX: &str = "Couldn't save activity data: ";
const PAYWALL_SYNC_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const PAYWALL_CERT_DURATION_MS: u64 = 400 * 24 * 60 * 60 * 1000;
// Development fallback only. Release builds must inject TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64.
const DEFAULT_PAYWALL_PUBLIC_KEY_DER_BASE64: &str =
    "MCowBQYDK2VwAyEA85qbsp0q0HG3PTnDOzZndogIhfJMdCrDUPgW9cORxAM=";

#[cfg(target_os = "macos")]
// Apple defines kCGAnyInputEventType as (~0), which shares the same raw value.
const ANY_INPUT_EVENT_TYPE: CGEventType = CGEventType::TapDisabledByUserInput;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TodayTimeline {
    date: String,
    timeline: Vec<u8>,
    app_timeline: Vec<Option<String>>,
    active_minutes: u16,
    idle_minutes: u16,
    currently_active: bool,
    sleep_mode: bool,
    sleep_window: SleepWindow,
    listener_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeatmapDay {
    date: String,
    active_minutes: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageStatus {
    store_path: String,
    persisted_day_count: usize,
    store_file_exists: bool,
    store_file_size_bytes: u64,
    last_persisted_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackingPermissionStatus {
    supported: bool,
    input_monitoring_granted: bool,
    all_granted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementCertificate {
    device_id: String,
    session_id: String,
    payment_intent_id: String,
    issued_at_epoch_ms: u64,
    expires_at_epoch_ms: u64,
    signature_base64: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct PaywallStore {
    device_id: String,
    entitlement: Option<EntitlementCertificate>,
    last_sync_at_epoch_ms: Option<u64>,
    next_sync_at_epoch_ms: Option<u64>,
    pending_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaywallStatus {
    status: String,
    device_id: String,
    entitlement: Option<EntitlementCertificate>,
    last_sync_at_epoch_ms: Option<u64>,
    next_sync_at_epoch_ms: Option<u64>,
    pending_session_id: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SleepWindow {
    enabled: bool,
    start_minute: u16,
    end_minute: u16,
}

impl Default for SleepWindow {
    fn default() -> Self {
        Self {
            enabled: false,
            start_minute: 23 * 60,
            end_minute: 7 * 60,
        }
    }
}

impl SleepWindow {
    fn normalized(mut self) -> Self {
        self.start_minute %= MINUTES_PER_DAY_U16;
        self.end_minute %= MINUTES_PER_DAY_U16;
        self
    }

    fn contains_minute(&self, minute_of_day: usize) -> bool {
        if !self.enabled {
            return false;
        }

        let minute = (minute_of_day as u16) % MINUTES_PER_DAY_U16;
        if self.start_minute == self.end_minute {
            return false;
        }

        if self.start_minute < self.end_minute {
            minute >= self.start_minute && minute < self.end_minute
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }

    fn formatted_range(&self) -> String {
        format!(
            "{}-{}",
            format_clock_hhmm(self.start_minute),
            format_clock_hhmm(self.end_minute)
        )
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct ActivityStore {
    days: BTreeMap<String, StoredDay>,
    sleep_window: SleepWindow,
}

impl ActivityStore {
    fn prune_old_days(&mut self) -> Vec<String> {
        if self.days.len() <= MAX_DAYS_STORED {
            return Vec::new();
        }

        let remove_count = self.days.len() - MAX_DAYS_STORED;
        let keys: Vec<String> = self.days.keys().take(remove_count).cloned().collect();
        for key in &keys {
            self.days.remove(key.as_str());
        }
        keys
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredDay {
    timeline: Vec<u8>,
    #[serde(alias = "appNames")]
    app_timeline: Vec<Option<String>>,
    sleep_window: SleepWindow,
}

impl Default for StoredDay {
    fn default() -> Self {
        Self {
            timeline: vec![0; MINUTES_PER_DAY],
            app_timeline: vec![None; MINUTES_PER_DAY],
            sleep_window: SleepWindow::default(),
        }
    }
}

impl StoredDay {
    fn new(sleep_window: SleepWindow) -> Self {
        Self {
            sleep_window,
            ..Self::default()
        }
    }

    fn normalized(mut self) -> Self {
        if self.timeline.len() != MINUTES_PER_DAY {
            self.timeline.resize(MINUTES_PER_DAY, 0);
        }
        if self.app_timeline.len() != MINUTES_PER_DAY {
            self.app_timeline.resize_with(MINUTES_PER_DAY, || None);
        }
        self.sleep_window = self.sleep_window.normalized();
        self
    }

    fn ensure_app_timeline_len(&mut self) -> bool {
        if self.app_timeline.len() == MINUTES_PER_DAY {
            return false;
        }

        self.app_timeline.resize_with(MINUTES_PER_DAY, || None);
        true
    }

    fn set_app_name_for_minute(&mut self, minute_of_day: usize, app_name: Option<String>) -> bool {
        if self.ensure_app_timeline_len() {
            if self.app_timeline[minute_of_day] == app_name {
                return true;
            }
            self.app_timeline[minute_of_day] = app_name;
            return true;
        }

        if self.app_timeline[minute_of_day] == app_name {
            return false;
        }

        self.app_timeline[minute_of_day] = app_name;
        true
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityStoreSettings {
    version: u8,
    #[serde(default)]
    sleep_window: SleepWindow,
}

impl Default for ActivityStoreSettings {
    fn default() -> Self {
        Self {
            version: ACTIVITY_STORE_FORMAT_VERSION,
            sleep_window: SleepWindow::default(),
        }
    }
}

impl ActivityStoreSettings {
    fn from_store(store: &ActivityStore) -> Self {
        Self {
            version: ACTIVITY_STORE_FORMAT_VERSION,
            sleep_window: store.sleep_window.clone(),
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct LegacyActivityStore {
    days: BTreeMap<String, Vec<u8>>,
    sleep_window: SleepWindow,
}

fn activity_score_reached_threshold(activity_score: u16) -> bool {
    activity_score >= ACTIVE_SCORE_THRESHOLD
}

fn pack_minute_activity(epoch_minute: i64, activity_score: u16) -> u64 {
    let minute = u64::try_from(epoch_minute.max(0)).unwrap_or(0);
    (minute << MINUTE_ACTIVITY_SCORE_BITS) | u64::from(activity_score.min(ACTIVE_SCORE_THRESHOLD))
}

fn unpack_minute_activity(packed: u64) -> (i64, u16) {
    (
        (packed >> MINUTE_ACTIVITY_SCORE_BITS) as i64,
        (packed & MINUTE_ACTIVITY_SCORE_MASK) as u16,
    )
}
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
    fn CGEventSourceSecondsSinceLastEventType(
        state_id: CGEventSourceStateID,
        event_type: CGEventType,
    ) -> f64;
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn GetLastInputInfo(last_input_info: *mut LastInputInfo) -> i32;
    fn GetForegroundWindow() -> *mut c_void;
    fn GetWindowThreadProcessId(h_wnd: *mut c_void, lpdw_process_id: *mut u32) -> u32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetTickCount() -> u32;
    fn OpenProcess(
        dw_desired_access: u32,
        b_inherit_handle: i32,
        dw_process_id: u32,
    ) -> *mut c_void;
    fn QueryFullProcessImageNameW(
        h_process: *mut c_void,
        dw_flags: u32,
        lp_exe_name: *mut u16,
        lpdw_size: *mut u32,
    ) -> i32;
    fn CloseHandle(h_object: *mut c_void) -> i32;
}

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn objc_msgSend_id(receiver: *mut c_void, selector: *mut c_void) -> *mut c_void;
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(context: *mut c_void);
}

struct TrackerState {
    store: Mutex<ActivityStore>,
    store_path: PathBuf,
    store_persist_lock: Mutex<()>,
    dirty_day_keys: Mutex<BTreeSet<String>>,
    deleted_day_keys: Mutex<BTreeSet<String>>,
    activity_store_needs_migration: AtomicBool,
    activity_settings_dirty: AtomicBool,
    last_activity_persist_at_epoch_ms: AtomicU64,
    paywall_store: Mutex<PaywallStore>,
    paywall_path: PathBuf,
    paywall_persist_lock: Mutex<()>,
    minute_activity: AtomicU64,
    last_input_epoch: AtomicI64,
    listener_error: Mutex<Option<String>>,
    input_access_granted: AtomicBool,
    sleep_window_enabled: AtomicBool,
    sleep_window_start_minute: AtomicU16,
    sleep_window_end_minute: AtomicU16,
    tracking_enabled: AtomicBool,
    tracking_started: AtomicBool,
    shutdown_requested: AtomicBool,
    shutdown_condvar: (Mutex<bool>, Condvar),
    sampler_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl TrackerState {
    fn new(store_path: PathBuf, paywall_path: PathBuf) -> Self {
        let epoch_minute = Utc::now().timestamp().div_euclid(60);
        let initial_last_input_epoch = Utc::now()
            .timestamp()
            .saturating_sub(IDLE_THRESHOLD_SECS.saturating_add(1));
        let (activity_store, activity_store_needs_migration) = load_store(&store_path);
        let sleep_window = activity_store.sleep_window.clone();
        let paywall_store = load_paywall_store(&paywall_path);
        // Once paid, stay paid — skip re-validation on startup.
        let has_valid_entitlement = paywall_store.entitlement.is_some();
        let input_access_granted = input_monitoring_granted();
        Self {
            store: Mutex::new(activity_store),
            store_path,
            store_persist_lock: Mutex::new(()),
            dirty_day_keys: Mutex::new(BTreeSet::new()),
            deleted_day_keys: Mutex::new(BTreeSet::new()),
            activity_store_needs_migration: AtomicBool::new(activity_store_needs_migration),
            activity_settings_dirty: AtomicBool::new(false),
            last_activity_persist_at_epoch_ms: AtomicU64::new(0),
            paywall_store: Mutex::new(paywall_store),
            paywall_path,
            paywall_persist_lock: Mutex::new(()),
            minute_activity: AtomicU64::new(pack_minute_activity(epoch_minute, 0)),
            last_input_epoch: AtomicI64::new(initial_last_input_epoch),
            listener_error: Mutex::new(None),
            input_access_granted: AtomicBool::new(input_access_granted),
            sleep_window_enabled: AtomicBool::new(sleep_window.enabled),
            sleep_window_start_minute: AtomicU16::new(sleep_window.start_minute),
            sleep_window_end_minute: AtomicU16::new(sleep_window.end_minute),
            tracking_enabled: AtomicBool::new(has_valid_entitlement),
            tracking_started: AtomicBool::new(false),
            shutdown_requested: AtomicBool::new(false),
            shutdown_condvar: (Mutex::new(false), Condvar::new()),
            sampler_handle: Mutex::new(None),
        }
    }

    fn is_unlocked(&self) -> bool {
        self.tracking_enabled.load(Ordering::Relaxed)
    }

    fn require_unlocked(&self) -> Result<(), String> {
        if self.is_unlocked() {
            Ok(())
        } else {
            Err(PAYWALL_LOCKED_ERROR.into())
        }
    }

    fn should_track(&self) -> bool {
        self.is_unlocked() && self.has_required_input_access()
    }

    fn has_required_input_access(&self) -> bool {
        self.input_access_granted.load(Ordering::Relaxed)
    }

    fn refresh_input_access_cache(&self) -> bool {
        let granted = input_monitoring_granted();
        self.input_access_granted.store(granted, Ordering::Relaxed);
        granted
    }

    fn require_input_access(&self) -> Result<(), String> {
        if self.has_required_input_access() {
            Ok(())
        } else {
            Err(INPUT_MONITORING_REQUIRED_ERROR.into())
        }
    }

    fn require_tracking_ready(&self) -> Result<(), String> {
        self.require_unlocked()?;
        self.require_input_access()
    }

    fn notify_sampler_thread(&self) {
        let (_, cvar) = &self.shutdown_condvar;
        cvar.notify_all();
    }

    fn ensure_tracking_started(self: &Arc<Self>) {
        if self
            .tracking_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.refresh_input_access_cache();
            self.observe_recent_system_activity();
            self.sample_current_minute();
            let handle = spawn_activity_sampler(self.clone());
            *self
                .sampler_handle
                .lock()
                .expect("sampler_handle lock poisoned") = Some(handle);
        }
    }

    fn request_shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::Relaxed);
        let _ = self.persist_activity_store_if_due(true);
        let _ = self.persist_paywall_store();
        let (lock, cvar) = &self.shutdown_condvar;
        let mut shutdown = lock.lock().expect("shutdown_condvar lock poisoned");
        *shutdown = true;
        cvar.notify_all();
    }

    fn join_sampler_thread(&self) {
        if let Ok(mut guard) = self.sampler_handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }

    fn activity_store_needs_migration(&self) -> bool {
        self.activity_store_needs_migration.load(Ordering::Relaxed)
    }

    fn paywall_status(&self) -> PaywallStatus {
        let store = self
            .paywall_store
            .lock()
            .expect("paywall_store lock poisoned");
        PaywallStatus {
            status: if self.is_unlocked() {
                "unlocked".to_string()
            } else {
                "locked".to_string()
            },
            device_id: store.device_id.clone(),
            entitlement: store.entitlement.clone(),
            last_sync_at_epoch_ms: store.last_sync_at_epoch_ms,
            next_sync_at_epoch_ms: store.next_sync_at_epoch_ms,
            pending_session_id: store.pending_session_id.clone(),
            reason: if self.is_unlocked() {
                None
            } else {
                Some(PAYWALL_LOCKED_ERROR.to_string())
            },
        }
    }

    fn set_pending_session_id(&self, session_id: Option<String>) -> Result<(), String> {
        self.update_paywall_store(move |store| {
            store.pending_session_id = session_id;
            Ok(())
        })
    }

    fn apply_entitlement(
        &self,
        entitlement: EntitlementCertificate,
    ) -> Result<PaywallStatus, String> {
        let now_ms = now_epoch_ms();
        let was_tracking_active = self.should_track();
        self.update_paywall_store(move |store| {
            validate_entitlement(&entitlement, &store.device_id)?;
            store.entitlement = Some(entitlement);
            store.last_sync_at_epoch_ms = Some(now_ms);
            store.next_sync_at_epoch_ms = Some(now_ms.saturating_add(PAYWALL_SYNC_INTERVAL_MS));
            store.pending_session_id = None;
            Ok(())
        })?;
        self.tracking_enabled.store(true, Ordering::Relaxed);
        if !was_tracking_active && self.should_track() {
            self.notify_sampler_thread();
        }
        Ok(self.paywall_status())
    }

    fn clear_entitlement(&self) -> Result<(), String> {
        let was_tracking_active = self.should_track();
        self.update_paywall_store(|store| {
            store.entitlement = None;
            store.last_sync_at_epoch_ms = None;
            store.next_sync_at_epoch_ms = None;
            store.pending_session_id = None;
            Ok(())
        })?;
        self.tracking_enabled.store(false, Ordering::Relaxed);
        if was_tracking_active && !self.should_track() {
            self.notify_sampler_thread();
        }
        Ok(())
    }

    fn tracking_permission_status(&self) -> TrackingPermissionStatus {
        let was_tracking_active = self.should_track();
        let status = tracking_permission_status();
        self.input_access_granted
            .store(status.input_monitoring_granted, Ordering::Relaxed);
        if was_tracking_active != self.should_track() {
            self.notify_sampler_thread();
        }
        status
    }

    fn request_tracking_permission_access(&self) -> TrackingPermissionStatus {
        let was_tracking_active = self.should_track();
        let status = prompt_tracking_permission_access();
        self.input_access_granted
            .store(status.input_monitoring_granted, Ordering::Relaxed);
        if was_tracking_active != self.should_track() {
            self.notify_sampler_thread();
        }
        status
    }

    fn update_sleep_window_cache(&self, sleep_window: &SleepWindow) {
        self.sleep_window_enabled
            .store(sleep_window.enabled, Ordering::Relaxed);
        self.sleep_window_start_minute
            .store(sleep_window.start_minute, Ordering::Relaxed);
        self.sleep_window_end_minute
            .store(sleep_window.end_minute, Ordering::Relaxed);
    }

    fn mark_day_dirty(&self, date_key: impl Into<String>) {
        self.dirty_day_keys
            .lock()
            .expect("dirty_day_keys lock poisoned")
            .insert(date_key.into());
    }

    fn mark_deleted_days(&self, date_keys: &[String]) {
        if date_keys.is_empty() {
            return;
        }

        let mut dirty_day_keys = self
            .dirty_day_keys
            .lock()
            .expect("dirty_day_keys lock poisoned");
        let mut deleted_day_keys = self
            .deleted_day_keys
            .lock()
            .expect("deleted_day_keys lock poisoned");
        for date_key in date_keys {
            dirty_day_keys.remove(date_key);
            deleted_day_keys.insert(date_key.clone());
        }
    }

    fn mark_activity_settings_dirty(&self) {
        self.activity_settings_dirty.store(true, Ordering::Relaxed);
    }

    fn record_input_epoch(&self, input_epoch: i64) {
        if !self.should_track() {
            return;
        }

        let Some(input_time) = Local.timestamp_opt(input_epoch, 0).single() else {
            return;
        };
        let minute_of_day = (input_time.hour() * 60 + input_time.minute()) as usize;
        if self.sleep_window().contains_minute(minute_of_day) {
            return;
        }

        self.last_input_epoch.store(input_epoch, Ordering::Relaxed);

        let epoch_minute = input_epoch.div_euclid(60);
        self.minute_activity.store(
            pack_minute_activity(epoch_minute, ACTIVE_SCORE_THRESHOLD),
            Ordering::Relaxed,
        );
        let app_name = foreground_app_name();

        let date_key = input_time.format("%Y-%m-%d").to_string();
        let mut changed = false;
        let _persist_guard = self
            .store_persist_lock
            .lock()
            .expect("store_persist_lock lock poisoned");
        let removed_day_keys = {
            let mut store = self.store.lock().expect("store lock poisoned");
            let default_sleep_window = store.sleep_window.clone();
            let day_was_missing = !store.days.contains_key(&date_key);
            let day = store
                .days
                .entry(date_key.clone())
                .or_insert_with(|| StoredDay::new(default_sleep_window));

            if day_was_missing {
                changed = true;
            }

            if day.timeline.len() != MINUTES_PER_DAY {
                day.timeline.resize(MINUTES_PER_DAY, 0);
                changed = true;
            }

            if day.timeline[minute_of_day] != 1 {
                day.timeline[minute_of_day] = 1;
                changed = true;
            }

            if day.set_app_name_for_minute(minute_of_day, app_name) {
                changed = true;
            }

            let removed_day_keys = store.prune_old_days();
            if !removed_day_keys.is_empty() {
                changed = true;
            }
            removed_day_keys
        };

        if changed {
            self.mark_day_dirty(date_key);
            self.mark_deleted_days(&removed_day_keys);
        }
    }

    fn observe_recent_system_activity(&self) {
        if !self.should_track() {
            return;
        }

        match system_idle_duration() {
            Ok(idle_duration) => {
                self.clear_listener_error();

                let idle_seconds = idle_duration.as_secs_f64();
                if !idle_seconds.is_finite() || idle_seconds > IDLE_THRESHOLD_SECS as f64 {
                    return;
                }

                let idle_whole_seconds = idle_seconds.floor().max(0.0) as i64;
                let input_epoch = Utc::now().timestamp().saturating_sub(idle_whole_seconds);
                self.record_input_epoch(input_epoch);
            }
            Err(error) => self.set_listener_error(error),
        }
    }

    fn is_currently_active(&self) -> bool {
        Utc::now().timestamp() - self.last_input_epoch.load(Ordering::Relaxed)
            <= IDLE_THRESHOLD_SECS
    }

    fn is_current_minute_active(&self) -> bool {
        let epoch_minute = Utc::now().timestamp().div_euclid(60);
        let (tracked_minute, activity_score) =
            unpack_minute_activity(self.minute_activity.load(Ordering::Relaxed));
        tracked_minute == epoch_minute && activity_score_reached_threshold(activity_score)
    }

    fn set_listener_error(&self, err: String) {
        let mut listener_error = self
            .listener_error
            .lock()
            .expect("listener_error lock poisoned");
        *listener_error = Some(err);
    }

    fn clear_listener_error(&self) {
        let mut listener_error = self
            .listener_error
            .lock()
            .expect("listener_error lock poisoned");
        if matches!(
            listener_error.as_deref(),
            Some(error) if error.starts_with(ACTIVITY_PERSIST_ERROR_PREFIX)
        ) {
            return;
        }
        *listener_error = None;
    }

    fn clear_activity_persist_error(&self) {
        let mut listener_error = self
            .listener_error
            .lock()
            .expect("listener_error lock poisoned");
        if matches!(
            listener_error.as_deref(),
            Some(error) if error.starts_with(ACTIVITY_PERSIST_ERROR_PREFIX)
        ) {
            *listener_error = None;
        }
    }

    fn listener_error(&self) -> Option<String> {
        self.listener_error
            .lock()
            .expect("listener_error lock poisoned")
            .clone()
    }

    fn sleep_window(&self) -> SleepWindow {
        SleepWindow {
            enabled: self.sleep_window_enabled.load(Ordering::Relaxed),
            start_minute: self.sleep_window_start_minute.load(Ordering::Relaxed),
            end_minute: self.sleep_window_end_minute.load(Ordering::Relaxed),
        }
    }

    fn set_sleep_window(&self, sleep_window: SleepWindow) -> Result<SleepWindow, String> {
        let normalized = sleep_window.normalized();
        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let mut today_day_updated = false;
        {
            let _persist_guard = self
                .store_persist_lock
                .lock()
                .expect("store_persist_lock lock poisoned");
            let mut store = self.store.lock().expect("store lock poisoned");
            store.sleep_window = normalized.clone();
            if let Some(today_day) = store.days.get_mut(&today_key) {
                if today_day.sleep_window != normalized {
                    today_day.sleep_window = normalized.clone();
                    today_day_updated = true;
                }
            }
            self.mark_activity_settings_dirty();
            if today_day_updated {
                self.mark_day_dirty(today_key.clone());
            }
        }
        self.update_sleep_window_cache(&normalized);
        self.persist_activity_store_if_due(true)?;
        self.clear_activity_persist_error();
        Ok(normalized)
    }

    fn sample_current_minute(&self) {
        if !self.should_track() {
            return;
        }

        let now = Local::now();
        let date_key = now.format("%Y-%m-%d").to_string();
        let minute_of_day = (now.hour() * 60 + now.minute()) as usize;
        let sleep_window = self.sleep_window();
        let active_flag = if sleep_window.contains_minute(minute_of_day) {
            0
        } else {
            u8::from(self.is_current_minute_active())
        };
        let app_name = if sleep_window.contains_minute(minute_of_day) {
            None
        } else {
            foreground_app_name()
        };

        let mut changed = false;
        let _persist_guard = self
            .store_persist_lock
            .lock()
            .expect("store_persist_lock lock poisoned");
        let removed_day_keys = {
            let mut store = self.store.lock().expect("store lock poisoned");
            let default_sleep_window = store.sleep_window.clone();
            let day_was_missing = !store.days.contains_key(&date_key);
            let day = store
                .days
                .entry(date_key.clone())
                .or_insert_with(|| StoredDay::new(default_sleep_window));

            if day_was_missing {
                changed = true;
            }

            if day.timeline.len() != MINUTES_PER_DAY {
                day.timeline.resize(MINUTES_PER_DAY, 0);
                changed = true;
            }

            if day.timeline[minute_of_day] != active_flag {
                day.timeline[minute_of_day] = active_flag;
                changed = true;
            }

            if day.set_app_name_for_minute(minute_of_day, app_name) {
                changed = true;
            }

            let removed_day_keys = store.prune_old_days();
            if !removed_day_keys.is_empty() {
                changed = true;
            }
            removed_day_keys
        };

        if changed {
            self.mark_day_dirty(date_key);
            self.mark_deleted_days(&removed_day_keys);
        }
    }

    fn persist_activity_settings_locked(&self) -> Result<(), String> {
        let bytes = {
            let store = self.store.lock().expect("store lock poisoned");
            let settings = ActivityStoreSettings::from_store(&store);
            serde_json::to_vec(&settings)
                .map_err(|err| format!("serialize activity settings: {err}"))?
        };
        write_bytes_to_store(&self.store_path, &bytes, "activity settings")
    }

    fn has_pending_activity_persist(&self) -> bool {
        if self.activity_store_needs_migration()
            || self.activity_settings_dirty.load(Ordering::Relaxed)
        {
            return true;
        }

        if !self
            .dirty_day_keys
            .lock()
            .expect("dirty_day_keys lock poisoned")
            .is_empty()
        {
            return true;
        }

        !self
            .deleted_day_keys
            .lock()
            .expect("deleted_day_keys lock poisoned")
            .is_empty()
    }

    fn persist_activity_store_if_due(&self, force: bool) -> Result<bool, String> {
        if !force {
            if !self.has_pending_activity_persist() {
                return Ok(false);
            }

            let now_ms = now_epoch_ms();
            let last_persist_at_epoch_ms = self
                .last_activity_persist_at_epoch_ms
                .load(Ordering::Relaxed);
            if now_ms < last_persist_at_epoch_ms.saturating_add(STORE_PERSIST_INTERVAL_MS) {
                return Ok(false);
            }
        }

        let _persist_guard = self
            .store_persist_lock
            .lock()
            .expect("store_persist_lock lock poisoned");

        if !force {
            if !self.has_pending_activity_persist() {
                return Ok(false);
            }

            let now_ms = now_epoch_ms();
            let last_persist_at_epoch_ms = self
                .last_activity_persist_at_epoch_ms
                .load(Ordering::Relaxed);
            if now_ms < last_persist_at_epoch_ms.saturating_add(STORE_PERSIST_INTERVAL_MS) {
                return Ok(false);
            }
        }

        if self.activity_store_needs_migration.load(Ordering::Relaxed) {
            self.persist_full_activity_store_locked()?;
            self.activity_store_needs_migration
                .store(false, Ordering::Relaxed);
            self.activity_settings_dirty.store(false, Ordering::Relaxed);
            self.dirty_day_keys
                .lock()
                .expect("dirty_day_keys lock poisoned")
                .clear();
            self.deleted_day_keys
                .lock()
                .expect("deleted_day_keys lock poisoned")
                .clear();
            self.last_activity_persist_at_epoch_ms
                .store(now_epoch_ms(), Ordering::Relaxed);
            return Ok(true);
        }

        let activity_settings_missing = fs::metadata(&self.store_path).is_err();
        let should_persist_settings =
            activity_settings_missing || self.activity_settings_dirty.load(Ordering::Relaxed);
        let deleted_day_keys: Vec<String> = self
            .deleted_day_keys
            .lock()
            .expect("deleted_day_keys lock poisoned")
            .iter()
            .cloned()
            .collect();
        let dirty_day_keys: Vec<String> = self
            .dirty_day_keys
            .lock()
            .expect("dirty_day_keys lock poisoned")
            .iter()
            .cloned()
            .collect();

        if !should_persist_settings && deleted_day_keys.is_empty() && dirty_day_keys.is_empty() {
            return Ok(false);
        }

        if should_persist_settings {
            self.persist_activity_settings_locked()?;
        }

        for deleted_day_key in &deleted_day_keys {
            remove_store_file(
                &activity_day_store_path(&self.store_path, deleted_day_key),
                "activity day",
            )?;
        }

        for dirty_day_key in &dirty_day_keys {
            self.persist_day_record_locked(dirty_day_key)?;
        }

        if should_persist_settings {
            self.activity_settings_dirty.store(false, Ordering::Relaxed);
        }
        self.dirty_day_keys
            .lock()
            .expect("dirty_day_keys lock poisoned")
            .clear();
        self.deleted_day_keys
            .lock()
            .expect("deleted_day_keys lock poisoned")
            .clear();
        self.last_activity_persist_at_epoch_ms
            .store(now_epoch_ms(), Ordering::Relaxed);
        Ok(true)
    }

    fn persist_day_record_locked(&self, date_key: &str) -> Result<(), String> {
        let stored_day = {
            self.store
                .lock()
                .expect("store lock poisoned")
                .days
                .get(date_key)
                .cloned()
        };

        let Some(stored_day) = stored_day else {
            return Ok(());
        };

        let bytes = serde_json::to_vec(&stored_day)
            .map_err(|err| format!("serialize activity day: {err}"))?;
        write_bytes_to_store(
            &activity_day_store_path(&self.store_path, date_key),
            &bytes,
            "activity day",
        )
    }

    fn persist_full_activity_store_locked(&self) -> Result<(), String> {
        let (settings, days) = {
            let store = self.store.lock().expect("store lock poisoned");
            (
                ActivityStoreSettings::from_store(&store),
                store.days.clone(),
            )
        };

        let settings_bytes = serde_json::to_vec(&settings)
            .map_err(|err| format!("serialize activity settings: {err}"))?;
        write_bytes_to_store(&self.store_path, &settings_bytes, "activity settings")?;

        let day_dir = activity_day_store_dir(&self.store_path);
        fs::create_dir_all(&day_dir)
            .map_err(|err| format!("create activity day directory: {err}"))?;

        for (date_key, stored_day) in &days {
            let bytes = serde_json::to_vec(stored_day)
                .map_err(|err| format!("serialize activity day: {err}"))?;
            write_bytes_to_store(
                &activity_day_store_path(&self.store_path, date_key),
                &bytes,
                "activity day",
            )?;
        }

        if let Ok(entries) = fs::read_dir(&day_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(date_key) = activity_day_key_from_path(&path) else {
                    continue;
                };
                if !days.contains_key(&date_key) {
                    remove_store_file(&path, "activity day")?;
                }
            }
        }

        Ok(())
    }

    fn persist_paywall_store(&self) -> Result<(), String> {
        let store = {
            self.paywall_store
                .lock()
                .expect("paywall_store lock poisoned")
                .clone()
        };
        self.persist_paywall_store_snapshot(&store)
    }

    fn persist_paywall_store_snapshot(&self, store: &PaywallStore) -> Result<(), String> {
        // Serialize writes through a dedicated lock so overlapping saves do not
        // race on the shared temporary file path.
        let _persist_guard = self
            .paywall_persist_lock
            .lock()
            .expect("paywall_persist_lock lock poisoned");
        let bytes =
            serde_json::to_vec(store).map_err(|err| format!("serialize paywall store: {err}"))?;
        write_bytes_to_store(&self.paywall_path, &bytes, "paywall")
    }

    fn update_paywall_store<T>(
        &self,
        mutator: impl FnOnce(&mut PaywallStore) -> Result<T, String>,
    ) -> Result<T, String> {
        // Hold the persist lock across snapshotting and writing so concurrent
        // paywall updates are serialized end-to-end.
        let _persist_guard = self
            .paywall_persist_lock
            .lock()
            .expect("paywall_persist_lock lock poisoned");

        let (next_store, result) = {
            let store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            let mut next_store = store.clone();
            let result = mutator(&mut next_store)?;
            (next_store, result)
        };

        let bytes = serde_json::to_vec(&next_store)
            .map_err(|err| format!("serialize paywall store: {err}"))?;
        write_bytes_to_store(&self.paywall_path, &bytes, "paywall")?;

        {
            let mut store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            *store = next_store;
        }

        Ok(result)
    }

    fn timeline_for_date(&self, date: NaiveDate) -> TodayTimeline {
        let now = Local::now();
        let today = now.date_naive();
        let is_today = date == today;
        let date_key = date.format("%Y-%m-%d").to_string();
        let minute_of_day = (now.hour() * 60 + now.minute()) as usize;

        let (mut timeline, mut app_timeline, sleep_window) = {
            let store = self.store.lock().expect("store lock poisoned");
            match store.days.get(&date_key) {
                Some(stored_day) => (
                    stored_day.timeline.clone(),
                    stored_day.app_timeline.clone(),
                    stored_day.sleep_window.clone(),
                ),
                None => (Vec::new(), Vec::new(), store.sleep_window.clone()),
            }
        };

        if timeline.len() != MINUTES_PER_DAY {
            timeline.resize(MINUTES_PER_DAY, 0);
        }
        if app_timeline.len() != MINUTES_PER_DAY {
            app_timeline.resize_with(MINUTES_PER_DAY, || None);
        }

        let last_minute = if is_today {
            minute_of_day
        } else {
            MINUTES_PER_DAY.saturating_sub(1)
        };

        let mut active_minutes = 0_u16;
        let mut monitored_minutes = 0_u16;
        for (minute, value) in timeline.iter().take(last_minute + 1).enumerate() {
            if sleep_window.contains_minute(minute) {
                continue;
            }
            monitored_minutes += 1;
            active_minutes += *value as u16;
        }

        let idle_minutes = monitored_minutes.saturating_sub(active_minutes);
        let sleep_mode = is_today && sleep_window.contains_minute(minute_of_day);

        TodayTimeline {
            date: date_key,
            timeline,
            app_timeline,
            active_minutes,
            idle_minutes,
            currently_active: is_today && !sleep_mode && self.is_currently_active(),
            sleep_mode,
            sleep_window,
            listener_error: if is_today {
                self.listener_error()
            } else {
                None
            },
        }
    }

    fn timeline_for_date_key(&self, date: &str) -> Result<TodayTimeline, String> {
        let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| format!("Invalid date '{date}'. Expected YYYY-MM-DD."))?;
        Ok(self.timeline_for_date(parsed))
    }

    fn today_timeline(&self) -> TodayTimeline {
        self.timeline_for_date(Local::now().date_naive())
    }

    fn heatmap(&self, days: u16) -> Vec<HeatmapDay> {
        let capped_days = days.clamp(1, 365 * 2);
        let today = Local::now().date_naive();
        let store = self.store.lock().expect("store lock poisoned");

        (0..capped_days)
            .rev()
            .map(|offset| {
                let date = today - ChronoDuration::days(offset as i64);
                let date_key = date.format("%Y-%m-%d").to_string();
                let active_minutes = store
                    .days
                    .get(&date_key)
                    .map(|stored_day| {
                        stored_day
                            .timeline
                            .iter()
                            .enumerate()
                            .filter(|(minute, _)| !stored_day.sleep_window.contains_minute(*minute))
                            .map(|(_, value)| *value as u16)
                            .sum()
                    })
                    .unwrap_or(0);

                HeatmapDay {
                    date: date_key,
                    active_minutes,
                }
            })
            .collect()
    }

    fn storage_status(&self) -> StorageStatus {
        let persisted_day_count = {
            let store = self.store.lock().expect("store lock poisoned");
            store.days.len()
        };

        let metadata = fs::metadata(&self.store_path).ok();
        let store_file_exists =
            metadata.is_some() || fs::metadata(activity_day_store_dir(&self.store_path)).is_ok();
        let store_file_size_bytes = metadata.as_ref().map_or(0, |meta| meta.len())
            + activity_day_dir_size(&self.store_path);
        let settings_last_persisted_at_epoch_ms = metadata
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());
        let day_last_persisted_at_epoch_ms = activity_day_dir_latest_persisted_at(&self.store_path);
        let last_persisted_at_epoch_ms = match (
            settings_last_persisted_at_epoch_ms,
            day_last_persisted_at_epoch_ms,
        ) {
            (Some(settings_ts), Some(day_ts)) => Some(settings_ts.max(day_ts)),
            (Some(settings_ts), None) => Some(settings_ts),
            (None, Some(day_ts)) => Some(day_ts),
            (None, None) => None,
        };

        StorageStatus {
            store_path: self.store_path.to_string_lossy().into_owned(),
            persisted_day_count,
            store_file_exists,
            store_file_size_bytes,
            last_persisted_at_epoch_ms,
        }
    }
}

fn load_store(path: &Path) -> (ActivityStore, bool) {
    if let Some(settings) = load_activity_settings(path) {
        return (
            load_store_from_day_files(path, settings.sleep_window),
            false,
        );
    }

    if let Some(legacy_store) = load_legacy_store(path) {
        let sleep_window = legacy_store.sleep_window.normalized();
        let days = legacy_store
            .days
            .into_iter()
            .map(|(date_key, timeline)| {
                (
                    date_key,
                    StoredDay {
                        timeline,
                        app_timeline: vec![None; MINUTES_PER_DAY],
                        sleep_window: sleep_window.clone(),
                    }
                    .normalized(),
                )
            })
            .collect();

        return (ActivityStore { days, sleep_window }, true);
    }

    let day_file_store = load_store_from_day_files(path, SleepWindow::default());
    if !day_file_store.days.is_empty() {
        return (day_file_store, false);
    }

    (ActivityStore::default(), false)
}

fn load_activity_settings(path: &Path) -> Option<ActivityStoreSettings> {
    let file = match fs::read(path) {
        Ok(file) => file,
        Err(_) => return None,
    };

    let mut settings = serde_json::from_slice::<ActivityStoreSettings>(&file).ok()?;
    if settings.version != ACTIVITY_STORE_FORMAT_VERSION {
        return None;
    }
    settings.sleep_window = settings.sleep_window.normalized();
    Some(settings)
}

fn load_legacy_store(path: &Path) -> Option<LegacyActivityStore> {
    let file = fs::read(path).ok()?;
    let mut store = serde_json::from_slice::<LegacyActivityStore>(&file).ok()?;
    for timeline in store.days.values_mut() {
        if timeline.len() != MINUTES_PER_DAY {
            timeline.resize(MINUTES_PER_DAY, 0);
        }
    }
    store.sleep_window = store.sleep_window.clone().normalized();
    Some(store)
}

fn load_store_from_day_files(path: &Path, sleep_window: SleepWindow) -> ActivityStore {
    let mut days = BTreeMap::new();
    let day_dir = activity_day_store_dir(path);

    if let Ok(entries) = fs::read_dir(&day_dir) {
        for entry in entries.flatten() {
            let day_path = entry.path();
            let Some(date_key) = activity_day_key_from_path(&day_path) else {
                continue;
            };
            let Ok(bytes) = fs::read(&day_path) else {
                continue;
            };
            let Ok(stored_day) = serde_json::from_slice::<StoredDay>(&bytes) else {
                continue;
            };
            days.insert(date_key, stored_day.normalized());
        }
    }

    ActivityStore { days, sleep_window }
}

fn now_epoch_ms() -> u64 {
    u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0)
}

fn canonical_entitlement_payload(entitlement: &EntitlementCertificate) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        entitlement.device_id,
        entitlement.session_id,
        entitlement.payment_intent_id,
        entitlement.issued_at_epoch_ms,
        entitlement.expires_at_epoch_ms
    )
}

fn load_paywall_store(path: &Path) -> PaywallStore {
    let mut store = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PaywallStore>(&bytes).ok())
        .unwrap_or_default();

    if store.device_id.trim().is_empty() {
        store.device_id = Uuid::new_v4().to_string();
    }

    store
}

fn activity_day_store_dir(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("activity");
    path.with_file_name(format!("{stem}.days"))
}

fn activity_day_store_path(path: &Path, date_key: &str) -> PathBuf {
    activity_day_store_dir(path).join(format!("{date_key}.json"))
}

fn activity_day_key_from_path(path: &Path) -> Option<String> {
    if path.extension().and_then(|value| value.to_str()) != Some("json") {
        return None;
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
}

fn activity_day_dir_size(path: &Path) -> u64 {
    let day_dir = activity_day_store_dir(path);
    let Ok(entries) = fs::read_dir(day_dir) else {
        return 0;
    };

    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn activity_day_dir_latest_persisted_at(path: &Path) -> Option<u64> {
    let day_dir = activity_day_store_dir(path);
    let entries = fs::read_dir(day_dir).ok()?;

    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .filter_map(|metadata| metadata.modified().ok())
        .filter_map(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .filter_map(|duration| u64::try_from(duration.as_millis()).ok())
        .max()
}

fn write_bytes_to_store(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create {label} directory: {err}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        fs::write(path, bytes).map_err(|err| format!("write {label} file: {err}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, bytes).map_err(|err| format!("write temp {label} file: {err}"))?;
        fs::rename(&temp_path, path).map_err(|err| format!("replace {label} file: {err}"))?;
        Ok(())
    }
}

fn remove_store_file(path: &Path, label: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("delete {label} file: {err}")),
    }
}

fn validating_key() -> Result<VerifyingKey, String> {
    let key_der_base64 = option_env!("TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64")
        .unwrap_or(DEFAULT_PAYWALL_PUBLIC_KEY_DER_BASE64);
    let key_der = BASE64_STANDARD
        .decode(key_der_base64.as_bytes())
        .map_err(|err| format!("Invalid TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64: {err}"))?;
    VerifyingKey::from_public_key_der(&key_der)
        .map_err(|err| format!("Invalid TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 payload: {err}"))
}

fn validate_entitlement_with_key(
    entitlement: &EntitlementCertificate,
    expected_device_id: &str,
    verifying_key: &VerifyingKey,
) -> Result<(), String> {
    if entitlement.device_id != expected_device_id {
        return Err("Entitlement device mismatch".into());
    }

    let now_ms = now_epoch_ms();
    if entitlement.issued_at_epoch_ms > now_ms.saturating_add(60_000) {
        return Err("Entitlement issue time is in the future".into());
    }
    if entitlement.expires_at_epoch_ms <= now_ms {
        return Err("Entitlement expired".into());
    }
    if entitlement
        .expires_at_epoch_ms
        .saturating_sub(entitlement.issued_at_epoch_ms)
        > PAYWALL_CERT_DURATION_MS.saturating_add(24 * 60 * 60 * 1000)
    {
        return Err("Entitlement duration is invalid".into());
    }

    let signature_bytes = BASE64_STANDARD
        .decode(entitlement.signature_base64.as_bytes())
        .map_err(|_| "Entitlement signature is not valid base64".to_string())?;
    let signature: Signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| "Entitlement signature has invalid length".to_string())?;

    let payload = canonical_entitlement_payload(entitlement);
    verifying_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| "Entitlement signature verification failed".to_string())?;

    Ok(())
}

fn validate_entitlement(
    entitlement: &EntitlementCertificate,
    expected_device_id: &str,
) -> Result<(), String> {
    let verifying_key = validating_key()?;
    validate_entitlement_with_key(entitlement, expected_device_id, &verifying_key)
}

#[cfg(target_os = "macos")]
fn input_monitoring_granted_with_probe(force_probe: bool) -> bool {
    use std::sync::atomic::AtomicI64;

    static CACHED_GRANTED: AtomicBool = AtomicBool::new(false);
    static CONFIRMED_GRANTED: AtomicBool = AtomicBool::new(false);
    static LAST_CONFIRMED_PREFLIGHT_EPOCH: AtomicI64 = AtomicI64::new(0);
    static LAST_TAP_PROBE_EPOCH: AtomicI64 = AtomicI64::new(0);

    fn try_listen_event_access_probe() -> bool {
        CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::MouseMoved],
            |_proxy, _event_type, event| Some(event.clone()),
        )
        .is_ok()
    }

    // Once a CGEventTap probe has confirmed access, stop creating taps entirely.
    // Use the lightweight CGPreflightListenEventAccess (read-only, no HID pipeline
    // touch) to detect rare permission revocations, checking at most once per 60s.
    if !force_probe && CONFIRMED_GRANTED.load(Ordering::Relaxed) {
        let now = Utc::now().timestamp();
        let last = LAST_CONFIRMED_PREFLIGHT_EPOCH.load(Ordering::Relaxed);
        if now - last < CONFIRMED_PERMISSION_PREFLIGHT_RECHECK_SECS {
            return CACHED_GRANTED.load(Ordering::Relaxed);
        }
        LAST_CONFIRMED_PREFLIGHT_EPOCH.store(now, Ordering::Relaxed);
        let granted = unsafe { CGPreflightListenEventAccess() };
        if !granted {
            CONFIRMED_GRANTED.store(false, Ordering::Relaxed);
        }
        CACHED_GRANTED.store(granted, Ordering::Relaxed);
        return granted;
    }

    let now = Utc::now().timestamp();

    let preflight = unsafe { CGPreflightListenEventAccess() };
    let last_probe_epoch = LAST_TAP_PROBE_EPOCH.load(Ordering::Relaxed);
    let probe_due =
        force_probe || preflight || should_retry_listen_event_tap_probe(last_probe_epoch, now);

    if !probe_due {
        return CACHED_GRANTED.load(Ordering::Relaxed);
    }

    // When the lightweight preflight says "yes", use a one-shot tap probe to
    // confirm it. When it says "no", keep the expensive probe on a longer backoff
    // so UI polling does not recreate taps every few seconds.
    let granted = try_listen_event_access_probe();
    LAST_TAP_PROBE_EPOCH.store(now, Ordering::Relaxed);
    if granted {
        CONFIRMED_GRANTED.store(true, Ordering::Relaxed);
    }
    CACHED_GRANTED.store(granted, Ordering::Relaxed);
    granted
}

#[cfg(not(target_os = "macos"))]
fn input_monitoring_granted_with_probe(_force_probe: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        return true;
    }

    false
}

fn input_monitoring_granted() -> bool {
    input_monitoring_granted_with_probe(false)
}

#[cfg(target_os = "macos")]
fn prompt_tracking_permission_access() -> TrackingPermissionStatus {
    if !input_monitoring_granted_with_probe(true) {
        let prompted = unsafe { CGRequestListenEventAccess() };

        // CGRequestListenEventAccess returns false without showing a prompt
        // when macOS has already asked the user before. In that case, open
        // System Settings so the user can toggle the permission manually.
        if !prompted && !input_monitoring_granted_with_probe(true) {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
                .spawn();
        }
    }

    tracking_permission_status_with_probe(true)
}

#[cfg(not(target_os = "macos"))]
fn prompt_tracking_permission_access() -> TrackingPermissionStatus {
    tracking_permission_status_with_probe(true)
}

fn tracking_permission_status() -> TrackingPermissionStatus {
    tracking_permission_status_with_probe(false)
}

fn tracking_permission_status_with_probe(force_probe: bool) -> TrackingPermissionStatus {
    let granted = input_monitoring_granted_with_probe(force_probe);
    TrackingPermissionStatus {
        supported: background_tracking_supported(),
        input_monitoring_granted: granted,
        all_granted: granted && background_tracking_supported(),
    }
}

fn background_tracking_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn normalize_app_name(raw_name: impl AsRef<str>) -> Option<String> {
    let trimmed = raw_name.as_ref().trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.chars().take(MAX_APP_NAME_CHARS).collect())
}

#[cfg(target_os = "macos")]
fn foreground_app_name() -> Option<String> {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let app_name = foreground_app_name_macos_inner();
        objc_autoreleasePoolPop(pool);
        app_name
    }
}

#[cfg(target_os = "macos")]
unsafe fn objc_class(name: &'static [u8]) -> *mut c_void {
    objc_getClass(name.as_ptr().cast::<c_char>())
}

#[cfg(target_os = "macos")]
unsafe fn objc_selector(name: &'static [u8]) -> *mut c_void {
    sel_registerName(name.as_ptr().cast::<c_char>())
}

#[cfg(target_os = "macos")]
unsafe fn foreground_app_name_macos_inner() -> Option<String> {
    let workspace_class = objc_class(b"NSWorkspace\0");
    if workspace_class.is_null() {
        return None;
    }

    let workspace = objc_msgSend_id(workspace_class, objc_selector(b"sharedWorkspace\0"));
    if workspace.is_null() {
        return None;
    }

    let application = objc_msgSend_id(workspace, objc_selector(b"frontmostApplication\0"));
    if application.is_null() {
        return None;
    }

    let localized_name = objc_msgSend_id(application, objc_selector(b"localizedName\0"));
    if localized_name.is_null() {
        return None;
    }

    let utf8_name =
        objc_msgSend_id(localized_name, objc_selector(b"UTF8String\0")).cast::<c_char>();
    if utf8_name.is_null() {
        return None;
    }

    normalize_app_name(CStr::from_ptr(utf8_name).to_string_lossy())
}

#[cfg(target_os = "windows")]
fn foreground_app_name() -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    unsafe {
        let foreground_window = GetForegroundWindow();
        if foreground_window.is_null() {
            return None;
        }

        let mut process_id = 0_u32;
        if GetWindowThreadProcessId(foreground_window, &mut process_id) == 0 || process_id == 0 {
            return None;
        }

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }

        let mut buffer = vec![0_u16; 32_768];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
        let _ = CloseHandle(process);
        if ok == 0 || len == 0 {
            return None;
        }

        let path = PathBuf::from(OsString::from_wide(&buffer[..len as usize]));
        let app_name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .or_else(|| path.file_name().and_then(|value| value.to_str()))?;
        normalize_app_name(app_name)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn foreground_app_name() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn system_idle_duration() -> Result<Duration, String> {
    let idle_seconds = unsafe {
        CGEventSourceSecondsSinceLastEventType(
            CGEventSourceStateID::HIDSystemState,
            ANY_INPUT_EVENT_TYPE,
        )
    };
    if !idle_seconds.is_finite() || idle_seconds.is_sign_negative() {
        return Err("Unable to read macOS idle time".into());
    }

    Ok(Duration::from_secs_f64(idle_seconds))
}

#[cfg(target_os = "windows")]
fn system_idle_duration() -> Result<Duration, String> {
    let mut last_input_info = LastInputInfo {
        cb_size: std::mem::size_of::<LastInputInfo>() as u32,
        dw_time: 0,
    };
    let ok = unsafe { GetLastInputInfo(&mut last_input_info) };
    if ok == 0 {
        return Err("Unable to read Windows idle time".into());
    }

    let now_ticks = unsafe { GetTickCount() };
    let idle_millis = now_ticks.wrapping_sub(last_input_info.dw_time) as u64;
    Ok(Duration::from_millis(idle_millis))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_idle_duration() -> Result<Duration, String> {
    Err("Global activity tracking is only implemented on macOS and Windows in this build".into())
}

fn spawn_activity_sampler(state: Arc<TrackerState>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut sleep_duration = Duration::from_secs(ACTIVE_SAMPLE_INTERVAL_SECS);
        loop {
            if state.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }

            state.refresh_input_access_cache();
            if state.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }
            let tracking_active = state.should_track();
            state.observe_recent_system_activity();
            if state.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }
            state.sample_current_minute();
            match state.persist_activity_store_if_due(false) {
                Ok(true) => state.clear_activity_persist_error(),
                Ok(false) => {}
                Err(error) => {
                    state.set_listener_error(format!("{ACTIVITY_PERSIST_ERROR_PREFIX}{error}"))
                }
            }

            sleep_duration = next_sampler_wait_duration(sleep_duration, tracking_active);

            let (lock, cvar) = &state.shutdown_condvar;
            let guard = lock.lock().expect("shutdown_condvar lock poisoned");
            if *guard {
                break;
            }
            let _ = cvar.wait_timeout(guard, sleep_duration);
        }
    })
}

fn next_sampler_wait_duration(previous: Duration, tracking_active: bool) -> Duration {
    if tracking_active {
        return Duration::from_secs(ACTIVE_SAMPLE_INTERVAL_SECS);
    }

    Duration::from_secs(previous.as_secs().saturating_mul(2).clamp(
        ACTIVE_SAMPLE_INTERVAL_SECS,
        MAX_INACTIVE_SAMPLE_INTERVAL_SECS,
    ))
}

fn should_retry_listen_event_tap_probe(last_probe_epoch: i64, now_epoch: i64) -> bool {
    now_epoch.saturating_sub(last_probe_epoch) >= LISTEN_EVENT_TAP_PROBE_BACKOFF_SECS
}

fn missing_tracking_access_tooltip() -> &'static str {
    if cfg!(target_os = "macos") {
        "Trackr • Enable Input Monitoring to start tracking"
    } else {
        "Trackr • Background tracking is not available in this build"
    }
}

fn format_duration_short(minutes: u16) -> String {
    let hours = minutes / 60;
    let mins = minutes % 60;
    if hours > 0 {
        format!("{hours}h {mins}m")
    } else {
        format!("{mins}m")
    }
}

fn format_clock_hhmm(minute_of_day: u16) -> String {
    let minute = minute_of_day % MINUTES_PER_DAY_U16;
    let hour = minute / 60;
    let mins = minute % 60;
    format!("{hour:02}:{mins:02}")
}

fn blend_pixel(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    color: [u8; 4],
    opacity: f32,
) {
    if x >= width || y >= height {
        return;
    }

    let src_a = (color[3] as f32 / 255.0) * opacity.clamp(0.0, 1.0);
    if src_a <= 0.0 {
        return;
    }

    let idx = ((y * width + x) * 4) as usize;
    let dst_a = rgba[idx + 3] as f32 / 255.0;
    let out_a = src_a + dst_a * (1.0 - src_a);

    if out_a <= 0.0 {
        return;
    }

    for channel in 0..3 {
        let src_c = color[channel] as f32 / 255.0;
        let dst_c = rgba[idx + channel] as f32 / 255.0;
        let out_c = (src_c * src_a + dst_c * dst_a * (1.0 - src_a)) / out_a;
        rgba[idx + channel] = (out_c.clamp(0.0, 1.0) * 255.0).round() as u8;
    }

    rgba[idx + 3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
}

#[allow(clippy::too_many_arguments)]
fn rounded_rect_coverage(
    px: f32,
    py: f32,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    radius: f32,
    feather: f32,
) -> f32 {
    let center_x = left + width * 0.5;
    let center_y = top + height * 0.5;
    let half_w = width * 0.5;
    let half_h = height * 0.5;
    let r = radius.min(half_w).min(half_h).max(0.0);

    let qx = (px - center_x).abs() - (half_w - r);
    let qy = (py - center_y).abs() - (half_h - r);

    let outside_x = qx.max(0.0);
    let outside_y = qy.max(0.0);
    let outside_dist = (outside_x * outside_x + outside_y * outside_y).sqrt();
    let inside_dist = qx.max(qy).min(0.0);
    let signed_distance = outside_dist + inside_dist - r;

    ((feather - signed_distance) / feather).clamp(0.0, 1.0)
}

#[allow(clippy::too_many_arguments)]
fn draw_rounded_rect(
    rgba: &mut [u8],
    canvas_width: u32,
    canvas_height: u32,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    radius: u32,
    color: [u8; 4],
) {
    let x0 = left.saturating_sub(2);
    let y0 = top.saturating_sub(2);
    let x1 = (left + width + 2).min(canvas_width);
    let y1 = (top + height + 2).min(canvas_height);

    for y in y0..y1 {
        for x in x0..x1 {
            let coverage = rounded_rect_coverage(
                x as f32 + 0.5,
                y as f32 + 0.5,
                left as f32,
                top as f32,
                width as f32,
                height as f32,
                radius as f32,
                TRAY_AA_FEATHER,
            );
            if coverage > 0.0 {
                blend_pixel(rgba, canvas_width, canvas_height, x, y, color, coverage);
            }
        }
    }
}

fn build_activity_tray_icon(
    tracker: &TrackerState,
    today: &TodayTimeline,
    now_minute: usize,
) -> Image<'static> {
    let is_blocked = !tracker.is_unlocked() || !tracker.has_required_input_access();

    let width = TRAY_ICON_WIDTH;
    let height = TRAY_ICON_HEIGHT;
    let mut rgba = vec![0_u8; (width * height * 4) as usize];

    let pill_left = TRAY_PILL_MARGIN_X;
    let pill_width = width.saturating_sub(TRAY_PILL_MARGIN_X * 2).max(1);
    let pill_top = (height.saturating_sub(TRAY_PILL_HEIGHT)) / 2;
    let pill_height = TRAY_PILL_HEIGHT.min(height);

    let inner_left = pill_left + TRAY_INNER_INSET;
    let inner_top = pill_top + TRAY_INNER_INSET;
    let inner_width = pill_width.saturating_sub(TRAY_INNER_INSET * 2).max(1);
    let inner_height = pill_height.saturating_sub(TRAY_INNER_INSET * 2).max(1);

    let white_pill = [248, 250, 255, 255];
    let active_color = [26, 196, 111, 255];
    let idle_color = [226, 71, 72, 255];
    let future_color = [122, 130, 144, 255];
    let awake_minutes: Vec<usize> = if is_blocked {
        (0..MINUTES_PER_DAY).collect()
    } else {
        (0..MINUTES_PER_DAY)
            .filter(|minute| !today.sleep_window.contains_minute(*minute))
            .collect()
    };
    let awake_count = awake_minutes.len();
    let observed_awake_count = if is_blocked {
        0
    } else {
        awake_minutes.partition_point(|minute| *minute <= now_minute)
    };

    draw_rounded_rect(
        &mut rgba,
        width,
        height,
        pill_left,
        pill_top,
        pill_width,
        pill_height,
        TRAY_CORNER_RADIUS,
        white_pill,
    );

    for local_x in 0..inner_width {
        let color = if is_blocked || awake_count == 0 {
            future_color
        } else {
            let mut slice_start = (local_x as usize * awake_count) / inner_width as usize;
            if slice_start >= awake_count {
                slice_start = awake_count - 1;
            }
            let slice_end = (((local_x + 1) as usize * awake_count) / inner_width as usize)
                .max(slice_start + 1)
                .min(awake_count);

            if slice_start >= observed_awake_count {
                future_color
            } else {
                let observed_end = slice_end.min(observed_awake_count);
                let has_active = (slice_start..observed_end).any(|index| {
                    let minute = awake_minutes[index];
                    today.timeline.get(minute).copied().unwrap_or(0) > 0
                });
                if has_active {
                    active_color
                } else {
                    idle_color
                }
            }
        };

        let x = inner_left + local_x;
        for y in inner_top..(inner_top + inner_height).min(height) {
            let coverage = rounded_rect_coverage(
                x as f32 + 0.5,
                y as f32 + 0.5,
                inner_left as f32,
                inner_top as f32,
                inner_width as f32,
                inner_height as f32,
                TRAY_CORNER_RADIUS.saturating_sub(TRAY_INNER_INSET) as f32,
                TRAY_AA_FEATHER,
            );
            if coverage > 0.0 {
                blend_pixel(&mut rgba, width, height, x, y, color, coverage);
            }
        }
    }

    Image::new_owned(rgba, width, height)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayVisualSnapshot {
    input_access_granted: bool,
    unlocked: bool,
    date: String,
    active_minutes: u16,
    currently_active: bool,
    sleep_mode: bool,
    sleep_window: SleepWindow,
    now_minute: usize,
}

#[derive(Clone, Copy)]
struct AppRuntimeState {
    started_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeProfile {
    started_hidden: bool,
}

fn tray_visual_snapshot(tracker: &TrackerState) -> TrayVisualSnapshot {
    let now = Local::now();
    let today = tracker.today_timeline();
    TrayVisualSnapshot {
        input_access_granted: tracker.has_required_input_access(),
        unlocked: tracker.is_unlocked(),
        date: today.date.clone(),
        active_minutes: today.active_minutes,
        currently_active: today.currently_active,
        sleep_mode: today.sleep_mode,
        sleep_window: today.sleep_window.clone(),
        now_minute: (now.hour() * 60 + now.minute()) as usize,
    }
}

fn refresh_tray_visuals(tracker: &TrackerState, tray_icon: &TrayIcon) {
    let today = tracker.today_timeline();
    let now = Local::now();
    let now_minute = (now.hour() * 60 + now.minute()) as usize;
    let icon = build_activity_tray_icon(tracker, &today, now_minute);

    if !tracker.has_required_input_access() {
        let _ = tray_icon.set_icon(Some(icon));
        let _ = tray_icon.set_icon_as_template(false);
        let _ = tray_icon.set_tooltip(Some(missing_tracking_access_tooltip()));
        return;
    }

    if !tracker.is_unlocked() {
        let _ = tray_icon.set_icon(Some(icon));
        let _ = tray_icon.set_icon_as_template(false);
        let _ = tray_icon.set_tooltip(Some("Trackr • Locked until payment"));
        return;
    }

    let status = if today.sleep_mode {
        "sleep mode"
    } else if today.currently_active {
        "active now"
    } else {
        "idle now"
    };
    let sleep_suffix = if today.sleep_window.enabled {
        format!(" • sleep {}", today.sleep_window.formatted_range())
    } else {
        String::new()
    };
    let tooltip = format!(
        "Trackr • {} active today • {status}{sleep_suffix}",
        format_duration_short(today.active_minutes),
    );
    let _ = tray_icon.set_icon(Some(icon));
    let _ = tray_icon.set_icon_as_template(false);
    let _ = tray_icon.set_tooltip(Some(tooltip));
}

fn spawn_tray_visual_updater(
    tracker: Arc<TrackerState>,
    tray_icon: TrayIcon,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut previous_snapshot: Option<TrayVisualSnapshot> = None;
        loop {
            if tracker.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }

            let snapshot = tray_visual_snapshot(&tracker);
            if previous_snapshot.as_ref() != Some(&snapshot) {
                refresh_tray_visuals(&tracker, &tray_icon);
                previous_snapshot = Some(snapshot);
            }

            let (lock, cvar) = &tracker.shutdown_condvar;
            let guard = lock.lock().expect("shutdown_condvar lock poisoned");
            if *guard {
                break;
            }
            let _ = cvar.wait_timeout(guard, Duration::from_secs(TRAY_REFRESH_SECS));
        }
    })
}

fn launched_via_autostart() -> bool {
    std::env::args_os().any(|arg| arg == "--autostart")
}

fn show_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
        } else {
            show_main_window(app_handle);
        }
    }
}

fn setup_tray(app: &tauri::App, tracker: &TrackerState) -> tauri::Result<TrayIcon> {
    let toggle_item = MenuItem::with_id(app, "toggle", "Show / Hide Trackr", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;
    let today = tracker.today_timeline();
    let now = Local::now();
    let initial_icon =
        build_activity_tray_icon(tracker, &today, (now.hour() * 60 + now.minute()) as usize);

    let tray_icon = TrayIconBuilder::new()
        .icon(initial_icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray: &TrayIcon, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(tray_icon)
}

struct SharedTracker(Arc<TrackerState>);
struct TrayState {
    tray_icon: TrayIcon,
}
struct BackgroundThreads {
    handles: Mutex<Vec<thread::JoinHandle<()>>>,
}

#[tauri::command]
fn get_app_runtime_profile(state: State<'_, AppRuntimeState>) -> AppRuntimeProfile {
    AppRuntimeProfile {
        started_hidden: state.started_hidden,
    }
}

#[tauri::command]
fn get_tracking_permission_status(state: State<'_, SharedTracker>) -> TrackingPermissionStatus {
    let status = state.0.tracking_permission_status();
    if status.all_granted && state.0.is_unlocked() {
        state.0.ensure_tracking_started();
    }
    status
}

#[tauri::command]
fn request_tracking_permission_access(
    state: State<'_, SharedTracker>,
    tray_state: State<'_, TrayState>,
) -> TrackingPermissionStatus {
    let status = state.0.request_tracking_permission_access();
    if status.all_granted && state.0.is_unlocked() {
        state.0.ensure_tracking_started();
    }
    refresh_tray_visuals(&state.0, &tray_state.tray_icon);
    status
}

#[tauri::command]
fn get_paywall_status(state: State<'_, SharedTracker>) -> PaywallStatus {
    state.0.paywall_status()
}

#[tauri::command]
fn set_pending_checkout_session(
    state: State<'_, SharedTracker>,
    session_id: Option<String>,
) -> Result<(), String> {
    state.0.set_pending_session_id(session_id)
}

#[tauri::command]
fn apply_entitlement(
    state: State<'_, SharedTracker>,
    tray_state: State<'_, TrayState>,
    entitlement: EntitlementCertificate,
) -> Result<PaywallStatus, String> {
    let status = state.0.apply_entitlement(entitlement)?;
    state.0.ensure_tracking_started();
    refresh_tray_visuals(&state.0, &tray_state.tray_icon);
    Ok(status)
}

#[tauri::command]
fn clear_entitlement(
    state: State<'_, SharedTracker>,
    tray_state: State<'_, TrayState>,
) -> Result<(), String> {
    state.0.clear_entitlement()?;
    refresh_tray_visuals(&state.0, &tray_state.tray_icon);
    Ok(())
}

#[tauri::command]
fn get_today_timeline(state: State<'_, SharedTracker>) -> Result<TodayTimeline, String> {
    state.0.require_tracking_ready()?;
    Ok(state.0.today_timeline())
}

#[tauri::command]
fn get_day_timeline(
    state: State<'_, SharedTracker>,
    date: String,
) -> Result<TodayTimeline, String> {
    state.0.require_tracking_ready()?;
    state.0.timeline_for_date_key(&date)
}

#[tauri::command]
fn get_heatmap(
    state: State<'_, SharedTracker>,
    days: Option<u16>,
) -> Result<Vec<HeatmapDay>, String> {
    state.0.require_tracking_ready()?;
    Ok(state.0.heatmap(days.unwrap_or(182)))
}

#[tauri::command]
fn get_storage_status(state: State<'_, SharedTracker>) -> Result<StorageStatus, String> {
    state.0.require_tracking_ready()?;
    Ok(state.0.storage_status())
}

#[tauri::command]
fn set_sleep_window(
    state: State<'_, SharedTracker>,
    tray_state: State<'_, TrayState>,
    enabled: bool,
    start_minute: u16,
    end_minute: u16,
) -> Result<SleepWindow, String> {
    state.0.require_tracking_ready()?;
    let saved = state.0.set_sleep_window(SleepWindow {
        enabled,
        start_minute,
        end_minute,
    })?;
    state.0.sample_current_minute();
    refresh_tray_visuals(&state.0, &tray_state.tray_icon);
    Ok(saved)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .args(["--autostart"])
            .build(),
    );

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
            }

            let app_data_dir = app.path().app_data_dir()?;
            let store_path = app_data_dir.join("activity.json");
            let paywall_path = app_data_dir.join("paywall_state.json");

            let tracker = Arc::new(TrackerState::new(store_path, paywall_path));
            app.manage(SharedTracker(tracker));
            let tracker_state = app.state::<SharedTracker>();
            if tracker_state.0.activity_store_needs_migration() {
                if let Err(error) = tracker_state.0.persist_activity_store_if_due(true) {
                    tracker_state
                        .0
                        .set_listener_error(format!("{ACTIVITY_PERSIST_ERROR_PREFIX}{error}"));
                } else {
                    tracker_state.0.clear_activity_persist_error();
                }
            }
            let _ = tracker_state.0.persist_paywall_store();
            if tracker_state.0.is_unlocked() {
                tracker_state.0.ensure_tracking_started();
            }
            let tray_icon = setup_tray(app, &tracker_state.0)?;
            refresh_tray_visuals(&tracker_state.0, &tray_icon);
            let tray_handle = spawn_tray_visual_updater(tracker_state.0.clone(), tray_icon.clone());
            app.manage(TrayState { tray_icon });
            app.manage(BackgroundThreads {
                handles: Mutex::new(vec![tray_handle]),
            });

            let should_show_window = !launched_via_autostart()
                || !tracker_state.0.is_unlocked()
                || !tracker_state.0.has_required_input_access();
            app.manage(AppRuntimeState {
                started_hidden: !should_show_window,
            });
            if should_show_window {
                show_main_window(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(tracker) = window.app_handle().try_state::<SharedTracker>() {
                    tracker.0.request_shutdown();
                    tracker.0.join_sampler_thread();
                }
                if let Some(bg) = window.app_handle().try_state::<BackgroundThreads>() {
                    if let Ok(mut handles) = bg.handles.lock() {
                        for handle in handles.drain(..) {
                            let _ = handle.join();
                        }
                    }
                }
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_runtime_profile,
            get_tracking_permission_status,
            request_tracking_permission_access,
            get_paywall_status,
            set_pending_checkout_session,
            apply_entitlement,
            clear_entitlement,
            get_today_timeline,
            get_day_timeline,
            get_heatmap,
            get_storage_status,
            set_sleep_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let tracker = app_handle.state::<SharedTracker>();
                tracker.0.request_shutdown();
                tracker.0.join_sampler_thread();
                if let Some(bg) = app_handle.try_state::<BackgroundThreads>() {
                    if let Ok(mut handles) = bg.handles.lock() {
                        for handle in handles.drain(..) {
                            let _ = handle.join();
                        }
                    }
                }
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    show_main_window(app_handle);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn temp_paths(prefix: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        let _ = fs::create_dir_all(&base);
        (base.join("activity.json"), base.join("paywall_state.json"))
    }

    fn enable_tracking_for_test(tracker: &TrackerState) {
        tracker.tracking_enabled.store(true, Ordering::Relaxed);
        tracker.input_access_granted.store(true, Ordering::Relaxed);
    }

    #[test]
    fn entitlement_signature_validation_passes_for_valid_payload() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let now_ms = now_epoch_ms();
        let mut entitlement = EntitlementCertificate {
            device_id: "device-1".into(),
            session_id: "cs_test_123".into(),
            payment_intent_id: "pi_test_123".into(),
            issued_at_epoch_ms: now_ms.saturating_sub(1_000),
            expires_at_epoch_ms: now_ms.saturating_add(30_000),
            signature_base64: String::new(),
        };
        let payload = canonical_entitlement_payload(&entitlement);
        let signature = signing_key.sign(payload.as_bytes());
        entitlement.signature_base64 = BASE64_STANDARD.encode(signature.to_bytes());

        let result = validate_entitlement_with_key(&entitlement, "device-1", &verifying_key);
        assert!(result.is_ok());
    }

    #[test]
    fn entitlement_signature_validation_fails_for_tampered_payload() {
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let now_ms = now_epoch_ms();
        let mut entitlement = EntitlementCertificate {
            device_id: "device-2".into(),
            session_id: "cs_test_123".into(),
            payment_intent_id: "pi_test_123".into(),
            issued_at_epoch_ms: now_ms.saturating_sub(1_000),
            expires_at_epoch_ms: now_ms.saturating_add(30_000),
            signature_base64: String::new(),
        };
        let payload = canonical_entitlement_payload(&entitlement);
        let signature = signing_key.sign(payload.as_bytes());
        entitlement.signature_base64 = BASE64_STANDARD.encode(signature.to_bytes());
        entitlement.payment_intent_id = "pi_test_tampered".into();

        let result = validate_entitlement_with_key(&entitlement, "device-2", &verifying_key);
        assert!(result.is_err());
    }

    #[test]
    fn tracker_starts_locked_without_entitlement() {
        let (store_path, paywall_path) = temp_paths("trackr-paywall-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path.clone());
        assert!(tracker.require_unlocked().is_err());
        assert!(!tracker.should_track());
        assert!(!tracker.tracking_started.load(Ordering::Relaxed));

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn listen_event_tap_probes_back_off_beyond_the_ui_poll_interval() {
        assert!(!should_retry_listen_event_tap_probe(0, 3));
        assert!(should_retry_listen_event_tap_probe(
            0,
            LISTEN_EVENT_TAP_PROBE_BACKOFF_SECS
        ));
    }

    #[test]
    fn inactive_sampler_wait_duration_escalates_and_resets_on_activity() {
        let mut wait = Duration::from_secs(ACTIVE_SAMPLE_INTERVAL_SECS);
        assert_eq!(
            next_sampler_wait_duration(wait, true),
            Duration::from_secs(ACTIVE_SAMPLE_INTERVAL_SECS)
        );

        wait = next_sampler_wait_duration(wait, false);
        assert_eq!(wait, Duration::from_secs(30));

        wait = next_sampler_wait_duration(wait, false);
        assert_eq!(wait, Duration::from_secs(60));

        for _ in 0..4 {
            wait = next_sampler_wait_duration(wait, false);
        }

        assert_eq!(wait, Duration::from_secs(MAX_INACTIVE_SAMPLE_INTERVAL_SECS));
        assert_eq!(
            next_sampler_wait_duration(wait, true),
            Duration::from_secs(ACTIVE_SAMPLE_INTERVAL_SECS)
        );
    }

    #[test]
    fn tracker_keeps_entitlement_on_startup_without_revalidation() {
        let (store_path, paywall_path) = temp_paths("trackr-invalid-entitlement-test");
        let stale_store = PaywallStore {
            device_id: "device-1".into(),
            entitlement: Some(EntitlementCertificate {
                device_id: "device-1".into(),
                session_id: "cs_stale".into(),
                payment_intent_id: "pi_stale".into(),
                issued_at_epoch_ms: now_epoch_ms(),
                expires_at_epoch_ms: now_epoch_ms().saturating_add(60_000),
                signature_base64: "not-a-valid-signature".into(),
            }),
            last_sync_at_epoch_ms: Some(now_epoch_ms()),
            next_sync_at_epoch_ms: Some(now_epoch_ms().saturating_add(60_000)),
            pending_session_id: Some("cs_pending".into()),
        };
        fs::write(
            &paywall_path,
            serde_json::to_vec(&stale_store).expect("serialize stale store"),
        )
        .expect("write stale paywall store");

        let tracker = TrackerState::new(store_path.clone(), paywall_path.clone());

        // Once paid, always paid — entitlement persists without re-validation.
        let status = tracker.paywall_status();
        assert_eq!(status.status, "unlocked");
        assert!(status.entitlement.is_some());

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn heatmap_excludes_minutes_inside_the_sleep_window() {
        let (store_path, paywall_path) = temp_paths("trackr-heatmap-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path.clone());
        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            let mut timeline = vec![0_u8; MINUTES_PER_DAY];
            timeline.iter_mut().take(120).for_each(|minute| *minute = 1);
            let historical_sleep_window = SleepWindow {
                enabled: true,
                start_minute: 0,
                end_minute: 60,
            };
            store.days.insert(
                today_key,
                StoredDay {
                    timeline,
                    app_timeline: vec![None; MINUTES_PER_DAY],
                    sleep_window: historical_sleep_window,
                },
            );
            store.sleep_window = SleepWindow {
                enabled: true,
                start_minute: 0,
                end_minute: 120,
            };
        }

        let heatmap = tracker.heatmap(1);
        assert_eq!(heatmap.len(), 1);
        assert_eq!(heatmap[0].active_minutes, 60);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn historical_days_keep_their_saved_sleep_window_after_later_edits() {
        let (store_path, paywall_path) = temp_paths("trackr-historical-sleep-window-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        let historical_date = (Local::now() - ChronoDuration::days(1)).date_naive();
        let historical_key = historical_date.format("%Y-%m-%d").to_string();
        let original_sleep_window = SleepWindow {
            enabled: true,
            start_minute: 0,
            end_minute: 60,
        };
        let newer_sleep_window = SleepWindow {
            enabled: true,
            start_minute: 0,
            end_minute: 120,
        };

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            let mut timeline = vec![0_u8; MINUTES_PER_DAY];
            timeline.iter_mut().take(120).for_each(|minute| *minute = 1);
            store.days.insert(
                historical_key.clone(),
                StoredDay {
                    timeline,
                    app_timeline: vec![None; MINUTES_PER_DAY],
                    sleep_window: original_sleep_window.clone(),
                },
            );
            store.sleep_window = newer_sleep_window.clone();
        }
        tracker.update_sleep_window_cache(&newer_sleep_window);

        let historical_day = tracker
            .timeline_for_date_key(&historical_key)
            .expect("historical day should exist");
        assert_eq!(historical_day.active_minutes, 60);
        assert_eq!(historical_day.sleep_window, original_sleep_window);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn record_input_epoch_marks_the_observed_minute_active() {
        let (store_path, paywall_path) = temp_paths("trackr-record-input-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        let input_time = Local::now() - ChronoDuration::seconds(5);
        let date_key = input_time.format("%Y-%m-%d").to_string();
        let minute_of_day = (input_time.hour() * 60 + input_time.minute()) as usize;
        tracker.record_input_epoch(input_time.timestamp());

        let recorded_day = tracker
            .timeline_for_date_key(&date_key)
            .expect("recorded day should exist");
        assert_eq!(recorded_day.timeline[minute_of_day], 1);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn record_input_epoch_respects_the_sleep_window() {
        let (store_path, paywall_path) = temp_paths("trackr-sleep-window-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        let input_time = Local::now() - ChronoDuration::seconds(5);
        let date_key = input_time.format("%Y-%m-%d").to_string();
        let minute_of_day = (input_time.hour() * 60 + input_time.minute()) as usize;
        let start_minute = minute_of_day as u16;
        let end_minute = ((minute_of_day + 1) % MINUTES_PER_DAY) as u16;
        let sleep_window = SleepWindow {
            enabled: true,
            start_minute,
            end_minute,
        };

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            store.sleep_window = sleep_window.clone();
        }
        tracker.update_sleep_window_cache(&sleep_window);
        tracker.record_input_epoch(input_time.timestamp());

        let recorded_day = tracker
            .timeline_for_date_key(&date_key)
            .expect("recorded day should exist");
        assert_eq!(recorded_day.timeline[minute_of_day], 0);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn tracker_starts_idle_until_recent_input_is_recorded() {
        let (store_path, paywall_path) = temp_paths("trackr-starts-idle-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        assert!(!tracker.is_currently_active());

        tracker.record_input_epoch(Utc::now().timestamp());
        assert!(tracker.is_currently_active());

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn historical_days_keep_their_original_sleep_window_after_edits() {
        let (store_path, paywall_path) = temp_paths("trackr-history-sleep-window-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        let yesterday = Local::now().date_naive() - ChronoDuration::days(1);
        let yesterday_key = yesterday.format("%Y-%m-%d").to_string();
        let historical_sleep_window = SleepWindow {
            enabled: true,
            start_minute: 0,
            end_minute: 60,
        };
        let current_sleep_window = SleepWindow {
            enabled: true,
            start_minute: 300,
            end_minute: 360,
        };

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            let mut timeline = vec![0_u8; MINUTES_PER_DAY];
            timeline.iter_mut().take(120).for_each(|minute| *minute = 1);
            store.days.insert(
                yesterday_key.clone(),
                StoredDay {
                    timeline,
                    app_timeline: vec![None; MINUTES_PER_DAY],
                    sleep_window: historical_sleep_window.clone(),
                },
            );
            store.sleep_window = historical_sleep_window.clone();
        }
        tracker.update_sleep_window_cache(&historical_sleep_window);

        tracker
            .set_sleep_window(current_sleep_window.clone())
            .expect("save current sleep window");

        let yesterday_timeline = tracker
            .timeline_for_date_key(&yesterday_key)
            .expect("historical day should still exist");
        assert_eq!(yesterday_timeline.sleep_window, historical_sleep_window);
        assert_eq!(yesterday_timeline.active_minutes, 60);
    }

    #[test]
    fn legacy_activity_store_loads_with_per_day_sleep_windows_and_marks_migration() {
        let (store_path, _paywall_path) = temp_paths("trackr-legacy-activity-migration-test");
        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let sleep_window = SleepWindow {
            enabled: true,
            start_minute: 0,
            end_minute: 60,
        };
        let mut legacy_timeline = vec![0_u8; MINUTES_PER_DAY];
        legacy_timeline
            .iter_mut()
            .take(120)
            .for_each(|minute| *minute = 1);
        let legacy_store = LegacyActivityStore {
            days: BTreeMap::from([(today_key.clone(), legacy_timeline)]),
            sleep_window: sleep_window.clone(),
        };
        fs::write(
            &store_path,
            serde_json::to_vec(&legacy_store).expect("serialize legacy store"),
        )
        .expect("write legacy store");

        let (loaded_store, needs_migration) = load_store(&store_path);
        let loaded_day = loaded_store.days.get(&today_key).expect("loaded day");

        assert!(needs_migration);
        assert_eq!(loaded_store.sleep_window, sleep_window);
        assert_eq!(loaded_day.sleep_window, sleep_window);
        assert_eq!(loaded_day.timeline.len(), MINUTES_PER_DAY);
        assert_eq!(loaded_day.app_timeline.len(), MINUTES_PER_DAY);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn stored_day_defaults_missing_app_timeline_for_old_day_files() {
        let stored_day: StoredDay = serde_json::from_value(serde_json::json!({
            "timeline": [1],
            "sleepWindow": {
                "enabled": false,
                "startMinute": 0,
                "endMinute": 0
            }
        }))
        .expect("parse stored day without app timeline");

        let normalized = stored_day.normalized();
        assert_eq!(normalized.timeline.len(), MINUTES_PER_DAY);
        assert_eq!(normalized.app_timeline.len(), MINUTES_PER_DAY);
        assert_eq!(normalized.app_timeline[0], None);
    }

    #[test]
    fn day_timeline_exposes_per_minute_app_timeline() {
        let (store_path, paywall_path) = temp_paths("trackr-app-timelines-api-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        let date = NaiveDate::from_ymd_opt(2024, 1, 2).expect("valid date");
        let date_key = date.format("%Y-%m-%d").to_string();
        let mut app_timeline = vec![None; MINUTES_PER_DAY];
        app_timeline[42] = Some("Terminal".to_string());

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            store.days.insert(
                date_key.clone(),
                StoredDay {
                    timeline: vec![0; MINUTES_PER_DAY],
                    app_timeline,
                    sleep_window: SleepWindow::default(),
                },
            );
        }

        let timeline = tracker
            .timeline_for_date_key(&date_key)
            .expect("day timeline should load");
        assert_eq!(timeline.app_timeline.len(), MINUTES_PER_DAY);
        assert_eq!(timeline.app_timeline[42].as_deref(), Some("Terminal"));

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn sampling_persists_activity_into_settings_and_per_day_files() {
        let (store_path, paywall_path) = temp_paths("trackr-day-file-persistence-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        tracker.record_input_epoch(Utc::now().timestamp());
        tracker
            .persist_activity_store_if_due(true)
            .expect("flush pending activity changes");

        let settings: ActivityStoreSettings =
            serde_json::from_slice(&fs::read(&store_path).expect("read activity settings"))
                .expect("parse activity settings");
        assert_eq!(settings.version, ACTIVITY_STORE_FORMAT_VERSION);

        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let day_path = activity_day_store_path(&store_path, &today_key);
        let persisted_day: StoredDay =
            serde_json::from_slice(&fs::read(&day_path).expect("read day file"))
                .expect("parse day file");
        assert_eq!(persisted_day.timeline.len(), MINUTES_PER_DAY);
        assert!(persisted_day.timeline.iter().any(|value| *value > 0));

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn activity_changes_stay_dirty_until_flushed() {
        let (store_path, paywall_path) = temp_paths("trackr-dirty-until-flush-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        tracker.record_input_epoch(Utc::now().timestamp());

        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let day_path = activity_day_store_path(&store_path, &today_key);
        assert!(tracker.has_pending_activity_persist());
        assert!(!store_path.exists());
        assert!(!day_path.exists());

        tracker
            .persist_activity_store_if_due(true)
            .expect("flush pending activity changes");

        assert!(store_path.exists());
        assert!(day_path.exists());
        assert!(!tracker.has_pending_activity_persist());

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn set_sleep_window_without_today_record_only_updates_settings() {
        let (store_path, paywall_path) = temp_paths("trackr-sleep-window-settings-only-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        enable_tracking_for_test(&tracker);

        let updated_sleep_window = SleepWindow {
            enabled: true,
            start_minute: 300,
            end_minute: 420,
        };
        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let day_path = activity_day_store_path(&store_path, &today_key);

        tracker
            .set_sleep_window(updated_sleep_window.clone())
            .expect("save sleep window without a today record");

        let settings: ActivityStoreSettings =
            serde_json::from_slice(&fs::read(&store_path).expect("read activity settings"))
                .expect("parse activity settings");
        assert_eq!(settings.sleep_window, updated_sleep_window);
        assert!(!day_path.exists());

        tracker.record_input_epoch(Utc::now().timestamp());
        tracker
            .persist_activity_store_if_due(true)
            .expect("flush day created after sleep-window edit");

        let persisted_day: StoredDay =
            serde_json::from_slice(&fs::read(&day_path).expect("read day file"))
                .expect("parse day file");
        assert_eq!(persisted_day.sleep_window, updated_sleep_window);

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn prune_old_days_removes_oldest_day_file_on_flush() {
        let (store_path, paywall_path) = temp_paths("trackr-prune-day-files-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path);
        let oldest_date = NaiveDate::from_ymd_opt(2024, 1, 1).expect("valid oldest date");
        let oldest_key = oldest_date.format("%Y-%m-%d").to_string();
        let oldest_day_path = activity_day_store_path(&store_path, &oldest_key);

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            store.days.insert(
                oldest_key.clone(),
                StoredDay {
                    timeline: vec![1; MINUTES_PER_DAY],
                    app_timeline: vec![None; MINUTES_PER_DAY],
                    sleep_window: SleepWindow::default(),
                },
            );
        }
        tracker.mark_day_dirty(oldest_key.clone());
        tracker
            .persist_activity_store_if_due(true)
            .expect("persist oldest day");
        assert!(oldest_day_path.exists());

        let removed_day_keys = {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            for offset in 1..=MAX_DAYS_STORED {
                let date_key = (oldest_date + ChronoDuration::days(offset as i64))
                    .format("%Y-%m-%d")
                    .to_string();
                store.days.insert(
                    date_key,
                    StoredDay {
                        timeline: vec![0; MINUTES_PER_DAY],
                        app_timeline: vec![None; MINUTES_PER_DAY],
                        sleep_window: SleepWindow::default(),
                    },
                );
            }
            store.prune_old_days()
        };

        assert_eq!(removed_day_keys, vec![oldest_key.clone()]);
        tracker.mark_deleted_days(&removed_day_keys);
        tracker
            .persist_activity_store_if_due(true)
            .expect("remove oldest pruned day file");

        assert!(!oldest_day_path.exists());
        assert!(!tracker
            .store
            .lock()
            .expect("store lock poisoned")
            .days
            .contains_key(&oldest_key));

        if let Some(parent) = store_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
