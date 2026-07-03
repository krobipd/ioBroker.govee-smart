import { formatFallback, httpsRequest, HttpError, type HttpsRequestFn } from "./http-client";
import {
  classifyError,
  type CapabilityOption,
  type CloudDevice,
  type CloudDeviceListResponse,
  type CloudDeviceStateResponse,
  type CloudScene,
  type CloudScenesResponse,
  type CloudStateCapability,
  type ErrorCategory,
} from "./types";

const BASE_URL = "https://openapi.api.govee.com";

/**
 * Monotonic counter for `requestId` so two calls in the same millisecond
 * don't collide. Govee uses requestId for idempotency on its side; concurrent
 * calls with identical requestIds can be coalesced or rejected as duplicates.
 * Module-level so all clients share the same sequence.
 */
let requestIdCounter = 0;

/**
 * Build a unique `requestId` (`<prefix>_<ms>_<counter>`).
 *
 * @param prefix Short label identifying the call site (e.g. "ctrl", "scenes").
 */
function nextRequestId(prefix: string): string {
  requestIdCounter = (requestIdCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now()}_${requestIdCounter}`;
}

/**
 * Map a scenes-endpoint capability's options to CloudScene entries, dropping
 * malformed options (missing name or non-object value). Shared by getScenes
 * and getDiyScenes.
 *
 * @param opts Raw options array from a scenes-endpoint capability
 */
function mapSceneOptions(opts: CapabilityOption[] | undefined): CloudScene[] {
  return (Array.isArray(opts) ? opts : [])
    .filter(
      // `typeof null === "object"` — the old object-only guard let null-valued
      // options through as phantom entries AND dropped the integer values that
      // snapshots use (CloudScene.value is `Record | number`). Accept object OR
      // number, reject null/undefined (L7).
      (o): o is { name: string; value: Record<string, unknown> | number } =>
        !!o &&
        typeof o.name === "string" &&
        o.value != null &&
        (typeof o.value === "object" || typeof o.value === "number"),
    )
    .map(o => ({ name: o.name, value: o.value }));
}

/**
 * Govee Cloud API v2 client.
 * Used for device list, capabilities, scenes, segments, and as control fallback.
 */
export class GoveeCloudClient {
  private readonly apiKey: string;
  private readonly log: ioBroker.Logger;
  private readonly httpsRequestImpl: HttpsRequestFn;
  /**
   * True if a previous getDevices call returned an empty array — the first
   * empty result emits an info log so the user has a starting point for
   * "where are my devices?", repeats stay silent.
   */
  private warnedEmptyDeviceList = false;
  /**
   * Diagnostics hook — receives (deviceId, endpoint, body) for each
   * response. Optional; the adapter wires it to a DiagnosticsCollector
   * for `diag.export`.
   */
  private onResponse: ((deviceId: string, endpoint: string, body: unknown) => void) | null = null;

  /**
   * Last error category for getFailureReason() — set on every HTTP error in
   * the request path.
   */
  private lastErrorCategory: ErrorCategory | null = null;

  /**
   * @param apiKey Govee API key
   * @param log ioBroker logger
   * @param httpsRequestImpl optional DI for tests — default is the real httpsRequest
   */
  constructor(apiKey: string, log: ioBroker.Logger, httpsRequestImpl: HttpsRequestFn = httpsRequest) {
    this.apiKey = apiKey;
    this.log = log;
    this.httpsRequestImpl = httpsRequestImpl;
  }

  /**
   * Short user-facing reason for "Cloud not connected", or null when the
   * client has not seen an error yet. Like the mqtt-client — `logDeviceSummary`
   * uses it so the adapter can log clear diagnostic text instead of
   * "see earlier errors".
   */
  getFailureReason(): string | null {
    switch (this.lastErrorCategory) {
      case "AUTH":
        return "API key rejected — check Govee API key";
      case "RATE_LIMIT":
        return "rate-limited by Govee — will retry";
      case "NETWORK":
        return "cannot reach Govee servers — will retry";
      case "TIMEOUT":
        return "Cloud request timeout";
      case "UNKNOWN":
        return "Cloud request failed — see earlier log";
      case null:
      default:
        return null;
    }
  }

  /**
   * Register a hook called after every successful Cloud API response.
   * Used to populate the DiagnosticsCollector ring buffer.
   *
   * @param cb Callback receiving (deviceId, endpoint, body)
   */
  setResponseHook(cb: ((deviceId: string, endpoint: string, body: unknown) => void) | null): void {
    this.onResponse = cb;
  }

  /** Fetch all devices with their capabilities */
  async getDevices(): Promise<CloudDevice[]> {
    const resp = await this.request<CloudDeviceListResponse>("GET", "/router/api/v1/user/devices");
    // Defensive — API can drift. Guard for non-array to protect downstream iteration.
    const devices = Array.isArray(resp?.data) ? resp.data : [];
    // v2.9.1 — fire onResponse per-device so every device sees the canonical
    // capability data Govee Cloud has for it in its own apiHistory. Without
    // this, the user-devices endpoint never appeared in diag — even though
    // it's the authoritative source of truth for what Govee thinks each
    // device can do. Per-device is the right grain because callers want to
    // see "what Cloud said about MY device" without scanning a global list.
    if (this.onResponse) {
      for (const cd of devices) {
        if (cd && typeof cd.device === "string" && cd.device) {
          this.onResponse(cd.device, "/router/api/v1/user/devices", cd);
        }
      }
    }
    if (devices.length === 0 && !this.warnedEmptyDeviceList) {
      this.warnedEmptyDeviceList = true;
      // First empty response is worth surfacing — common cause is "API key
      // belongs to a different Govee account than where the devices were
      // added" or "user hasn't enabled control-via-cloud per device". Repeat
      // calls keep quiet so a temporarily flaky API doesn't spam.
      this.log.info(`Cloud: device list returned empty — check the API key matches the account that owns the devices`);
    } else if (devices.length > 0) {
      this.warnedEmptyDeviceList = false;
    }
    return devices;
  }

  /**
   * Fetch current state of a device
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getDeviceState(sku: string, device: string): Promise<CloudStateCapability[]> {
    const resp = await this.request<CloudDeviceStateResponse>("POST", "/router/api/v1/device/state", {
      requestId: nextRequestId("state"),
      payload: { sku, device },
    });
    this.onResponse?.(device, "/router/api/v1/device/state", resp);
    const caps = resp?.data?.capabilities;
    return Array.isArray(caps) ? caps : [];
  }

  /**
   * Send a control command to a device
   *
   * @param sku Product model
   * @param device Device ID
   * @param capabilityType Full capability type string
   * @param instance Capability instance name
   * @param value Value to set
   */
  async controlDevice(
    sku: string,
    device: string,
    capabilityType: string,
    instance: string,
    value: unknown,
  ): Promise<void> {
    const reqBody = {
      requestId: nextRequestId("ctrl"),
      payload: {
        sku,
        device,
        capability: {
          type: capabilityType,
          instance,
          value,
        },
      },
    };
    const resp = await this.request<{ code?: number; message?: string }>(
      "POST",
      "/router/api/v1/device/control",
      reqBody,
    );
    this.onResponse?.(device, "/router/api/v1/device/control", { request: reqBody.payload.capability, response: resp });
    // Govee returns 200 with a payload-level `code`/`message` on logical
    // failures (capability not allowed, device offline as seen by Cloud).
    // Without this surface, the caller sees a "successful" command that the
    // device never received.
    if (resp && typeof resp.code === "number" && resp.code !== 200 && resp.code !== 0) {
      throw new Error(
        `Cloud control rejected for ${sku}/${device}/${instance}: code=${resp.code}${resp.message ? ` — ${resp.message}` : ""}`,
      );
    }
  }

  /**
   * Fetch dynamic scenes and snapshots for a device.
   * The scenes endpoint returns capabilities with options.
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getScenes(
    sku: string,
    device: string,
  ): Promise<{
    lightScenes: CloudScene[];
    diyScenes: CloudScene[];
    snapshots: CloudScene[];
  }> {
    const resp = await this.request<CloudScenesResponse>("POST", "/router/api/v1/device/scenes", {
      requestId: nextRequestId("scenes"),
      payload: { sku, device },
    });
    this.onResponse?.(device, "/router/api/v1/device/scenes", resp);

    const lightScenes: CloudScene[] = [];
    const diyScenes: CloudScene[] = [];
    const snapshots: CloudScene[] = [];

    const caps = Array.isArray(resp?.payload?.capabilities) ? resp.payload.capabilities : [];
    for (const cap of caps) {
      if (!cap || typeof cap.instance !== "string") {
        continue;
      }
      const opts = Array.isArray(cap.parameters?.options) ? cap.parameters.options : [];
      this.log.debug(`Scenes endpoint: instance=${cap.instance}, options=${opts.length}`);
      const mapped = mapSceneOptions(opts);

      if (cap.instance === "lightScene") {
        lightScenes.push(...mapped);
      } else if (cap.instance === "diyScene") {
        diyScenes.push(...mapped);
      } else if (cap.instance === "snapshot") {
        snapshots.push(...mapped);
      }
    }

    return { lightScenes, diyScenes, snapshots };
  }

  /**
   * Fetch DIY scenes for a device from the dedicated diy-scenes endpoint.
   *
   * @param sku Product model
   * @param device Device identifier
   */
  async getDiyScenes(sku: string, device: string): Promise<CloudScene[]> {
    const resp = await this.request<CloudScenesResponse>("POST", "/router/api/v1/device/diy-scenes", {
      requestId: nextRequestId("diy"),
      payload: { sku, device },
    });
    this.onResponse?.(device, "/router/api/v1/device/diy-scenes", resp);

    const scenes: CloudScene[] = [];
    const caps = Array.isArray(resp?.payload?.capabilities) ? resp.payload.capabilities : [];
    for (const cap of caps) {
      if (!cap || typeof cap.instance !== "string") {
        continue;
      }
      const opts = Array.isArray(cap.parameters?.options) ? cap.parameters.options : [];
      this.log.debug(`DIY-Scenes endpoint: instance=${cap.instance}, options=${opts.length}`);
      scenes.push(...mapSceneOptions(opts));
    }

    return scenes;
  }

  /**
   * Make an HTTPS request to the Govee Cloud API
   *
   * @param method HTTP method (GET, POST)
   * @param path API endpoint path
   * @param body Optional request body
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    this.log.debug(`Cloud API: ${method} ${path} auth=apiKey`);
    try {
      const result = await this.httpsRequestImpl<T>({
        method: method as "GET" | "POST",
        url: new URL(path, BASE_URL).toString(),
        headers: { "Govee-API-Key": this.apiKey },
        body,
      });
      if (result.fallback) {
        this.log.debug(`Cloud API: ${method} ${path}: ${formatFallback(result)}`);
      }
      // Reset the failure category on success — getFailureReason() then returns
      // null until the next error.
      this.lastErrorCategory = null;
      return result.value;
    } catch (err) {
      // Classify 429 explicitly by status code — classifyError only looks at
      // err.message, and HttpError("Too many requests", 429, …) has no "429"
      // or "Rate limit" marker in the text. Without this branch 429 lands as
      // UNKNOWN and getFailureReason() returns the wrong ready hint.
      if (err instanceof HttpError && err.statusCode === 429) {
        this.lastErrorCategory = "RATE_LIMIT";
        const retryAfter = String(err.headers["retry-after"] ?? "unknown");
        throw new HttpError(`Rate limited — retry after ${retryAfter}s`, 429, err.headers);
      }
      // Classify 401/403 explicitly by status code too — classifyError only
      // looks at err.message, so a 401/403 whose body doesn't contain
      // "auth"/"unauthorized" (e.g. "Access denied", "Forbidden") would land as
      // UNKNOWN and the ready hint would read "Cloud request failed" instead of
      // the actionable "API key rejected — check Govee API key" (L26).
      if (err instanceof HttpError && (err.statusCode === 401 || err.statusCode === 403)) {
        this.lastErrorCategory = "AUTH";
        throw err;
      }
      this.lastErrorCategory = classifyError(err);
      throw err;
    }
  }
}
