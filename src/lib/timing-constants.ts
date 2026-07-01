/**
 * Central timing constants for the adapter.
 *
 * Avoid magic numbers — when a constant is used in more than one place, import
 * it from here and give it a unique name.
 *
 * Convention: `_MS` for milliseconds, `_S` for seconds, `_MIN` for minutes.
 */

// === MQTT ===

/** Maximum consecutive auth failures before reconnect is stopped permanently. */
export const MQTT_MAX_AUTH_FAILURES = 3;

// === App API (sensor polling) ===

/** Interval for the App-API poll (sensor values). 2 min. */
export const APP_API_POLL_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Delay of the first App-API poll after adapter start (5 s — gives MQTT time
 * for the bearer login).
 */
export const APP_API_INITIAL_DELAY_MS = 5_000;

/**
 * Multiplier on a sensor's `uploadRate` (minutes) to derive its "still online"
 * data-freshness window. 3× tolerates two missed uploads before a sensor is
 * flagged offline. Some Govee gateway sensors (e.g. H5109 behind an H5042)
 * report `lastData.online:false` while readings keep flowing — deriving online
 * from Govee's own reading timestamp (`lastData.lastTime`) is the reliable
 * signal, mirroring the Lights 90 s-LAN-freshness idea for a data channel.
 */
export const SENSOR_ONLINE_FRESHNESS_MULTIPLIER = 3;

/** Floor for the sensor data-freshness window (15 min) — fast-uploading sensors. */
export const SENSOR_ONLINE_FRESHNESS_MIN_MS = 15 * 60 * 1000;

/** Cap for the sensor data-freshness window (90 min) — slow-uploading sensors. */
export const SENSOR_ONLINE_FRESHNESS_MAX_MS = 90 * 60 * 1000;

/** Default sensor data-freshness window when `uploadRate` is unknown (30 min). */
export const SENSOR_ONLINE_FRESHNESS_DEFAULT_MS = 30 * 60 * 1000;

// === Adapter lifecycle ===

/** Hard timeout for cloud initialisation (60 s). */
export const READY_TIMEOUT_MS = 60_000;

/**
 * Floor for a rate-limit retry pause (5 s). A malformed/zero server `Retry-After`
 * must not collapse into an immediate-retry tight loop that hammers the Cloud
 * (Govee allows 10 requests/min) — clamp the server value up to this minimum.
 */
export const MIN_RATE_LIMIT_RETRY_MS = 5_000;

/** Minimum gap between two `mqttAuth: requestCode` calls (30 s). */
export const VERIFICATION_REQUEST_THROTTLE_MS = 30_000;

/**
 * How long the admin "Test login" probe waits for the MQTT socket to actually
 * connect + subscribe AFTER the login/cert handshake already succeeded (10 s).
 * A timeout means "credentials fine, MQTT not up" — it also guarantees the
 * admin sendTo never hangs waiting on the probe.
 */
export const MQTT_PROBE_CONNECT_MS = 10_000;

/** Initial wait for the first LAN-scan replies before flipping lanScanDone (3 s). */
export const LAN_SCAN_INITIAL_WAIT_MS = 3_000;

/** Multicast LAN-discovery scan interval (30 s). */
export const LAN_SCAN_INTERVAL_MS = 30_000;

/** info.online re-evaluation interval for all devices (20 s). */
export const ONLINE_SYNC_INTERVAL_MS = 20_000;

/** Safety timeout to log "ready" even if a channel is still settling (60 s). */
export const READY_SAFETY_TIMEOUT_MS = 60_000;

/** Delay after startup before reaping stale devices (30 s — lets the LAN scan settle). */
export const STALE_DEVICE_CLEANUP_DELAY_MS = 30_000;

/** Daily app-version-drift check interval (24 h). */
export const APP_VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Initial app-version-drift check delay after startup (2 min). */
export const APP_VERSION_INITIAL_DELAY_MS = 2 * 60 * 1000;

/** Fallback retry delay after a transient Cloud-load failure (5 min). */
export const TRANSIENT_RETRY_MS = 5 * 60_000;

/** Per-device diagnostics-export throttle (2 s) — guards against button spam. */
export const DIAGNOSTICS_EXPORT_THROTTLE_MS = 2_000;

// === Wizard ===

/** Idle timeout for the segment-detection wizard (5 min). */
export const WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;

// === LAN command-router ===

/**
 * Wait time between a `colorwc` mode switch and the following segment commands.
 * Empirically ~150 ms; any shorter and Govee swallows the segment update because
 * the device is still in scene/music mode.
 */
export const FORCE_COLOR_MODE_SETTLE_MS = 150;

// === Cloud rate-limiter ===

/**
 * Govee Cloud-API budget (with safety margins). Govee allows 10/min and
 * 10,000/day — we stay at 8/min and 9,000/day so spikes (e.g. a parallel
 * refresh of all devices) don't run into a 429.
 */
export const CLOUD_FULL_LIMITS = { perMinute: 8, perDay: 9000 };

// === OpenAPI MQTT ===

/**
 * Maximum consecutive auth failures on the OpenAPI-MQTT connect before the
 * reconnect is stopped permanently. Govee returns 401 when the API key is
 * invalid — endless retries would only cultivate account-lock risk.
 */
export const OPENAPI_MQTT_MAX_AUTH_FAILURES = 5;
