/**
 * Central timing constants for the adapter.
 *
 * Avoid magic numbers — when a constant is used in more than one place, import
 * it from here and give it a unique name.
 *
 * Convention: `_MS` for milliseconds, `_S` for seconds, `_MIN` for minutes.
 */

// === MQTT ===

/**
 * Maximum consecutive login attempts that REACH Govee and are rejected before
 * the account-MQTT reconnect is stopped permanently (until adapter restart).
 * Covers bad credentials, rate-limit, account-locked and any other non-success
 * response; network/timeout failures don't count (issue #39). Kept low so a
 * fault can't hammer Govee's login endpoint into a 24 h account lock.
 */
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

/**
 * How long a heard cloud reachability report stays valid.
 *
 * A proof without an expiry never dies: a device that reported "online" once in
 * December would still read reachable in November while it sits in the cellar.
 * That is the Weihnachtslichter case and it has to end.
 *
 * 30 minutes is safe ONLY because two sources renew it: the account push (which
 * arrives within minutes for any device with its own push topic — measured
 * 15 packets in 2 min, 50 in 4 min, 10 in 15 min on four real user reports) and
 * the 2-minute account list, which since 2.30.0 also runs for installations that
 * have devices without a local interface. Fifteen chances to renew before it
 * expires — generous against a few missed answers, far short of "forever".
 */
export const CLOUD_ONLINE_EVIDENCE_TTL_MS = 30 * 60 * 1000;

/**
 * How long "this device answered on the local interface" stays true.
 *
 * A device that has answered locally is decided by the LAN reply and nothing
 * else — Govee's cloud cache lags real reachability (measured 2026-05-13: it
 * reported `true` twice during a genuine 8-minute outage). That rule must
 * survive a restart, because `lanIp` does not (it is re-discovered by scan), and
 * without it every light would spend the first scan cycle after each start being
 * judged by the stale cloud cache — the 2.29.0 false-green.
 *
 * It expires so the opposite case also works: a user who switches the local API
 * OFF in the Govee app should not see that device stuck grey forever. Seven days
 * is far longer than a holiday or a router outage, and well inside the 30-day
 * window after which the device cache drops an entry entirely.
 */
export const LAN_CAPABLE_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * How long a LAN reply keeps a LAN-capable light "reachable" (90 s). Tolerates
 * three missed 30 s scans against UDP packet loss and still flips offline
 * reasonably fast on a real outage. Only meaningful for lights that actually
 * have a local API — every other device kind has no LAN signal at all.
 */
export const LAN_REPLY_FRESHNESS_MS = 90_000;

/** Safety timeout to log "ready" even if a channel is still settling (60 s). */
export const READY_SAFETY_TIMEOUT_MS = 60_000;

/** Delay after startup before reaping stale devices (30 s — lets the LAN scan settle). */
export const STALE_DEVICE_CLEANUP_DELAY_MS = 30_000;

/** Daily Govee-app-version refresh interval (24 h). */
export const APP_VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Fallback retry delay after a transient Cloud-load failure (5 min). */
export const TRANSIENT_RETRY_MS = 5 * 60_000;

/** Per-device diagnostics-export throttle (2 s) — guards against button spam. */
export const DIAGNOSTICS_EXPORT_THROTTLE_MS = 2_000;

/**
 * How many diagnostics reports are kept per device (3). The throttle guards
 * against button spam, not against accumulation — without a cap the folder
 * grows with every press. Three covers "export, change something, export
 * again, compare" without turning the file list into an archive.
 */
export const DIAGNOSTICS_KEEP_PER_DEVICE = 3;

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

/**
 * Daily Cloud budget for ONE appliance (90 of Govee's 100). Appliances are the
 * exception in Govee's limits: lights get the 10,000/day account budget, an
 * appliance gets 100 per day for itself — and appliance control has no local
 * path at all, so every write is a cloud call.
 *
 * The global counters cannot protect this. Per minute they can: a global 8/min
 * is always below the 10/min a single device may use. Per day they cannot —
 * one appliance may spend the whole 9,000, ninety times its own allowance. The
 * adapter never does this by itself (there is no periodic per-device poll), but
 * a script switching a humidifier every five minutes reaches 288 a day and then
 * collects rejections until Govee's daily reset.
 */
export const CLOUD_APPLIANCE_DAILY_LIMIT = 90;

// === OpenAPI MQTT ===

/**
 * Maximum consecutive auth failures on the OpenAPI-MQTT connect before the
 * reconnect is stopped permanently. Govee returns 401 when the API key is
 * invalid — endless retries would only cultivate account-lock risk.
 */
export const OPENAPI_MQTT_MAX_AUTH_FAILURES = 5;
