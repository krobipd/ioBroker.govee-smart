import { errMessage } from "./types";
import type { GoveeMqttClient } from "./govee-mqtt-client";
import { VERIFICATION_REQUEST_THROTTLE_MS } from "./timing-constants";
import { resolveLabel } from "./i18n";

/**
 * Host interface for MessageRouter.
 *
 * Same pattern as SnapshotHandler/GroupFanoutHandler — main.ts stays slim and
 * the onMessage/sendTo path is isolated and testable.
 */
export interface MessageRouterHost {
  /** Adapter logger. */
  log: ioBroker.Logger;
  /** Provides the adapter config for the runMqttAuthAction path. */
  getConfig: () => { goveeEmail: string; goveePassword: string; mqttVerificationCode?: string };
  /** Sends the JSON response back to the caller (sendMessageResponse path). */
  sendResponse: (obj: ioBroker.Message, data: unknown) => void;
  /** Factory for a one-shot MqttClient (for the login test). */
  createMqttProbeClient: () => GoveeMqttClient;
  /** Provides the list of devices that have segments (for getSegmentDevices). */
  getSegmentDeviceList: () => Array<{ value: string; label: string }>;
  /** Wizard-step routing — main.ts keeps the wizard state. */
  runWizardStep: (action: string, deviceKey: string) => Promise<Record<string, unknown>>;
}

/**
 * Router for ioBroker.Message events (sendTo from the admin UI).
 *
 * Dispatches 3 commands:
 *  - `getSegmentDevices` — selectSendTo data source for the wizard
 *  - `segmentWizard` — wizard step (start/yes/no/done/abort)
 *  - `mqttAuth` — login test + verification-code request
 */
export class MessageRouter {
  /** Last time `requestCode` was triggered — guards against double-click email spam. */
  private lastVerificationRequestMs = 0;
  /** Separate throttle for the `test` action so it doesn't share the requestCode window (SEC-I1). */
  private lastTestRequestMs = 0;

  /**
   * @param host Adapter dependencies via the host interface
   */
  constructor(private readonly host: MessageRouterHost) {}

  /**
   * Sync entry-point — registered as `this.on("message", ...)`. Wraps the
   * async handler in a catch so unhandled rejections can't crash the adapter.
   *
   * @param obj Incoming ioBroker message
   */
  onMessage(obj: ioBroker.Message): void {
    if (!obj?.command) {
      return;
    }
    this.handleMessage(obj).catch(e => {
      this.host.log.warn(`onMessage handler crashed for ${obj.command}: ${errMessage(e)}`);
      this.host.sendResponse(obj, { error: e instanceof Error ? e.message : String(e) });
    });
  }

  /**
   * Async handler — dispatches to the 3 sub-handlers.
   *
   * @param obj Incoming ioBroker message
   */
  private async handleMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (obj.command === "getSegmentDevices") {
        this.host.sendResponse(obj, this.host.getSegmentDeviceList());
        return;
      }
      if (obj.command === "segmentWizard") {
        const payload = (obj.message ?? {}) as { action?: string; device?: string };
        const response = await this.host.runWizardStep(payload.action ?? "", payload.device ?? "");
        this.host.sendResponse(obj, response);
        return;
      }
      if (obj.command === "mqttAuth") {
        const payload = (obj.message ?? {}) as { action?: string };
        const response = await this.runMqttAuthAction(payload.action ?? "");
        this.host.sendResponse(obj, response);
        return;
      }
      // Unknown command — must respond, otherwise the admin sendTo() call
      // hangs in its 5s timeout (pattern from beszel v0.4.4 H4 fix).
      this.host.log.debug(`onMessage: unknown command '${obj.command}'`);
      this.host.sendResponse(obj, { error: `Unknown command '${obj.command}'` });
    } catch (e) {
      this.host.log.warn(`onMessage failed for ${obj.command}: ${errMessage(e)}`);
      this.host.sendResponse(obj, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Handle the `mqttAuth` onMessage commands.
   *
   * Two actions:
   *   - `test`        — try a one-shot login with the current settings combo
   *                     and return a single user-readable result.
   *   - `requestCode` — POST to /verification, Govee mails a fresh code.
   *                     30s in-memory throttle against double-click email spam.
   *
   * @param action Action name from the jsonConfig sendTo button
   */
  private async runMqttAuthAction(action: string): Promise<{ result: string }> {
    const config = this.host.getConfig();
    if (!config.goveeEmail || !config.goveePassword) {
      return { result: resolveLabel("mqttAuthNeedCredentials") };
    }
    if (action === "test") {
      const now = Date.now();
      if (now - this.lastTestRequestMs < VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil((VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastTestRequestMs)) / 1000);
        return { result: resolveLabel("mqttAuthThrottled", remainingSec) };
      }
      this.lastTestRequestMs = now;
      const probe = this.host.createMqttProbeClient();
      probe.setVerificationCode(config.mqttVerificationCode ?? "");
      try {
        let connected = false;
        await probe.connect(
          () => {},
          isConnected => {
            connected = isConnected;
          },
        );
        probe.disconnect();
        return {
          result: connected ? resolveLabel("mqttAuthLoginOk") : resolveLabel("mqttAuthLoginNoMqtt"),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Verification required/i.test(msg)) {
          return { result: resolveLabel("mqttAuthVerifyRequired") };
        }
        if (/Verification code invalid/i.test(msg)) {
          return { result: resolveLabel("mqttAuthCodeInvalid") };
        }
        if (/email not registered/i.test(msg)) {
          return { result: resolveLabel("mqttAuthEmailNotRegistered") };
        }
        if (/Login failed/i.test(msg)) {
          return { result: resolveLabel("mqttAuthPasswordRejected") };
        }
        if (/Rate limited/i.test(msg)) {
          return { result: resolveLabel("mqttAuthRateLimited") };
        }
        if (/Account temporarily locked/i.test(msg)) {
          return { result: resolveLabel("mqttAuthAccountLocked") };
        }
        return { result: resolveLabel("mqttAuthLoginFailed", msg) };
      }
    }
    if (action === "requestCode") {
      const now = Date.now();
      if (now - this.lastVerificationRequestMs < VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil(
          (VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastVerificationRequestMs)) / 1000,
        );
        return { result: resolveLabel("mqttAuthThrottled", remainingSec) };
      }
      this.lastVerificationRequestMs = now;
      const probe = this.host.createMqttProbeClient();
      try {
        await probe.requestVerificationCode();
        return { result: resolveLabel("mqttAuthCodeSent") };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { result: resolveLabel("mqttAuthCodeRejected", msg) };
      }
    }
    return { result: resolveLabel("mqttAuthUnknownAction", action) };
  }
}
