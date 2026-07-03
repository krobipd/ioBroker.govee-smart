import {
  capMatchesControl,
  hexToRgb,
  logDedup,
  type ErrorCategory,
  type GoveeDevice,
  type TimerAdapter,
} from "./types";
import type { GoveeCloudClient } from "./govee-cloud-client";
import type { GoveeLanClient } from "./govee-lan-client";
import { applySceneSpeed } from "./govee-lan-client";
import type { RateLimiter } from "./rate-limiter";
import { getDeviceQuirks, type ConfigurableOverrideCommand, type TransportTarget } from "./device-registry";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import { SEGMENT_HARD_MAX } from "./device-manager/lookups";
import { FORCE_COLOR_MODE_SETTLE_MS } from "./timing-constants";

/**
 * Outcome of `resolveTransport` — decides which channel handles a command
 * before any I/O happens. Carries the reason so diag-logs and tests can
 * tell an override-routed cloud send apart from a default cloud fallback.
 */
export type TransportDecision =
  | { kind: "lan"; reason: "default" }
  | {
      kind: "cloud";
      reason: "override" | "no-lan" | "no-segments-heuristic" | "light-no-lan-fallback";
    }
  | { kind: "skip"; reason: "no-channel" | "override-cloud-missing" };

/**
 * Command router — routes device commands through the fastest available
 * channel: LAN → Cloud. Quirk-driven overrides (devices.json
 * `transportOverrides`) take precedence over the LAN-first default.
 */
export class CommandRouter {
  private readonly log: ioBroker.Logger;
  private readonly timers: TimerAdapter;
  private lanClient: GoveeLanClient | null = null;
  private cloudClient: GoveeCloudClient | null = null;
  private rateLimiter: RateLimiter | null = null;
  /**
   * Per-category dedup tracker. Replaces the older split between
   * `lastCloudFallbackError` and `lastNoChannelCategory` — one map, one
   * lookup, keyed by a short category string (`cloud-fallback`,
   * `no-channel`, `override-missing-cloud`).
   */
  private lastErrorByCategory = new Map<string, ErrorCategory | null>();

  /** Callback for batch segment state sync */
  onSegmentBatchUpdate?: (
    device: GoveeDevice,
    batch: { segments: number[]; color?: number; brightness?: number },
  ) => void;

  /**
   * Optional diag-log hook fired once per `sendCommand` call so the per-device
   * diag ring buffer carries the channel-routing decision ("LAN took it",
   * "Cloud fallback", "no channel available"). Without this, the diag JSON
   * couldn't show why a user's state-write didn't reach the device.
   */
  onDiagLog?: (deviceId: string, level: "debug" | "info" | "warn", msg: string) => void;

  /**
   * @param log ioBroker logger
   * @param timers Adapter timer wrapper — routed through `this.setTimeout` so
   *   pending color-mode delays get cleared on onUnload.
   */
  constructor(log: ioBroker.Logger, timers: TimerAdapter) {
    this.log = log;
    this.timers = timers;
  }

  /**
   * Register the LAN client
   *
   * @param client LAN UDP client instance
   */
  setLanClient(client: GoveeLanClient): void {
    this.lanClient = client;
  }

  /**
   * Register the Cloud client
   *
   * @param client Cloud API client instance
   */
  setCloudClient(client: GoveeCloudClient): void {
    this.cloudClient = client;
  }

  /**
   * Register the rate limiter for cloud calls
   *
   * @param limiter Rate limiter instance
   */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  /**
   * Execute a function through the rate limiter if available, or directly.
   *
   * @param fn Async function to execute
   * @param priority Queue priority (0 = highest)
   */
  async executeRateLimited(fn: () => Promise<void>, priority = 0): Promise<void> {
    if (this.rateLimiter) {
      await this.rateLimiter.tryExecute(fn, priority);
    } else {
      await fn();
    }
  }

  /**
   * Force the device into static-color mode before sending segment_color_setting
   * ptReal packets. Without this, the device silently ignores segment-level
   * overrides while it's in Scene/Gradient/Music mode — the classic "I set
   * segment 5 red and nothing happened" symptom. Sends a `colorwc` command with
   * the device's last-known colorRgb (so the strip doesn't visibly change if it
   * was already in color mode), then waits 150 ms so the firmware can switch.
   *
   * As a bonus: once the device is in color mode, subsequent segment commands
   * trigger AA A5 MQTT pushes — so the adapter learns the real segmentCount
   * automatically the first time the user touches segment controls.
   *
   * @param device Target device
   */
  private async forceColorMode(device: GoveeDevice): Promise<void> {
    if (!device.lanIp || !this.lanClient) {
      return;
    }
    const current = typeof device.state.colorRgb === "string" ? device.state.colorRgb : null;
    const { r, g, b } = current ? hexToRgb(current) : { r: 255, g: 255, b: 255 };
    this.lanClient.setColor(device.lanIp, r, g, b);
    await this.timers.delay(FORCE_COLOR_MODE_SETTLE_MS);
  }

  /**
   * Look up the quirk-driven transport override for a (device, command) pair.
   * Segment-suffix commands (segmentColor:N / segmentBrightness:N) inherit
   * the segmentBatch override — devices.json carries one key for all segment
   * ops, not one per index.
   *
   * @param device Target device
   * @param command Command type
   */
  private lookupOverride(device: GoveeDevice, command: string): TransportTarget | undefined {
    const overrides = getDeviceQuirks(device.sku)?.transportOverrides;
    if (!overrides) {
      return undefined;
    }
    if (command in overrides) {
      return overrides[command as ConfigurableOverrideCommand];
    }
    if (command.startsWith("segmentColor:") || command.startsWith("segmentBrightness:")) {
      return overrides.segmentBatch;
    }
    return undefined;
  }

  /**
   * Catch for unkatalogisierte no-segment SKUs: when a lightScene activation
   * with scenceParam data hits a device that doesn't have any segments, the
   * A3-framed multi-packet ptReal protocol gets silently dropped by the
   * firmware. Cloud activation is the safer default. SKUs known to need
   * this go into devices.json `transportOverrides.lightScene = "cloud"` —
   * the heuristic only fires for SKUs not (yet) in the catalog.
   *
   * @param device Target device
   * @param command Command type
   */
  private shouldHeuristicallyUseCloud(device: GoveeDevice, command: string): boolean {
    if (command !== "lightScene") {
      return false;
    }
    const hasSegments = typeof device.segmentCount === "number" && device.segmentCount > 0;
    return !hasSegments;
  }

  /**
   * Single point of truth for channel routing. Quirk-driven `transportOverrides`
   * take precedence over the LAN-first default. Returns a `TransportDecision`
   * carrying both the chosen kind and a reason — caller emits the reason
   * into the diag log so a cloud-override and a cloud-fallback aren't
   * confused in user-submitted JSON.
   *
   * @param device Target device
   * @param command Command type
   */
  resolveTransport(device: GoveeDevice, command: string): TransportDecision {
    const overrideTarget = this.lookupOverride(device, command);
    if (overrideTarget === "cloud") {
      if (device.channels.cloud && this.cloudClient) {
        return { kind: "cloud", reason: "override" };
      }
      return { kind: "skip", reason: "override-cloud-missing" };
    }
    // overrideTarget === "lan" is a no-op fall-through to default routing.

    if (device.lanIp && this.lanClient) {
      if (this.shouldHeuristicallyUseCloud(device, command)) {
        return device.channels.cloud && this.cloudClient
          ? { kind: "cloud", reason: "no-segments-heuristic" }
          : { kind: "skip", reason: "no-channel" };
      }
      return { kind: "lan", reason: "default" };
    }
    if (device.channels.cloud && this.cloudClient) {
      if (device.type === GOVEE_DEVICE_TYPE.LIGHT && !device.lanIp) {
        return { kind: "cloud", reason: "light-no-lan-fallback" };
      }
      return { kind: "cloud", reason: "no-lan" };
    }
    return { kind: "skip", reason: "no-channel" };
  }

  /**
   * Format a decision into a human-readable channel marker for the diag
   * log. One line per `sendCommand` so user-submitted JSON shows what the
   * router decided, not what it was nominally configured for.
   *
   * @param decision Output of resolveTransport
   */
  private decisionToChannelMarker(decision: TransportDecision): string {
    switch (decision.kind) {
      case "lan":
        return "LAN";
      case "cloud":
        if (decision.reason === "light-no-lan-fallback") {
          return "Cloud (no LAN, fallback)";
        }
        return decision.reason === "override"
          ? "Cloud (override)"
          : decision.reason === "no-segments-heuristic"
            ? "Cloud (no-segments)"
            : "Cloud";
      case "skip":
        return decision.reason === "override-cloud-missing" ? "skip (cloud-override, no cloud)" : "skip (no-channel)";
    }
  }

  /**
   * Skip-handler — emits the right log level depending on why we couldn't
   * route. Override+no-cloud is a configurable mismatch (user's fault, but
   * we tell them once); regular no-channel during init-race is debug.
   *
   * @param device Target device
   * @param command Command type
   * @param reason Skip reason from resolveTransport
   */
  private handleSkip(device: GoveeDevice, command: string, reason: "no-channel" | "override-cloud-missing"): void {
    if (reason === "override-cloud-missing") {
      const prev = this.lastErrorByCategory.get("override-missing-cloud") ?? null;
      this.lastErrorByCategory.set(
        "override-missing-cloud",
        logDedup(
          this.log,
          prev,
          `Cloud transport override for ${device.name}/${command} but no Cloud channel available`,
          new Error("override-cloud-missing"),
        ),
      );
      return;
    }
    // no-channel: init-race or genuinely orphan device
    if (device.channels.cloud && !this.cloudClient) {
      this.log.debug(`Command for ${device.name} dropped: Cloud client not ready yet`);
      return;
    }
    this.log.warn(`No channel available for ${device.name} (${device.sku})`);
  }

  /**
   * Send a command to a device. Routing is decided up-front by
   * `resolveTransport`; segment-special-cases (segmentColor:N / segmentBatch /
   * segmentBrightness:N) have their own Cloud-side handlers because cloud
   * routing for batch segment ops goes through `sendSegmentBatchParsed`,
   * not `sendCloudCommand`.
   *
   * MQTT is status-push only and never used for commands.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  async sendCommand(device: GoveeDevice, command: string, value: unknown): Promise<void> {
    const decision = this.resolveTransport(device, command);

    // Diag-log: one line, marker derived from the actual decision (not the
    // configured channel). JSON.stringify keeps `[object Object]` out of
    // the trace for object-valued commands like segmentBatch.
    const summary = `${command}=${JSON.stringify(value)}`;
    this.onDiagLog?.(device.deviceId, "debug", `sendCommand ${summary} → ${this.decisionToChannelMarker(decision)}`);

    if (decision.kind === "skip") {
      this.handleSkip(device, command, decision.reason);
      return;
    }

    // Segment-special cases — they bypass sendCloudCommand for Cloud sends
    // because the batch ops resolve their own capability set via
    // sendSegmentBatchParsed.
    if (command.startsWith("segmentColor:")) {
      await this.dispatchSegmentColor(device, command, value, decision);
      return;
    }
    if (command === "segmentBatch") {
      await this.dispatchSegmentBatch(device, value, decision);
      return;
    }
    if (command.startsWith("segmentBrightness:")) {
      await this.dispatchSegmentBrightness(device, command, value, decision);
      return;
    }

    // Generic dispatch
    if (decision.kind === "lan") {
      this.sendLanCommand(device, command, value);
      return;
    }
    // decision.kind === "cloud"
    await this.sendCloudCommand(device, command, value);
  }

  /**
   * Segment-color dispatcher honouring the resolved transport decision.
   *
   * @param device Target device
   * @param command Command type (segmentColor:N form)
   * @param value Color value (hex string)
   * @param decision Routing decision from resolveTransport
   */
  private async dispatchSegmentColor(
    device: GoveeDevice,
    command: string,
    value: unknown,
    decision: TransportDecision,
  ): Promise<void> {
    // No skip-guard here: sendCommand() returns on a skip decision before it
    // ever dispatches to a segment handler, so `decision` is lan|cloud here.
    const segIdx = parseInt(command.split(":")[1], 10);
    if (isNaN(segIdx) || segIdx < 0) {
      return;
    }
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      const { r, g, b } = hexToRgb(value as string);
      this.lanClient.setSegmentColor(device.lanIp, r, g, b, [segIdx]);
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendCloudCommand(device, command, value);
    }
  }

  /**
   * Segment-batch dispatcher. LAN path issues one multi-segment ptReal
   * burst; Cloud path goes through `sendSegmentBatchParsed` which resolves
   * segment_color_setting + segment-brightness capabilities separately.
   *
   * @param device Target device
   * @param value Either a batch-syntax string or a pre-parsed object
   * @param decision Routing decision from resolveTransport
   */
  private async dispatchSegmentBatch(device: GoveeDevice, value: unknown, decision: TransportDecision): Promise<void> {
    // sendCommand() already returned on a skip decision — `decision` is lan|cloud.
    const parsed = typeof value === "string" ? this.parseSegmentBatch(device, value) : this.coerceParsedBatch(value);
    if (!parsed) {
      // A malformed string (wrong separator, bad range, …) used to be swallowed
      // silently while the state still acked "ok" — the user got no feedback
      // (A4, live: h61d5 "1-15;#ffca91"). Warn with the offending value + syntax.
      if (typeof value === "string") {
        this.log.warn(
          `${device.name} (${device.sku}): could not parse segment command "${value}" — ` +
            `expected e.g. "1-5:#ff0000:80", "all:#00ff00" or "0,3,7::50"`,
        );
      }
      return;
    }
    this.onSegmentBatchUpdate?.(device, parsed);
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      if (parsed.color !== undefined) {
        const r = (parsed.color >> 16) & 0xff;
        const g = (parsed.color >> 8) & 0xff;
        const b = parsed.color & 0xff;
        this.lanClient.setSegmentColor(device.lanIp, r, g, b, parsed.segments);
      }
      if (parsed.brightness !== undefined) {
        this.lanClient.setSegmentBrightness(device.lanIp, parsed.brightness, parsed.segments);
      }
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendSegmentBatchParsed(device, typeof value === "string" ? value : "", parsed);
    }
  }

  /**
   * Segment-brightness dispatcher honouring the resolved transport decision.
   *
   * @param device Target device
   * @param command Command type (segmentBrightness:N form)
   * @param value Brightness value (0-100)
   * @param decision Routing decision from resolveTransport
   */
  private async dispatchSegmentBrightness(
    device: GoveeDevice,
    command: string,
    value: unknown,
    decision: TransportDecision,
  ): Promise<void> {
    // sendCommand() already returned on a skip decision — `decision` is lan|cloud.
    const segIdx = parseInt(command.split(":")[1], 10);
    if (isNaN(segIdx) || segIdx < 0) {
      return;
    }
    if (decision.kind === "lan" && device.lanIp && this.lanClient) {
      await this.forceColorMode(device);
      this.lanClient.setSegmentBrightness(device.lanIp, value as number, [segIdx]);
      return;
    }
    if (decision.kind === "cloud") {
      await this.sendCloudCommand(device, command, value);
    }
  }

  /**
   * Send a generic capability command via Cloud API.
   * Used for capability types not explicitly handled (toggle, dynamic_scene, etc.)
   *
   * @param device Target device
   * @param capabilityType Full capability type (e.g. "devices.capabilities.toggle")
   * @param capabilityInstance Capability instance name (e.g. "gradientToggle")
   * @param value Command value
   */
  async sendCapabilityCommand(
    device: GoveeDevice,
    capabilityType: string,
    capabilityInstance: string,
    value: unknown,
  ): Promise<void> {
    if (!this.cloudClient || !device.channels.cloud) {
      this.log.debug(`Cloud not available for generic command on ${device.name}`);
      return;
    }

    const shortType = capabilityType.replace("devices.capabilities.", "");
    let cloudValue: unknown = value;

    if (shortType === "toggle") {
      cloudValue = value ? 1 : 0;
    }

    const execute = async (): Promise<void> => {
      await this.cloudClient!.controlDevice(
        device.sku,
        device.deviceId,
        capabilityType,
        capabilityInstance,
        cloudValue,
      );
    };

    await this.executeRateLimited(execute);
  }

  /**
   * Send a batch segment command with pre-parsed data.
   *
   * @param device Target device
   * @param commandStr Original command string (for error messages)
   * @param parsed Pre-parsed batch data (null = invalid command)
   */
  private async sendSegmentBatchParsed(
    device: GoveeDevice,
    commandStr: string,
    parsed: { segments: number[]; color?: number; brightness?: number } | null,
  ): Promise<void> {
    if (!this.cloudClient) {
      return;
    }

    if (!parsed) {
      this.log.warn(`Invalid segment command "${commandStr}" for ${device.name}`);
      return;
    }

    const cap = this.findCapabilityForCommand(device, "segmentColor:0");
    if (!cap) {
      this.log.debug(`No segment capability for ${device.name}`);
      return;
    }

    if (parsed.color !== undefined) {
      const execute = async (): Promise<void> => {
        await this.cloudClient!.controlDevice(device.sku, device.deviceId, cap.type, cap.instance, {
          segment: parsed.segments,
          rgb: parsed.color,
        });
      };
      await this.executeRateLimited(execute);
    }

    if (parsed.brightness !== undefined) {
      // Prefer the dedicated segment-brightness cap via the same resolver the
      // colour path uses; fall back to the colour cap when none is declared.
      const brightCap = this.findCapabilityForCommand(device, "segmentBrightness:0");
      const execute = async (): Promise<void> => {
        await this.cloudClient!.controlDevice(
          device.sku,
          device.deviceId,
          (brightCap ?? cap).type,
          (brightCap ?? cap).instance,
          { segment: parsed.segments, brightness: parsed.brightness },
        );
      };
      await this.executeRateLimited(execute);
    }
    // NOTE: no onSegmentBatchUpdate here — dispatchSegmentBatch (the only caller)
    // already emits it once for both the LAN and Cloud paths, before dispatch.
    // Emitting again here double-fired it on the Cloud path (idempotent, but
    // redundant) (I2).
  }

  /**
   * Parse batch segment command string.
   *
   * @param device Target device (for segment count)
   * @param cmd Command string (e.g. "1-5:#ff0000:20")
   */
  parseSegmentBatch(
    device: GoveeDevice,
    cmd: string,
  ): {
    segments: number[];
    color?: number;
    brightness?: number;
  } | null {
    // Defensive guard — non-string input (e.g. from internal caller passing
    // an already-parsed object) would crash cmd.split(). Treat as no-op.
    if (typeof cmd !== "string") {
      return null;
    }
    const parts = cmd.split(":");
    if (parts.length < 1 || !parts[0]) {
      return null;
    }

    // Effective physical segments: honor manual override for cut strips
    const validIndices =
      device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0
        ? new Set(device.manualSegments)
        : null;
    const segCount = device.segmentCount ?? 0;
    const isValid = (i: number): boolean => (validIndices ? validIndices.has(i) : i >= 0 && i < segCount);

    // Parse segment indices
    const segStr = parts[0].trim();
    let segments: number[];

    if (segStr === "all") {
      // "all" expands to valid physical segments only (skip cut ones)
      segments = validIndices
        ? Array.from(validIndices).sort((a, b) => a - b)
        : Array.from({ length: segCount }, (_, i) => i);
    } else {
      segments = [];
      for (const part of segStr.split(",")) {
        const rangeMatch = /^(\d+)-(\d+)$/.exec(part.trim());
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          // Clamp the upper bound to the protocol limit BEFORE the loop. Any
          // index past SEGMENT_HARD_MAX is never valid, so without the clamp a
          // pathological range like "0-2000000000" would spin the loop billions
          // of times (isValid only filters what gets pushed, not the iteration)
          // and block the event loop (L1 / SEC-L1). Admin-only, but a real hang.
          const end = Math.min(parseInt(rangeMatch[2], 10), SEGMENT_HARD_MAX);
          for (let i = start; i <= end; i++) {
            if (isValid(i)) {
              segments.push(i);
            }
          }
        } else {
          const idx = parseInt(part.trim(), 10);
          if (!isNaN(idx) && isValid(idx)) {
            segments.push(idx);
          }
        }
      }
    }

    if (segments.length === 0) {
      return null;
    }

    // Parse color (#RRGGBB → packed int)
    let color: number | undefined;
    if (parts.length >= 2 && parts[1]) {
      const colorStr = parts[1].trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(colorStr)) {
        color = parseInt(colorStr.replace("#", ""), 16);
      }
    }

    // Parse brightness (0-100)
    let brightness: number | undefined;
    if (parts.length >= 3 && parts[2]) {
      const bri = parseInt(parts[2].trim(), 10);
      if (!isNaN(bri) && bri >= 0 && bri <= 100) {
        brightness = bri;
      }
    }

    if (color === undefined && brightness === undefined) {
      return null;
    }

    return { segments, color, brightness };
  }

  /**
   * Coerce a pre-parsed batch object (from internal callers) to the canonical
   * shape. Returns null if the input is not a valid {segments, ...} object.
   *
   * @param value Candidate object
   */
  private coerceParsedBatch(value: unknown): {
    segments: number[];
    color?: number;
    brightness?: number;
  } | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.segments) || v.segments.length === 0) {
      return null;
    }
    const segments = v.segments.filter(n => typeof n === "number" && Number.isFinite(n) && n >= 0) as number[];
    if (segments.length === 0) {
      return null;
    }
    const color = typeof v.color === "number" && Number.isFinite(v.color) ? v.color & 0xffffff : undefined;
    const brightness =
      typeof v.brightness === "number" && Number.isFinite(v.brightness)
        ? Math.max(0, Math.min(100, Math.round(v.brightness)))
        : undefined;
    if (color === undefined && brightness === undefined) {
      return null;
    }
    return { segments, color, brightness };
  }

  /**
   * Convert adapter value to Cloud API value
   *
   * @param device Target device (for scene/snapshot lookup)
   * @param command Command type
   * @param value Adapter-side value to convert
   */
  toCloudValue(device: GoveeDevice, command: string, value: unknown): unknown {
    switch (command) {
      case "power":
        return value ? 1 : 0;
      case "brightness":
        return value;
      case "colorRgb": {
        const { r, g, b } = hexToRgb(value as string);
        return (r << 16) | (g << 8) | b;
      }
      case "colorTemperature":
        return value;
      case "scene":
        return value;
      case "gradientToggle":
        // Govee toggle-cap expects 0/1, not boolean.
        return value ? 1 : 0;
      case "lightScene": {
        // Value is the dropdown index (string) — resolve to scene activation payload
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return value;
        }
        return device.scenes[idx - 1].value;
      }
      case "diyScene": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.diyScenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return value;
        }
        return device.diyScenes[idx - 1].value;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(`${device.sku}: invalid snapshot index ${String(value)}`);
          return value;
        }
        return device.snapshots[idx - 1].value;
      }
      default:
        if (command.startsWith("segmentColor:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          const { r, g, b } = hexToRgb(value as string);
          return { segment: [segIdx], rgb: (r << 16) | (g << 8) | b };
        }
        if (command.startsWith("segmentBrightness:")) {
          const segIdx = parseInt(command.split(":")[1], 10);
          if (isNaN(segIdx) || segIdx < 0) {
            this.log.warn(`${device.sku}: invalid segment index in ${command}`);
            return value;
          }
          return { segment: [segIdx], brightness: value };
        }
        return value;
    }
  }

  /**
   * Find capability matching a command name
   *
   * @param device Target device
   * @param command Command type to find capability for
   */
  findCapabilityForCommand(device: GoveeDevice, command: string): { type: string; instance: string } | undefined {
    const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
    for (const cap of caps) {
      if (!cap || typeof cap.type !== "string" || typeof cap.instance !== "string") {
        continue;
      }
      const shortType = cap.type.replace("devices.capabilities.", "");
      if (
        (command === "power" || command === "brightness" || command === "colorRgb" || command === "colorTemperature") &&
        capMatchesControl(cap, command)
      ) {
        return cap;
      }
      if (command === "scene" && shortType === "mode" && cap.instance === "presetScene") {
        return cap;
      }
      if (command === "lightScene" && shortType === "dynamic_scene" && cap.instance === "lightScene") {
        return cap;
      }
      if (command === "diyScene" && shortType === "dynamic_scene" && cap.instance === "diyScene") {
        return cap;
      }
      if (command === "snapshot" && shortType === "dynamic_scene" && cap.instance === "snapshot") {
        return cap;
      }
      if (command === "gradientToggle" && shortType === "toggle" && cap.instance === "gradientToggle") {
        return cap;
      }
      if (
        command.startsWith("segmentColor:") &&
        shortType === "segment_color_setting" &&
        !cap.instance.toLowerCase().includes("brightness")
      ) {
        return cap;
      }
      if (
        command.startsWith("segmentBrightness:") &&
        shortType === "segment_color_setting" &&
        cap.instance.toLowerCase().includes("brightness")
      ) {
        return cap;
      }
    }
    return undefined;
  }

  /**
   * Send command via LAN UDP
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private sendLanCommand(device: GoveeDevice, command: string, value: unknown): void {
    if (!device.lanIp || !this.lanClient) {
      return;
    }

    switch (command) {
      case "power":
        this.lanClient.setPower(device.lanIp, value as boolean);
        break;
      case "brightness":
        this.lanClient.setBrightness(device.lanIp, value as number);
        break;
      case "colorRgb": {
        const { r, g, b } = hexToRgb(value as string);
        this.lanClient.setColor(device.lanIp, r, g, b);
        break;
      }
      case "colorTemperature":
        this.lanClient.setColorTemperature(device.lanIp, value as number);
        break;
      case "gradientToggle":
        this.lanClient.setGradient(device.lanIp, value as boolean);
        break;
      case "diyScene": {
        // Try ptReal BLE-over-LAN if DIY scene is in library
        const diyIdx = parseInt(String(value), 10);
        if (isNaN(diyIdx) || diyIdx < 1 || diyIdx > device.diyScenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return;
        }
        const diyScene = device.diyScenes[diyIdx - 1];
        if (diyScene) {
          const diyLib = device.diyLibrary.find(d => d.name === diyScene.name);
          if (diyLib) {
            this.log.debug(`ptReal DIY: ${diyScene.name} → code=${diyLib.diyCode}`);
            this.lanClient.setDiyScene(device.lanIp, diyLib.scenceParam ?? "");
            return;
          }
        }
        // No library match — fall through to Cloud
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      case "lightScene": {
        // Try ptReal BLE-over-LAN if scene is in scene library.
        // The no-segments → Cloud heuristic now lives centrally in
        // resolveTransport.shouldHeuristicallyUseCloud — if we get here,
        // the device either has segments or is unknown to the catalog with
        // a registered scene library. Either way the local ptReal path is
        // worth trying.
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.scenes.length) {
          this.log.warn(`${device.sku}: invalid scene index ${String(value)}`);
          return;
        }
        const scene = device.scenes[idx - 1];
        if (scene) {
          // Match by exact name first, then by base name (strip -A/-B suffix)
          const baseName = scene.name.replace(/-[A-Z]$/, "");
          const libEntry =
            device.sceneLibrary.find(s => s.name === scene.name) ?? device.sceneLibrary.find(s => s.name === baseName);
          if (libEntry) {
            const baseParam = libEntry.scenceParam ?? "";
            let param = baseParam;
            if (
              device.sceneSpeed !== undefined &&
              device.sceneSpeed > 0 &&
              libEntry.speedInfo?.supSpeed &&
              libEntry.speedInfo.config
            ) {
              param = applySceneSpeed(param, device.sceneSpeed, libEntry.speedInfo.config);
            }
            this.log.debug(`ptReal: ${scene.name} → code=${libEntry.sceneCode}`);
            this.lanClient.setScene(device.lanIp, libEntry.sceneCode, param);
            return;
          }
        }
        // Scene not in library — fall through to Cloud
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      case "snapshot": {
        const idx = parseInt(String(value), 10);
        if (isNaN(idx) || idx < 1 || idx > device.snapshots.length) {
          this.log.warn(`${device.sku}: invalid snapshot index ${String(value)}`);
          return;
        }
        const cmdGroups = device.snapshotBleCmds?.[idx - 1];
        if (cmdGroups && cmdGroups.length > 0) {
          const allPackets = cmdGroups.flat();
          if (allPackets.length > 0) {
            this.log.debug(`ptReal Snapshot: ${device.snapshots[idx - 1].name} → ${allPackets.length} packets`);
            this.lanClient.sendPtReal(device.lanIp, allPackets);
            return;
          }
        }
        // No BLE data — fall through to Cloud
        this.cloudFallbackForCase(device, command, value);
        break;
      }
      default:
        // LAN doesn't support this command — fall through to Cloud
        this.cloudFallbackForCase(device, command, value);
    }
  }

  /**
   * Fire-and-forget Cloud fallback when a LAN-case can't service the
   * command locally (library miss, no BLE data, unsupported). Dedup
   * through the shared category map so log spam is bounded.
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private cloudFallbackForCase(device: GoveeDevice, command: string, value: unknown): void {
    this.sendCloudCommand(device, command, value).catch(e => {
      const prev = this.lastErrorByCategory.get("cloud-fallback") ?? null;
      this.lastErrorByCategory.set(
        "cloud-fallback",
        logDedup(this.log, prev, `Cloud fallback for ${device.name}/${command}`, e),
      );
    });
  }

  /**
   * Send command via Cloud API (rate-limited)
   *
   * @param device Target device
   * @param command Command type
   * @param value Command value
   */
  private async sendCloudCommand(device: GoveeDevice, command: string, value: unknown): Promise<void> {
    // M19 — closure capture: local variable after the guard. Prevents a race
    // when `setCloudClient(null)` runs between the guard check and
    // executeRateLimited (e.g. adapter stop mid-await).
    const cloudClient = this.cloudClient;
    if (!cloudClient) {
      return;
    }

    // Find the matching capability
    const cap = this.findCapabilityForCommand(device, command);
    if (!cap) {
      // M20 — dedup-warn instead of just debug. The user clicks a state, no
      // channel match → troubleshooting needs the first occurrence as a warn.
      const prev = this.lastErrorByCategory.get("no-capability") ?? null;
      this.lastErrorByCategory.set(
        "no-capability",
        logDedup(this.log, prev, `No channel for ${device.name}/${command}`, new Error("no matching capability")),
      );
      return;
    }

    const cloudValue = this.toCloudValue(device, command, value);

    const execute = async (): Promise<void> => {
      await cloudClient.controlDevice(device.sku, device.deviceId, cap.type, cap.instance, cloudValue);
    };

    await this.executeRateLimited(execute);
  }
}
