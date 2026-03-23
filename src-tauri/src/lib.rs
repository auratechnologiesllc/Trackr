use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Local, NaiveDate, Timelike, Utc};
#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    EventField,
};
use ed25519_dalek::{pkcs8::DecodePublicKey, Signature, Verifier, VerifyingKey};
#[cfg(target_os = "windows")]
use rdev::{listen as listen_global_input, EventType as RdevEventType};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU16, AtomicU64, Ordering},
        Arc, Mutex,
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
const MIN_KEY_PRESSES_PER_ACTIVE_MINUTE: u16 = 6;
const MIN_MOUSE_MOVEMENT_UNITS_PER_ACTIVE_MINUTE: u32 = 150;
const ACTIVE_SCORE_THRESHOLD: u16 =
    MIN_KEY_PRESSES_PER_ACTIVE_MINUTE * MIN_MOUSE_MOVEMENT_UNITS_PER_ACTIVE_MINUTE as u16;
const MAX_DAYS_STORED: usize = 730;
const MINUTES_PER_DAY_U16: u16 = MINUTES_PER_DAY as u16;
const MINUTE_ACTIVITY_SCORE_BITS: u32 = 16;
const MINUTE_ACTIVITY_SCORE_MASK: u64 = (1_u64 << MINUTE_ACTIVITY_SCORE_BITS) - 1;
const TRAY_ICON_SCALE: u32 = 3;
const TRAY_ICON_WIDTH: u32 = 62 * TRAY_ICON_SCALE;
const TRAY_ICON_HEIGHT: u32 = 20 * TRAY_ICON_SCALE;
const TRAY_PILL_MARGIN_X: u32 = 2 * TRAY_ICON_SCALE;
const TRAY_PILL_HEIGHT: u32 = 12 * TRAY_ICON_SCALE;
const TRAY_INNER_INSET: u32 = 1 * TRAY_ICON_SCALE;
const TRAY_CORNER_RADIUS: u32 = 6 * TRAY_ICON_SCALE;
const TRAY_AA_FEATHER: f32 = 1.2;
const TRAY_REFRESH_SECS: u64 = 20;
const PAYWALL_LOCKED_ERROR: &str = "PAYWALL_LOCKED";
const INPUT_MONITORING_REQUIRED_ERROR: &str = "INPUT_MONITORING_REQUIRED";
const PAYWALL_SYNC_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const PAYWALL_CERT_DURATION_MS: u64 = 400 * 24 * 60 * 60 * 1000;
// Development fallback only. Release builds must inject TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64.
const DEFAULT_PAYWALL_PUBLIC_KEY_DER_BASE64: &str =
    "MCowBQYDK2VwAyEA85qbsp0q0HG3PTnDOzZndogIhfJMdCrDUPgW9cORxAM=";
const INPUT_MONITORING_PERMISSION_MESSAGE: &str =
    "Trackr needs Input Monitoring permission in System Settings > Privacy & Security > Input Monitoring to track keyboard and mouse activity outside the app.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TodayTimeline {
    date: String,
    timeline: Vec<u8>,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct PaywallStore {
    device_id: String,
    entitlement: Option<EntitlementCertificate>,
    last_sync_at_epoch_ms: Option<u64>,
    next_sync_at_epoch_ms: Option<u64>,
    pending_session_id: Option<String>,
}

impl Default for PaywallStore {
    fn default() -> Self {
        Self {
            device_id: String::new(),
            entitlement: None,
            last_sync_at_epoch_ms: None,
            next_sync_at_epoch_ms: None,
            pending_session_id: None,
        }
    }
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

#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(default)]
struct ActivityStore {
    days: BTreeMap<String, Vec<u8>>,
    sleep_window: SleepWindow,
}

impl Default for ActivityStore {
    fn default() -> Self {
        Self {
            days: BTreeMap::new(),
            sleep_window: SleepWindow::default(),
        }
    }
}

impl ActivityStore {
    fn prune_old_days(&mut self) {
        if self.days.len() <= MAX_DAYS_STORED {
            return;
        }

        let remove_count = self.days.len() - MAX_DAYS_STORED;
        let keys: Vec<String> = self.days.keys().take(remove_count).cloned().collect();
        for key in keys {
            self.days.remove(&key);
        }
    }
}

fn activity_score_delta(key_presses: u16, mouse_movement_units: u32) -> u16 {
    let delta = u32::from(key_presses)
        .saturating_mul(MIN_MOUSE_MOVEMENT_UNITS_PER_ACTIVE_MINUTE)
        .saturating_add(
            mouse_movement_units.saturating_mul(u32::from(MIN_KEY_PRESSES_PER_ACTIVE_MINUTE)),
        );
    delta.min(u32::from(ACTIVE_SCORE_THRESHOLD)) as u16
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
#[derive(Debug, Clone, Copy, Default)]
struct InputDelta {
    key_presses: u16,
    mouse_movement_units: u32,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

struct TrackerState {
    store: Mutex<ActivityStore>,
    store_path: PathBuf,
    paywall_store: Mutex<PaywallStore>,
    paywall_path: PathBuf,
    minute_activity: AtomicU64,
    last_input_epoch: AtomicI64,
    listener_error: Mutex<Option<String>>,
    input_access_granted: AtomicBool,
    sleep_window_enabled: AtomicBool,
    sleep_window_start_minute: AtomicU16,
    sleep_window_end_minute: AtomicU16,
    tracking_enabled: AtomicBool,
    tracking_started: AtomicBool,
}

impl TrackerState {
    fn new(store_path: PathBuf, paywall_path: PathBuf) -> Self {
        let epoch_minute = Utc::now().timestamp().div_euclid(60);
        let activity_store = load_store(&store_path);
        let sleep_window = activity_store.sleep_window.clone();
        let mut paywall_store = load_paywall_store(&paywall_path);
        let has_valid_entitlement = paywall_store
            .entitlement
            .as_ref()
            .and_then(|entitlement| {
                validate_entitlement(entitlement, &paywall_store.device_id).ok()
            })
            .is_some();
        if !has_valid_entitlement {
            paywall_store.entitlement = None;
            paywall_store.last_sync_at_epoch_ms = None;
            paywall_store.next_sync_at_epoch_ms = None;
        }
        let input_access_granted = input_monitoring_granted();
        Self {
            store: Mutex::new(activity_store),
            store_path,
            paywall_store: Mutex::new(paywall_store),
            paywall_path,
            minute_activity: AtomicU64::new(pack_minute_activity(epoch_minute, 0)),
            last_input_epoch: AtomicI64::new(Utc::now().timestamp()),
            listener_error: Mutex::new(None),
            input_access_granted: AtomicBool::new(input_access_granted),
            sleep_window_enabled: AtomicBool::new(sleep_window.enabled),
            sleep_window_start_minute: AtomicU16::new(sleep_window.start_minute),
            sleep_window_end_minute: AtomicU16::new(sleep_window.end_minute),
            tracking_enabled: AtomicBool::new(has_valid_entitlement),
            tracking_started: AtomicBool::new(false),
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

    fn ensure_tracking_started(self: &Arc<Self>) {
        if self
            .tracking_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.sample_current_minute();
            spawn_activity_sampler(self.clone());
            spawn_input_listener(self.clone());
        }
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
        {
            let mut store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            store.pending_session_id = session_id;
        }
        self.persist_paywall_store()
    }

    fn apply_entitlement(
        &self,
        entitlement: EntitlementCertificate,
    ) -> Result<PaywallStatus, String> {
        let now_ms = now_epoch_ms();
        {
            let mut store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            validate_entitlement(&entitlement, &store.device_id)?;
            store.entitlement = Some(entitlement);
            store.last_sync_at_epoch_ms = Some(now_ms);
            store.next_sync_at_epoch_ms = Some(now_ms.saturating_add(PAYWALL_SYNC_INTERVAL_MS));
            store.pending_session_id = None;
        }
        self.persist_paywall_store()?;
        self.tracking_enabled.store(true, Ordering::Relaxed);
        Ok(self.paywall_status())
    }

    fn clear_entitlement(&self) -> Result<(), String> {
        {
            let mut store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            store.entitlement = None;
            store.last_sync_at_epoch_ms = None;
            store.next_sync_at_epoch_ms = None;
            store.pending_session_id = None;
        }
        self.persist_paywall_store()?;
        self.tracking_enabled.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn tracking_permission_status(&self) -> TrackingPermissionStatus {
        let status = tracking_permission_status();
        self.input_access_granted
            .store(status.input_monitoring_granted, Ordering::Relaxed);
        status
    }

    fn request_tracking_permission_access(&self) -> TrackingPermissionStatus {
        let status = prompt_tracking_permission_access();
        self.input_access_granted
            .store(status.input_monitoring_granted, Ordering::Relaxed);
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

    fn add_activity_score(&self, epoch_minute: i64, delta_score: u16) {
        if delta_score == 0 {
            return;
        }

        loop {
            let current = self.minute_activity.load(Ordering::Relaxed);
            let (current_minute, current_score) = unpack_minute_activity(current);
            let next_score = if current_minute == epoch_minute {
                current_score
                    .saturating_add(delta_score)
                    .min(ACTIVE_SCORE_THRESHOLD)
            } else {
                delta_score.min(ACTIVE_SCORE_THRESHOLD)
            };
            let next = pack_minute_activity(epoch_minute, next_score);

            if self
                .minute_activity
                .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return;
            }
        }
    }

    fn record_input_activity(&self, key_presses: u16, mouse_movement_units: u32) {
        if !self.should_track() {
            return;
        }

        if self.is_sleep_now() {
            return;
        }

        let now_utc = Utc::now();
        self.last_input_epoch
            .store(now_utc.timestamp(), Ordering::Relaxed);

        let delta_score = activity_score_delta(key_presses, mouse_movement_units);
        if delta_score == 0 {
            return;
        }

        let epoch_minute = now_utc.timestamp().div_euclid(60);
        self.add_activity_score(epoch_minute, delta_score);
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
        *listener_error = None;
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
        {
            let mut store = self.store.lock().expect("store lock poisoned");
            store.sleep_window = normalized.clone();
        }
        self.update_sleep_window_cache(&normalized);
        self.persist_store()?;
        Ok(normalized)
    }

    fn is_sleep_now(&self) -> bool {
        let now = Local::now();
        let minute_of_day = (now.hour() * 60 + now.minute()) as usize;
        self.sleep_window().contains_minute(minute_of_day)
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

        let mut changed = false;
        {
            let mut store = self.store.lock().expect("store lock poisoned");
            let day_was_missing = !store.days.contains_key(&date_key);
            let day = store
                .days
                .entry(date_key)
                .or_insert_with(|| vec![0; MINUTES_PER_DAY]);

            if day_was_missing {
                changed = true;
            }

            if day.len() != MINUTES_PER_DAY {
                day.resize(MINUTES_PER_DAY, 0);
                changed = true;
            }

            if day[minute_of_day] != active_flag {
                day[minute_of_day] = active_flag;
                changed = true;
            }

            let day_count_before_prune = store.days.len();
            store.prune_old_days();
            if store.days.len() != day_count_before_prune {
                changed = true;
            }
        }

        if changed {
            let _ = self.persist_store();
        }
    }

    fn persist_store(&self) -> Result<(), String> {
        let bytes = {
            let store = self.store.lock().expect("store lock poisoned");
            serde_json::to_vec(&*store).map_err(|err| format!("serialize store: {err}"))?
        };

        if let Some(parent) = self.store_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("create data directory: {err}"))?;
        }

        let temp_path = self.store_path.with_extension("tmp");
        fs::write(&temp_path, bytes).map_err(|err| format!("write temp activity file: {err}"))?;
        fs::rename(&temp_path, &self.store_path)
            .map_err(|err| format!("replace activity file: {err}"))?;

        Ok(())
    }

    fn persist_paywall_store(&self) -> Result<(), String> {
        let bytes = {
            let store = self
                .paywall_store
                .lock()
                .expect("paywall_store lock poisoned");
            serde_json::to_vec(&*store).map_err(|err| format!("serialize paywall store: {err}"))?
        };

        if let Some(parent) = self.paywall_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("create paywall directory: {err}"))?;
        }

        let temp_path = self.paywall_path.with_extension("tmp");
        fs::write(&temp_path, bytes).map_err(|err| format!("write temp paywall file: {err}"))?;
        fs::rename(&temp_path, &self.paywall_path)
            .map_err(|err| format!("replace paywall file: {err}"))?;

        Ok(())
    }

    fn timeline_for_date(&self, date: NaiveDate) -> TodayTimeline {
        let now = Local::now();
        let today = now.date_naive();
        let is_today = date == today;
        let date_key = date.format("%Y-%m-%d").to_string();
        let minute_of_day = (now.hour() * 60 + now.minute()) as usize;

        let (mut timeline, sleep_window) = {
            let store = self.store.lock().expect("store lock poisoned");
            (
                store.days.get(&date_key).cloned().unwrap_or_default(),
                store.sleep_window.clone(),
            )
        };

        if timeline.len() != MINUTES_PER_DAY {
            timeline.resize(MINUTES_PER_DAY, 0);
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
        let sleep_window = store.sleep_window.clone();

        (0..capped_days)
            .rev()
            .map(|offset| {
                let date = today - ChronoDuration::days(offset as i64);
                let date_key = date.format("%Y-%m-%d").to_string();
                let active_minutes = store
                    .days
                    .get(&date_key)
                    .map(|timeline| {
                        timeline
                            .iter()
                            .enumerate()
                            .filter(|(minute, _)| !sleep_window.contains_minute(*minute))
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
        let store_file_exists = metadata.is_some();
        let store_file_size_bytes = metadata.as_ref().map_or(0, |meta| meta.len());
        let last_persisted_at_epoch_ms = metadata
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());

        StorageStatus {
            store_path: self.store_path.to_string_lossy().into_owned(),
            persisted_day_count,
            store_file_exists,
            store_file_size_bytes,
            last_persisted_at_epoch_ms,
        }
    }
}

fn load_store(path: &Path) -> ActivityStore {
    let file = match fs::read(path) {
        Ok(file) => file,
        Err(_) => return ActivityStore::default(),
    };

    let mut store = serde_json::from_slice::<ActivityStore>(&file).unwrap_or_default();
    for timeline in store.days.values_mut() {
        if timeline.len() != MINUTES_PER_DAY {
            timeline.resize(MINUTES_PER_DAY, 0);
        }
    }
    store.sleep_window = store.sleep_window.clone().normalized();
    store
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
    let mut store = match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PaywallStore>(&bytes).ok())
    {
        Some(store) => store,
        None => PaywallStore::default(),
    };

    if store.device_id.trim().is_empty() {
        store.device_id = Uuid::new_v4().to_string();
    }

    store
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
fn input_monitoring_granted() -> bool {
    use std::sync::atomic::AtomicI64;

    // Cache the CGEventTap probe result to avoid creating/destroying a Mach port
    // on every input event. Re-probe at most once every 2 seconds.
    static CACHED_GRANTED: AtomicBool = AtomicBool::new(false);
    static LAST_CHECK_EPOCH: AtomicI64 = AtomicI64::new(0);

    let now = Utc::now().timestamp();
    let last = LAST_CHECK_EPOCH.load(Ordering::Relaxed);

    if now - last < 2 {
        return CACHED_GRANTED.load(Ordering::Relaxed);
    }

    LAST_CHECK_EPOCH.store(now, Ordering::Relaxed);

    // CGPreflightListenEventAccess can return stale results after rebuilds or
    // permission toggles. Try creating a throwaway event tap as the ground truth.
    let granted = CGEventTap::new(
        CGEventTapLocation::HID,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::MouseMoved],
        |_proxy, _event_type, event| Some(event.clone()),
    )
    .is_ok()
        || unsafe { CGPreflightListenEventAccess() };

    CACHED_GRANTED.store(granted, Ordering::Relaxed);
    granted
}

#[cfg(not(target_os = "macos"))]
fn input_monitoring_granted() -> bool {
    #[cfg(target_os = "windows")]
    {
        return true;
    }

    false
}

#[cfg(target_os = "macos")]
fn prompt_tracking_permission_access() -> TrackingPermissionStatus {
    if !input_monitoring_granted() {
        let prompted = unsafe { CGRequestListenEventAccess() };

        // CGRequestListenEventAccess returns false without showing a prompt
        // when macOS has already asked the user before. In that case, open
        // System Settings so the user can toggle the permission manually.
        if !prompted && !input_monitoring_granted() {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
                .spawn();
        }
    }

    tracking_permission_status()
}

#[cfg(not(target_os = "macos"))]
fn prompt_tracking_permission_access() -> TrackingPermissionStatus {
    tracking_permission_status()
}

fn tracking_permission_status() -> TrackingPermissionStatus {
    let granted = input_monitoring_granted();
    TrackingPermissionStatus {
        supported: background_tracking_supported(),
        input_monitoring_granted: granted,
        all_granted: granted && background_tracking_supported(),
    }
}

fn background_tracking_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn abs_i64_to_u32(value: i64) -> u32 {
    let abs_value = value.checked_abs().unwrap_or(i64::MAX) as u64;
    abs_value.min(u64::from(u32::MAX)) as u32
}

#[cfg(target_os = "macos")]
fn pointer_movement_units(event: &CGEvent) -> u32 {
    let delta_x = abs_i64_to_u32(event.get_integer_value_field(EventField::MOUSE_EVENT_DELTA_X));
    let delta_y = abs_i64_to_u32(event.get_integer_value_field(EventField::MOUSE_EVENT_DELTA_Y));
    delta_x.saturating_add(delta_y)
}

#[cfg(target_os = "macos")]
fn scroll_movement_units(event: &CGEvent) -> u32 {
    let mut delta_axis_1 = abs_i64_to_u32(
        event.get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_1),
    );
    let mut delta_axis_2 = abs_i64_to_u32(
        event.get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_2),
    );

    if delta_axis_1 == 0 && delta_axis_2 == 0 {
        delta_axis_1 = abs_i64_to_u32(
            event.get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_1),
        );
        delta_axis_2 = abs_i64_to_u32(
            event.get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_2),
        );
    }

    delta_axis_1.saturating_add(delta_axis_2)
}

#[cfg(target_os = "macos")]
fn activity_delta(event_type: CGEventType, event: &CGEvent) -> Option<InputDelta> {
    match event_type {
        CGEventType::KeyDown => Some(InputDelta {
            key_presses: 1,
            mouse_movement_units: 0,
        }),
        CGEventType::KeyUp
        | CGEventType::FlagsChanged
        | CGEventType::LeftMouseDown
        | CGEventType::LeftMouseUp
        | CGEventType::RightMouseDown
        | CGEventType::RightMouseUp
        | CGEventType::OtherMouseDown
        | CGEventType::OtherMouseUp => Some(InputDelta::default()),
        CGEventType::MouseMoved
        | CGEventType::LeftMouseDragged
        | CGEventType::RightMouseDragged
        | CGEventType::OtherMouseDragged => Some(InputDelta {
            key_presses: 0,
            mouse_movement_units: pointer_movement_units(event),
        }),
        CGEventType::ScrollWheel => Some(InputDelta {
            key_presses: 0,
            mouse_movement_units: scroll_movement_units(event),
        }),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn pointer_delta_units(previous: (f64, f64), current: (f64, f64)) -> u32 {
    let delta = (current.0 - previous.0).abs() + (current.1 - previous.1).abs();
    delta.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

fn spawn_activity_sampler(state: Arc<TrackerState>) {
    thread::spawn(move || loop {
        state.sample_current_minute();
        thread::sleep(Duration::from_secs(SAMPLE_INTERVAL_SECS));
    });
}

#[cfg(target_os = "macos")]
fn spawn_input_listener(state: Arc<TrackerState>) {
    thread::spawn(move || loop {
        if !state.refresh_input_access_cache() {
            state.set_listener_error(INPUT_MONITORING_PERMISSION_MESSAGE.into());
            thread::sleep(Duration::from_secs(3));
            continue;
        }

        state.clear_listener_error();

        let listener_state = state.clone();
        let event_tap = match CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::KeyDown,
                CGEventType::KeyUp,
                CGEventType::FlagsChanged,
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
                CGEventType::MouseMoved,
                CGEventType::LeftMouseDragged,
                CGEventType::RightMouseDragged,
                CGEventType::OtherMouseDragged,
                CGEventType::ScrollWheel,
            ],
            move |_proxy, event_type, event| {
                if matches!(
                    event_type,
                    CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
                ) {
                    listener_state
                        .set_listener_error("Input listener paused by macOS, restarting".into());
                    CFRunLoop::get_current().stop();
                    return None;
                }

                if let Some(delta) = activity_delta(event_type, event) {
                    listener_state
                        .record_input_activity(delta.key_presses, delta.mouse_movement_units);
                }

                None
            },
        ) {
            Ok(tap) => tap,
            Err(_) => {
                state.set_listener_error(
                    "Failed to start macOS input listener. Check Input Monitoring permission."
                        .into(),
                );
                thread::sleep(Duration::from_secs(5));
                continue;
            }
        };

        let runloop_source = match event_tap.mach_port.create_runloop_source(0) {
            Ok(source) => source,
            Err(_) => {
                state.set_listener_error("Failed to create listener run loop source".into());
                thread::sleep(Duration::from_secs(5));
                continue;
            }
        };

        let current_loop = CFRunLoop::get_current();
        current_loop.add_source(&runloop_source, unsafe { kCFRunLoopCommonModes });
        event_tap.enable();
        CFRunLoop::run_current();

        if state.listener_error().is_none() {
            state.set_listener_error("Input listener stopped unexpectedly, retrying".into());
        }
        thread::sleep(Duration::from_secs(2));
    });
}

#[cfg(target_os = "windows")]
fn spawn_input_listener(state: Arc<TrackerState>) {
    thread::spawn(move || loop {
        state.clear_listener_error();

        let listener_state = state.clone();
        let mut last_cursor_position: Option<(f64, f64)> = None;
        let result = listen_global_input(move |event| {
            let (key_presses, mouse_movement_units) = match event.event_type {
                RdevEventType::KeyPress(_) => (1, 0),
                RdevEventType::KeyRelease(_)
                | RdevEventType::ButtonPress(_)
                | RdevEventType::ButtonRelease(_) => (0, 0),
                RdevEventType::MouseMove { x, y } => {
                    let current = (x, y);
                    let movement_units = last_cursor_position
                        .map(|previous| pointer_delta_units(previous, current))
                        .unwrap_or(0);
                    last_cursor_position = Some(current);
                    (0, movement_units)
                }
                RdevEventType::Wheel { delta_x, delta_y } => (
                    0,
                    abs_i64_to_u32(delta_x).saturating_add(abs_i64_to_u32(delta_y)),
                ),
            };

            listener_state.record_input_activity(key_presses, mouse_movement_units);
        });

        let err = match result {
            Ok(()) => "Windows input listener stopped unexpectedly".to_string(),
            Err(error) => format!("Failed to start Windows input listener: {error:?}"),
        };
        state.set_listener_error(err);
        thread::sleep(Duration::from_secs(5));
    });
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn spawn_input_listener(state: Arc<TrackerState>) {
    thread::spawn(move || {
        state.set_listener_error(
            "Global activity tracking is only implemented on macOS and Windows in this build"
                .into(),
        );
        loop {
            thread::sleep(Duration::from_secs(5));
        }
    });
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

fn build_activity_tray_icon(tracker: &TrackerState) -> Image<'static> {
    let is_blocked = !tracker.is_unlocked() || !tracker.has_required_input_access();
    let today = tracker.today_timeline();
    let now = Local::now();
    let now_minute = (now.hour() * 60 + now.minute()) as usize;

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
        let color = if is_blocked {
            future_color
        } else if awake_count == 0 {
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

fn refresh_tray_visuals(tracker: &TrackerState, tray_icon: &TrayIcon) {
    if !tracker.has_required_input_access() {
        let icon = build_activity_tray_icon(tracker);
        let _ = tray_icon.set_icon(Some(icon));
        let _ = tray_icon.set_icon_as_template(false);
        let _ = tray_icon.set_tooltip(Some(missing_tracking_access_tooltip()));
        return;
    }

    if !tracker.is_unlocked() {
        let icon = build_activity_tray_icon(tracker);
        let _ = tray_icon.set_icon(Some(icon));
        let _ = tray_icon.set_icon_as_template(false);
        let _ = tray_icon.set_tooltip(Some("Trackr • Locked until payment"));
        return;
    }

    let today = tracker.today_timeline();
    let icon = build_activity_tray_icon(tracker);
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

fn spawn_tray_visual_updater(tracker: Arc<TrackerState>, tray_icon: TrayIcon) {
    thread::spawn(move || loop {
        refresh_tray_visuals(&tracker, &tray_icon);
        thread::sleep(Duration::from_secs(TRAY_REFRESH_SECS));
    });
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
    let initial_icon = build_activity_tray_icon(tracker);

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
            let _ = tracker_state.0.persist_paywall_store();
            if tracker_state.0.is_unlocked() {
                tracker_state.0.ensure_tracking_started();
            }
            let tray_icon = setup_tray(app, &tracker_state.0)?;
            refresh_tray_visuals(&tracker_state.0, &tray_icon);
            spawn_tray_visual_updater(tracker_state.0.clone(), tray_icon.clone());
            app.manage(TrayState { tray_icon });

            let should_show_window = !launched_via_autostart()
                || !tracker_state.0.is_unlocked()
                || !tracker_state.0.has_required_input_access();
            if should_show_window {
                show_main_window(app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
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
    fn heatmap_excludes_minutes_inside_the_sleep_window() {
        let (store_path, paywall_path) = temp_paths("trackr-heatmap-test");
        let tracker = TrackerState::new(store_path.clone(), paywall_path.clone());
        let today_key = Local::now().date_naive().format("%Y-%m-%d").to_string();

        {
            let mut store = tracker.store.lock().expect("store lock poisoned");
            let mut timeline = vec![0_u8; MINUTES_PER_DAY];
            timeline.iter_mut().take(120).for_each(|minute| *minute = 1);
            store.days.insert(today_key, timeline);
            store.sleep_window = SleepWindow {
                enabled: true,
                start_minute: 0,
                end_minute: 60,
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
    fn minute_is_active_when_keyboard_or_mouse_hits_individual_threshold() {
        assert!(activity_score_reached_threshold(activity_score_delta(
            MIN_KEY_PRESSES_PER_ACTIVE_MINUTE,
            0,
        )));
        assert!(activity_score_reached_threshold(activity_score_delta(
            0,
            MIN_MOUSE_MOVEMENT_UNITS_PER_ACTIVE_MINUTE,
        )));
    }

    #[test]
    fn minute_is_active_when_keyboard_and_mouse_activity_combine() {
        assert!(activity_score_reached_threshold(activity_score_delta(
            MIN_KEY_PRESSES_PER_ACTIVE_MINUTE / 2,
            MIN_MOUSE_MOVEMENT_UNITS_PER_ACTIVE_MINUTE / 2,
        )));
    }

    #[test]
    fn minute_stays_idle_when_combined_activity_is_still_below_threshold() {
        assert!(!activity_score_reached_threshold(activity_score_delta(
            2, 30
        )));
    }
}
