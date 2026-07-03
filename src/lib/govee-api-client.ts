import { formatFallback, httpsRequest, type HttpResult } from "./http-client";
import {
  GOVEE_APP_BASE_URL,
  GOVEE_APP_VERSION,
  GOVEE_USER_AGENT,
  buildGoveeAppHeaders,
  deriveGoveeClientId,
} from "./govee-constants";

/**
 * Parsed `lastDeviceData` field from the undocumented device-list response.
 * Govee serializes this as a JSON string inside the outer JSON. Temperature
 * and humidity are integer hundredths (`tem: 2370` → 23.70 °C).
 */
export interface AppDeviceLastData {
  /** Online flag as reported by the cloud */
  online?: boolean;
  /** Last temperature in hundredths of a degree (`tem/100` = °C) */
  tem?: number;
  /** Last humidity in hundredths of a percent (`hum/100` = % RH) */
  hum?: number;
  /** Battery percentage — only some devices report it here */
  battery?: number;
  /** UNIX ms of the last data point */
  lastTime?: number;
}

/**
 * Parsed `deviceSettings` field. Fields are a union across SKUs — most are
 * optional, vendor may add more.
 */
export interface AppDeviceSettings {
  /** Upload interval in minutes */
  uploadRate?: number;
  /** Battery percentage (some firmware reports it here, others in lastData) */
  battery?: number;
  /** Currently associated WiFi SSID */
  wifiName?: string;
  /** Device WiFi MAC address */
  wifiMac?: string;
  /** WiFi firmware version */
  wifiSoftVersion?: string;
  /** WiFi hardware revision */
  wifiHardVersion?: string;
  /** BLE advertising name */
  bleName?: string;
  /** Temperature calibration offset (hundredths of degree) */
  temCali?: number;
  /** Humidity calibration offset (hundredths of percent) */
  humCali?: number;
  /** Lower temperature alarm threshold (hundredths of degree) */
  temMin?: number;
  /** Upper temperature alarm threshold (hundredths of degree) */
  temMax?: number;
  /** Lower humidity alarm threshold (hundredths of percent) */
  humMin?: number;
  /** Upper humidity alarm threshold (hundredths of percent) */
  humMax?: number;
  /** App displays Fahrenheit instead of Celsius (display-only) */
  fahOpen?: boolean;
  /** Vendor-defined extras */
  [key: string]: unknown;
}

/** One entry in the undocumented device-list response. */
export interface AppDeviceEntry {
  /** Govee SKU (e.g. "H5179") */
  sku: string;
  /** Device identifier (colon-separated MAC form) */
  device: string;
  /** Display name set in the Govee Home app */
  deviceName: string;
  /** Parsed `lastDeviceData` payload */
  lastData?: AppDeviceLastData;
  /** Parsed `deviceSettings` payload */
  settings?: AppDeviceSettings;
  /** Internal numeric device id (unused) */
  deviceId?: number;
  /** Hardware firmware version */
  versionHard?: string;
  /** Software firmware version */
  versionSoft?: string;
}

/**
 * Govee undocumented API client.
 *
 * Combines two roles that the v1.x adapter split across two clients:
 *   - Light-side: scene library, music library, DIY library, snapshot
 *     packets, SKU features, group members. Most endpoints are public
 *     (no auth) and only need the AppVersion + User-Agent headers.
 *   - Sensor-side: `POST /device/rest/devices/v1/list` for sensors like
 *     H5179 where OpenAPI v2 `/device/state` returns empty. Needs a
 *     bearer token from the MQTT login.
 *
 * Both roles share the same `app2.govee.com` host, the same auth
 * identity (when needed), and the same `setBearerToken()` lifecycle —
 * so they live in one class.
 */
export class GoveeApiClient {
  private bearerToken: string | null = null;
  /** Account-derived client ID. Defaults to anonymous fallback until setEmail() is called. */
  private clientId: string = deriveGoveeClientId(undefined);

  /**
   * @param log Adapter logger. Each fetch method emits a debug-line for the
   *   request and a debug-line summarising the result — this is what made
   *   Issue #13 v2.8.2 hard to triage from the log alone (the App-API path
   *   was completely silent before v2.8.3).
   */
  constructor(private readonly log: ioBroker.Logger) {}

  /**
   * Update the bearer token (obtained from MQTT login).
   *
   * @param token Bearer token string
   */
  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  /**
   * Update the account email so subsequent requests use the matching
   * UUIDv5-derived client ID. Public endpoints (scene/music/DIY libraries)
   * still work with the anonymous fallback, but the bearer-token endpoints
   * (sensor /device/rest/devices/v1/list) match better when the clientId
   * mirrors the one used during the MQTT login.
   *
   * @param email Govee account email
   */
  setEmail(email: string | undefined): void {
    this.clientId = deriveGoveeClientId(email);
  }

  /** Check if bearer token is available (set after MQTT login) */
  hasBearerToken(): boolean {
    return !!this.bearerToken;
  }

  /**
   * Auth headers for the bearer-token-protected sensor endpoints.
   * Caller-side guard: check hasBearerToken() before calling.
   */
  private authHeaders(): Record<string, string> {
    if (!this.bearerToken) {
      throw new Error("Bearer token required — call hasBearerToken() first");
    }
    return buildGoveeAppHeaders(this.clientId, { bearer: this.bearerToken });
  }

  /**
   * Log a non-JSON fallback (empty / plain-text-status body) for an App-API
   * endpoint on debug — shared by every fetch method so the "why is this null?"
   * trace reads the same everywhere.
   *
   * @param endpoint Endpoint label for the log line (e.g. "/devices/snapshots sku=H61BE")
   * @param result HttpResult envelope from httpsRequest
   */
  private logFallback(endpoint: string, result: HttpResult<unknown>): void {
    if (result.fallback) {
      this.log.debug(`App API ${endpoint}: ${formatFallback(result)}`);
    }
  }

  /**
   * Guard for bearer-token endpoints: returns true when a token is present,
   * otherwise logs a uniform "no bearer token" skip line and returns false.
   * Callers do `if (!this.requireBearer(endpoint)) return [];` (or `null`).
   *
   * @param endpoint Endpoint label for the skip log line
   */
  private requireBearer(endpoint: string): boolean {
    if (this.bearerToken) {
      return true;
    }
    this.log.debug(`App API skip ${endpoint}: no bearer token`);
    return false;
  }

  /**
   * Fetch the per-account device list from the undocumented sensor
   * endpoint. One call returns every device the Govee Home app sees for
   * this account, with `lastDeviceData` + `deviceSettings` embedded as
   * stringified JSON. Cheap and safe to poll on a conservative schedule.
   *
   * Endpoint: `POST /device/rest/devices/v1/list` (empty body).
   * Auth: bearer token only.
   *
   * Used primarily for SKUs where OpenAPI v2 `/device/state` returns
   * empty (H5179 et al.). Returns `[]` when no token is set.
   *
   * @returns Parsed entries; never throws on a single malformed entry.
   */
  async fetchDeviceList(): Promise<AppDeviceEntry[]> {
    if (!this.requireBearer(`/device/rest/devices/v1/list`)) {
      return [];
    }
    this.log.debug(`App API POST /device/rest/devices/v1/list bearer=yes`);
    const result = await httpsRequest<{
      status?: number;
      message?: string;
      devices?: Array<{
        sku?: string;
        device?: string;
        deviceName?: string;
        deviceId?: number;
        versionHard?: string;
        versionSoft?: string;
        deviceExt?: {
          lastDeviceData?: string;
          deviceSettings?: string;
        };
      }>;
    }>({
      method: "POST",
      url: `${GOVEE_APP_BASE_URL}/device/rest/devices/v1/list`,
      headers: this.authHeaders(),
      body: {},
    });
    this.logFallback(`/device/rest/devices/v1/list`, result);
    const resp = result.value;

    const out: AppDeviceEntry[] = [];
    const list = Array.isArray(resp?.devices) ? resp.devices : [];
    for (const d of list) {
      if (!d || typeof d.sku !== "string" || typeof d.device !== "string") {
        continue;
      }
      const entry: AppDeviceEntry = {
        sku: d.sku,
        device: d.device,
        deviceName: typeof d.deviceName === "string" ? d.deviceName : d.sku,
        deviceId: typeof d.deviceId === "number" ? d.deviceId : undefined,
        versionHard: typeof d.versionHard === "string" ? d.versionHard : undefined,
        versionSoft: typeof d.versionSoft === "string" ? d.versionSoft : undefined,
      };
      const ext = d.deviceExt;
      if (ext && typeof ext === "object") {
        entry.lastData = parseLastData(ext.lastDeviceData);
        entry.settings = parseSettings(ext.deviceSettings);
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Iterate every valid scene across all categories of an app-library response.
   * Shared by the scene / music / DIY library walkers — invokes `perScene` for
   * each scene whose `sceneName` is a non-empty string; the per-walker effect
   * extraction stays in the callback. Defensive against missing / non-array
   * categories and scenes.
   *
   * @param categories The `data.categories` array from the library response
   * @param perScene Callback invoked with each scene that has a string sceneName
   */
  private walkCategories<S extends { sceneName?: string }>(
    categories: Array<{ scenes?: S[] }> | undefined,
    perScene: (scene: S & { sceneName: string }) => void,
  ): void {
    const cats = Array.isArray(categories) ? categories : [];
    for (const cat of cats) {
      const scenes = Array.isArray(cat?.scenes) ? cat.scenes : [];
      for (const s of scenes) {
        if (!s || typeof s.sceneName !== "string" || !s.sceneName) {
          continue;
        }
        perScene(s as S & { sceneName: string });
      }
    }
  }

  /**
   * Fetch scene library for a specific SKU from undocumented API.
   * Public endpoint — no authentication required, only AppVersion header.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSceneLibrary(sku: string): Promise<
    {
      name: string;
      sceneCode: number;
      scenceParam?: string;
      speedInfo?: {
        supSpeed: boolean;
        speedIndex: number;
        config: string;
      };
    }[]
  > {
    this.log.debug(`App API GET /light-effect-libraries sku=${sku} bearer=no (public endpoint)`);
    const url = `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await httpsRequest<{
      data?: {
        categories?: Array<{
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceName?: string;
              scenceParam?: string;
              speedInfo?: {
                supSpeed?: boolean;
                speedIndex?: number;
                config?: string;
              };
            }>;
          }>;
        }>;
      };
    }>({
      method: "GET",
      url,
      headers: {
        appVersion: GOVEE_APP_VERSION,
        "User-Agent": GOVEE_USER_AGENT,
      },
    });
    this.logFallback(`/light-effect-libraries sku=${sku}`, result);
    const resp = result.value;

    const scenes: {
      name: string;
      sceneCode: number;
      scenceParam?: string;
      speedInfo?: { supSpeed: boolean; speedIndex: number; config: string };
    }[] = [];
    this.walkCategories(resp?.data?.categories, s => {
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      if (effects.length === 0) {
        // No effects — use scene-level code
        const code = s.sceneCode ?? 0;
        if (code > 0) {
          scenes.push({ name: s.sceneName, sceneCode: code });
        }
        return;
      }
      const multiVariant = effects.length > 1;
      for (const effect of effects) {
        const code = effect.sceneCode ?? s.sceneCode ?? 0;
        if (code <= 0) {
          continue;
        }
        const name = multiVariant && effect.scenceName ? `${s.sceneName}-${effect.scenceName}` : s.sceneName;
        const si = effect.speedInfo;
        scenes.push({
          name,
          sceneCode: code,
          scenceParam: effect.scenceParam || undefined,
          speedInfo: si?.supSpeed
            ? {
                supSpeed: true,
                speedIndex: si.speedIndex ?? 0,
                config: si.config ?? "",
              }
            : undefined,
        });
      }
    });

    return scenes;
  }

  /**
   * Fetch music effect library for a specific SKU (requires auth).
   * Returns music modes with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchMusicLibrary(
    sku: string,
  ): Promise<{ name: string; musicCode: number; scenceParam?: string; mode?: number }[]> {
    if (!this.requireBearer(`/music-effect-libraries sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /music-effect-libraries sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/music-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await httpsRequest<{
      data?: {
        categories?: Array<{
          categoryName?: string;
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceParam?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/music-effect-libraries sku=${sku}`, result);
    const resp = result.value;

    const modes: {
      name: string;
      musicCode: number;
      scenceParam?: string;
      mode?: number;
    }[] = [];
    let modeIdx = 0;
    this.walkCategories(resp?.data?.categories, s => {
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      const effect = effects[0];
      const code = effect?.sceneCode ?? s.sceneCode ?? 0;
      if (code > 0) {
        modes.push({
          name: s.sceneName,
          musicCode: code,
          scenceParam: effect?.scenceParam || undefined,
          mode: modeIdx,
        });
      }
      modeIdx++;
    });
    return modes;
  }

  /**
   * Fetch DIY light effect library for a specific SKU (requires auth).
   * Returns DIY scene definitions with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchDiyLibrary(sku: string): Promise<{ name: string; diyCode: number; scenceParam?: string }[]> {
    if (!this.requireBearer(`/diy-light-effect-libraries sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /diy-light-effect-libraries sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/diy-light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const result = await httpsRequest<{
      data?: {
        categories?: Array<{
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceParam?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/diy-light-effect-libraries sku=${sku}`, result);
    const resp = result.value;

    const diys: { name: string; diyCode: number; scenceParam?: string }[] = [];
    this.walkCategories(resp?.data?.categories, s => {
      const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
      const effect = effects[0];
      const code = effect?.sceneCode ?? s.sceneCode ?? 0;
      if (code > 0) {
        diys.push({
          name: s.sceneName,
          diyCode: code,
          scenceParam: effect?.scenceParam || undefined,
        });
      }
    });
    return diys;
  }

  /**
   * Fetch supported features for a specific SKU (requires auth).
   * Returns feature flags indicating what the device supports.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSkuFeatures(sku: string): Promise<Record<string, unknown> | null> {
    if (!this.requireBearer(`/sku-supported-feature sku=${sku}`)) {
      return null;
    }
    this.log.debug(`App API GET /sku-supported-feature sku=${sku} bearer=yes`);
    const url = `https://app2.govee.com/appsku/v1/sku-supported-feature?sku=${encodeURIComponent(sku)}`;
    const result = await httpsRequest<{
      data?: Record<string, unknown>;
    } | null>({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/sku-supported-feature sku=${sku}`, result);
    const resp = result.value;
    // Defensive: API can return literal `null` body on edge cases (Govee
    // response wrapped as JSON-null on some unknown SKUs). Without this
    // guard `resp.data` would throw on null-resp.
    if (!resp || typeof resp !== "object") {
      return null;
    }
    return resp.data ?? null;
  }

  /**
   * Fetch snapshot BLE commands for local activation via ptReal.
   * Each snapshot contains one or more cmds with Base64 BLE packets.
   *
   * @param sku Product model
   * @param deviceId Device identifier (colon-separated)
   */
  async fetchSnapshots(sku: string, deviceId: string): Promise<{ name: string; bleCmds: string[][] }[]> {
    if (!this.requireBearer(`/devices/snapshots sku=${sku}`)) {
      return [];
    }
    this.log.debug(`App API GET /devices/snapshots sku=${sku} device=${deviceId} bearer=yes`);
    const url = `https://app2.govee.com/bff-app/v1/devices/snapshots?sku=${encodeURIComponent(sku)}&device=${encodeURIComponent(deviceId)}&snapshotId=-1`;
    const result = await httpsRequest<{
      data?: {
        snapshots?: Array<{
          name?: string;
          cmds?: Array<{
            bleCmds?: string;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/devices/snapshots sku=${sku}`, result);
    const resp = result.value;

    const results: { name: string; bleCmds: string[][] }[] = [];
    const snaps = Array.isArray(resp?.data?.snapshots) ? resp.data.snapshots : [];
    for (const snap of snaps) {
      if (!snap || typeof snap.name !== "string" || !snap.name) {
        continue;
      }
      const allCmdPackets: string[][] = [];
      const cmds = Array.isArray(snap.cmds) ? snap.cmds : [];
      for (const cmd of cmds) {
        if (!cmd || typeof cmd.bleCmds !== "string" || !cmd.bleCmds) {
          continue;
        }
        try {
          const parsed = JSON.parse(cmd.bleCmds) as { bleCmd?: string };
          if (typeof parsed?.bleCmd === "string" && parsed.bleCmd.length > 0) {
            allCmdPackets.push(parsed.bleCmd.split(","));
          }
        } catch {
          // skip malformed bleCmds JSON
        }
      }
      if (allCmdPackets.length > 0) {
        results.push({ name: snap.name, bleCmds: allCmdPackets });
      }
    }
    return results;
  }

  /**
   * Fetch group membership from undocumented exec-plat/home endpoint.
   * Returns groups with their member device references.
   */
  async fetchGroupMembers(): Promise<
    {
      groupId: number;
      name: string;
      devices: { sku: string; deviceId: string }[];
    }[]
  > {
    if (!this.requireBearer(`/exec-plat/home`)) {
      return [];
    }
    this.log.debug(`App API GET /exec-plat/home bearer=yes`);
    const url = "https://app2.govee.com/bff-app/v1/exec-plat/home";
    const result = await httpsRequest<{
      data?: {
        components?: Array<{
          groups?: Array<{
            gId?: number;
            name?: string;
            devices?: Array<{
              sku?: string;
              device?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });
    this.logFallback(`/exec-plat/home`, result);
    const resp = result.value;

    const groups: {
      groupId: number;
      name: string;
      devices: { sku: string; deviceId: string }[];
    }[] = [];
    const components = Array.isArray(resp?.data?.components) ? resp.data.components : [];
    for (const comp of components) {
      const compGroups = Array.isArray(comp?.groups) ? comp.groups : [];
      for (const g of compGroups) {
        if (!g || typeof g.gId !== "number") {
          continue;
        }
        const devices: { sku: string; deviceId: string }[] = [];
        const gDevices = Array.isArray(g.devices) ? g.devices : [];
        for (const d of gDevices) {
          if (d && typeof d.sku === "string" && typeof d.device === "string" && d.sku && d.device) {
            devices.push({ sku: d.sku, deviceId: d.device });
          }
        }
        if (devices.length > 0) {
          groups.push({
            groupId: g.gId,
            name: typeof g.name === "string" ? g.name : "",
            devices,
          });
        }
      }
    }
    return groups;
  }
}

/**
 * Decode the per-device `lastDeviceData` field. Govee serializes it as a
 * JSON string nested inside the outer JSON. Malformed or missing input
 * yields `undefined` rather than throwing — caller treats it as no data.
 *
 * @param raw Stringified JSON payload from `deviceExt.lastDeviceData`
 */
export function parseLastData(raw: string | undefined): AppDeviceLastData | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: AppDeviceLastData = {};
    if (typeof obj.online === "boolean") {
      out.online = obj.online;
    } else if (obj.online === 1 || obj.online === 0) {
      out.online = obj.online === 1;
    }
    if (typeof obj.tem === "number" && Number.isFinite(obj.tem)) {
      out.tem = obj.tem;
    }
    if (typeof obj.hum === "number" && Number.isFinite(obj.hum)) {
      out.hum = obj.hum;
    }
    if (typeof obj.battery === "number" && Number.isFinite(obj.battery)) {
      out.battery = obj.battery;
    }
    if (typeof obj.lastTime === "number" && Number.isFinite(obj.lastTime)) {
      out.lastTime = obj.lastTime;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Decode the per-device `deviceSettings` field. Returns a plain object —
 * downstream consumers must treat every property as optional. Malformed
 * or missing input yields `undefined`.
 *
 * @param raw Stringified JSON payload from `deviceExt.deviceSettings`
 */
export function parseSettings(raw: string | undefined): AppDeviceSettings | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    const obj = JSON.parse(raw) as AppDeviceSettings;
    return obj && typeof obj === "object" ? obj : undefined;
  } catch {
    return undefined;
  }
}
