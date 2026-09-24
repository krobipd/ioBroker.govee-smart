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

/**
 * Successful account logins allowed inside {@link MQTT_LOGIN_WINDOW_MS}. The
 * #39 cap above counts only REJECTED logins; a broker that keeps dropping the
 * connection after a good login (port 8883 blocked, CONNACK "not authorized")
 * turned every reconnect into another successful login — govee2mqtt #702 got
 * its account locked for 24 h exactly that way (~6 logins/h for 8 h). Since
 * 2.40.0 a reconnect reuses the last bundle, so a fresh login only follows an
 * expired token or a rejected certificate; this window is the backstop.
 */
export const MQTT_MAX_LOGINS_PER_WINDOW = 3;

/** Window for {@link MQTT_MAX_LOGINS_PER_WINDOW} (1 h). */
export const MQTT_LOGIN_WINDOW_MS = 60 * 60 * 1000;

/**
 * Token lifetime used when Govee's `token_expire_cycle` is missing or not a
 * finite number (1 h). Measured value 2026-09: ~57 600 s.
 */
export const MQTT_TOKEN_TTL_DEFAULT_S = 3600;

/** Lower bound for a reported token lifetime (10 min — the refresh runs 5 min before expiry). */
export const MQTT_TOKEN_TTL_MIN_S = 10 * 60;

/** Upper bound for a reported token lifetime (7 days). */
export const MQTT_TOKEN_TTL_MAX_S = 7 * 24 * 60 * 60;

/** Delay before a failed or skipped silent bearer refresh is tried again (5 min). */
export const MQTT_REFRESH_RETRY_MS = 5 * 60 * 1000;

/**
 * Largest delay a timer accepts. js-controller's `setTimeout` THROWS above
 * 2^31−1 ms (`Validator.assertTimeout`) instead of clamping — a server-supplied
 * duration that large broke the login flow (the throw landed in connect()'s
 * catch as a TIMEOUT and looped successful logins) and aborted onReady on a 429.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Clamp a computed timer delay into what a timer accepts: a non-finite value
 * becomes `fallback`, the result lies in [0, min(max, MAX_TIMER_MS)].
 *
 * @param ms Computed delay
 * @param fallback Delay to use when `ms` is not a finite number
 * @param max Upper bound (defaults to the timer limit)
 */
export function clampTimerMs(ms: number, fallback: number, max: number = MAX_TIMER_MS): number {
  const value = Number.isFinite(ms) ? ms : fallback;
  return Math.min(Math.max(0, value), Math.min(max, MAX_TIMER_MS));
}

/**
 * A token lifetime from Govee, bounded: missing/non-finite → the 1 h default,
 * otherwise clamped to [10 min, 7 days].
 *
 * @param raw `token_expire_cycle` / `tokenExpireCycle` from the login answer
 */
export function tokenTtlSeconds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return MQTT_TOKEN_TTL_DEFAULT_S;
  }
  return Math.min(Math.max(n, MQTT_TOKEN_TTL_MIN_S), MQTT_TOKEN_TTL_MAX_S);
}

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
 * 30 minutes is only safe while something renews it, and the two renewers this
 * comment used to name — the account push (which arrives within minutes for any
 * device with its own push topic — measured 15 packets in 2 min, 50 in 4 min,
 * 10 in 15 min on four real user reports) and the 2-minute account list — BOTH
 * need email + password. On the API-key-only tier neither exists, so the proof
 * of a light with no local interface expired half an hour after start and the
 * device went grey while it was perfectly controllable.
 * {@link CLOUD_REACHABILITY_REFRESH_MS} closes that: a targeted cloud state read
 * for exactly the devices whose proof is about to expire, needing nothing but
 * the API key.
 */
export const CLOUD_ONLINE_EVIDENCE_TTL_MS = 30 * 60 * 1000;

/**
 * When to renew a cloud reachability proof that nothing else is renewing (20 min).
 *
 * Ten minutes of headroom before {@link CLOUD_ONLINE_EVIDENCE_TTL_MS} expires —
 * five attempts on the 2-minute tick, so a couple of failed or rate-limited
 * calls cannot make a device blink. Deliberately NOT a second full poll: only
 * devices whose evidence is actually this old are read, so a healthy
 * installation, where the push and the account list keep everything fresh,
 * issues no extra call at all.
 */
export const CLOUD_REACHABILITY_REFRESH_MS = 20 * 60 * 1000;

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
 * is far longer than a holiday or a router outage, and comfortably inside the
 * 14-day window after which the device cache drops an entry entirely
 * (`SkuCache.pruneStale(14)`).
 */
export const LAN_CAPABLE_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an EMPTY answer for a SKU's libraries (scene/music/DIY library,
 * SKU features — app2.govee.com) is trusted before Govee is asked again.
 * Until 2.38.3 an empty answer was never remembered: every start repeated the
 * calls for every light of the SKU. Remembered with an expiry, not forever —
 * the #13 lesson ("once empty, empty forever") is about the missing expiry.
 */
export const LIBRARY_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// === Adapter lifecycle ===

/** Hard timeout for cloud initialisation (60 s). */
export const READY_TIMEOUT_MS = 60_000;

/**
 * Floor for a rate-limit retry pause (5 s). A malformed/zero server `Retry-After`
 * must not collapse into an immediate-retry tight loop that hammers the Cloud
 * (Govee's v2 limits allow 30 list calls per minute; the adapter keeps to 20) —
 * clamp the server value up to this minimum.
 */
export const MIN_RATE_LIMIT_RETRY_MS = 5_000;

/**
 * Ceiling for a rate-limit retry pause (1 h). The server's `Retry-After` went
 * into the timer unbounded; above 2^31−1 ms js-controller's timer throws, which
 * aborted onReady on a first-start 429 and killed the retry loop.
 */
export const MAX_RATE_LIMIT_RETRY_MS = 60 * 60 * 1000;

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

// === Wizard ===

/** Idle timeout for the segment-detection wizard (5 min). */
export const WIZARD_IDLE_TIMEOUT_MS = 5 * 60_000;

// === Status request over the account broker ===

/**
 * How often a device is asked for its status over the account broker when
 * its own push is older than this — the request the Govee app sends when it
 * opens. Well under CLOUD_ONLINE_EVIDENCE_TTL_MS (30 min), so a device that
 * answers never goes grey between two requests; a device that does not answer
 * gets no stamp and goes grey with the TTL (measured 2026-09-22: 903 ms answer
 * from a powered light, 25 s of silence from an unplugged one).
 */
export const STATUS_REQUEST_INTERVAL_MS = 10 * 60 * 1000;

// === Held commands ===

/**
 * How long a command Govee rejected with "Device is offline" is held for
 * delivery at the device's next sign of life. Measured (issue #46): the bulb
 * was back 2 min 4 s after the rejection. Bounded on purpose — a command
 * delivered much later is one nobody asked for any more.
 */
export const PENDING_INTENT_TTL_MS = 5 * 60 * 1000;

// === LAN command-router ===

/**
 * Wait time between a `colorwc` mode switch and the following segment commands.
 * Empirically ~150 ms; any shorter and Govee swallows the segment update because
 * the device is still in scene/music mode.
 */
export const FORCE_COLOR_MODE_SETTLE_MS = 150;

// === Cloud rate-limiter ===

/** The Govee cloud budget, one bucket per actor Govee names (see {@link CLOUD_LIMITS}). */
export interface CloudLimits {
  /** `/user/devices` — per account and minute. */
  accountListPerMinute: number;
  /** `/device/state`, `/device/scenes`, `/device/diy-scenes` — per DEVICE and minute. */
  deviceReadPerMinute: number;
  /** `/device/control` — per DEVICE: a token bucket of `burst`, refilled `perSecond`. */
  deviceControl: { perSecond: number; burst: number };
  /** `/device/control` — per ACCOUNT: the same shape, the ceiling over all devices. */
  accountControl: { perSecond: number; burst: number };
  /** app2.govee.com (libraries, SKU features, snapshot packets) — undocumented, per minute, global. */
  appApiPerMinute: number;
  /** All OpenAPI calls together per day. */
  perDay: number;
}

/**
 * Govee's OpenAPI limits, per ACTOR, with a safety margin (v2 reference page
 * `get-you-devices`, table "Friendly Reminder", page dated 2026-07-06):
 *
 *   /user/devices    account  30/min          → 20
 *   /device/state    device   30/min          → 20   (scenes and DIY scenes the same)
 *   /device/control  device    2/s, burst  6  → as documented
 *   /device/control  account  12/s, burst 80  → as documented
 *
 * Until 2.38.3 ONE global window of 8 calls per minute covered every device and
 * every endpoint — the v1 API's "10 per minute" read as an account limit. Eight
 * cloud-only bulbs then shared eight slots: the second half of a group switch
 * waited for the next minute reset (issue #46, measured on the reporter's
 * exports of 2.31.1 and 2.37.1). The app2.govee.com calls are not part of
 * Govee's documented budget at all; they keep their own small window so an
 * undocumented endpoint is never stormed, and they no longer block commands.
 *
 * The daily numbers are v1 inheritance: 10,000 per account and 100 per
 * appliance stand in the v1 PDF only, the v2 page names no daily limit at all
 * — neither withdrawn nor confirmed. They stay (a wager either way is the
 * wrong move) until Govee's rate-limit response headers, recorded since
 * 2.39.0, show what v2 actually enforces. Accepted with them: the global
 * 8/min used to cap a day at ~11,500 calls by itself; now a script writing
 * one light in a loop can reach the 9,000 within minutes, and for lights that
 * counter is the only brake left (appliances keep their 90).
 */
export const CLOUD_LIMITS: CloudLimits = {
  accountListPerMinute: 20,
  deviceReadPerMinute: 20,
  deviceControl: { perSecond: 2, burst: 6 },
  accountControl: { perSecond: 12, burst: 80 },
  appApiPerMinute: 8,
  perDay: 9000,
};

/**
 * Daily Cloud budget for ONE appliance (90 of the v1 PDF's 100 — see the note
 * on daily numbers at {@link CLOUD_LIMITS}). Appliances were the exception in
 * the v1 limits: lights got the 10,000/day account budget, an appliance 100 per
 * day for itself — and appliance control has no local path at all, so every
 * write is a cloud call.
 *
 * The global counters cannot protect this: one appliance may spend the whole
 * 9,000, ninety times its own allowance. The adapter never does this by itself
 * (there is no periodic per-device poll), but a script switching a humidifier
 * every five minutes reaches 288 a day and then collects rejections until
 * Govee's daily reset.
 */
export const CLOUD_APPLIANCE_DAILY_LIMIT = 90;

// === OpenAPI MQTT ===

/**
 * Maximum consecutive auth failures on the OpenAPI-MQTT connect before the
 * reconnect is stopped permanently. Govee returns 401 when the API key is
 * invalid — endless retries would only cultivate account-lock risk.
 */
export const OPENAPI_MQTT_MAX_AUTH_FAILURES = 5;
