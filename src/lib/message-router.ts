import { errMessage, type ErrorCategory } from "./types";
import type { GoveeMqttClient } from "./govee-mqtt-client";
import { MQTT_PROBE_CONNECT_MS, VERIFICATION_REQUEST_THROTTLE_MS } from "./timing-constants";
import { resolveLabel } from "./i18n";

/**
 * Machine-readable outcome of a `mqttAuth` action. The React connection card
 * reacts to `status` (e.g. `verifyRequired` → open the 2FA field); `result` is
 * the localized text for a toast / fallback. Kept a superset for both actions.
 */
export type AuthStatus =
  | "ok"
  | "verifyRequired"
  | "codeInvalid"
  | "passwordRejected"
  | "emailNotRegistered"
  | "rateLimited"
  | "accountLocked"
  | "loginFailed"
  | "mqttNotUp"
  | "codeSent"
  | "codeRejected"
  | "needCredentials"
  | "throttled"
  | "unknownAction";

/** Structured `mqttAuth` response — `result` = localized text, `status` = the case. */
export interface AuthResponse {
  /** Localized, user-readable text (toast / fallback). */
  result: string;
  /** Machine-readable case the connection card reacts to. */
  status: AuthStatus;
}

/** Credentials the user is currently editing in the card, sent with the action. */
export interface AuthCreds {
  /** Account email (falls back to the saved config when omitted). */
  email?: string;
  /** Account password (falls back to the saved config when omitted). */
  password?: string;
  /** 2FA verification code (falls back to the saved config when omitted). */
  code?: string;
}

/**
 * Host interface for MessageRouter.
 *
 * Same pattern as SnapshotHandler/GroupFanoutHandler — main.ts stays slim and
 * the onMessage/sendTo path is isolated and testable.
 */
export interface MessageRouterHost {
  /** Adapter logger. */
  log: ioBroker.Logger;
  /** Saved adapter config — fallback when the card sends no live credentials. */
  getConfig: () => { goveeEmail: string; goveePassword: string; mqttVerificationCode?: string };
  /** Sends the JSON response back to the caller (sendMessageResponse path). */
  sendResponse: (obj: ioBroker.Message, data: unknown) => void;
  /**
   * Factory for a one-shot MqttClient (for the login test), built with the
   * given credentials — so a test uses what the user is currently editing in
   * the card, without having to save first.
   */
  createMqttProbeClient: (email: string, password: string) => GoveeMqttClient;
  /** Provides the list of devices that have segments (for getSegmentDevices). */
  getSegmentDeviceList: () => Array<{ value: string; label: string }>;
  /** Every device, for the diagnostics card's picker. */
  getDiagnosticsDeviceList: () => Array<{ value: string; label: string; model: string }>;
  /**
   * Builds the report for one device and returns it WITH its content, so the
   * admin card can hand the user a file straight away. The report is written to
   * the instance's file storage as well — the card is the convenient path, the
   * file browser is the one that still works when the card is not open.
   */
  buildDiagnosticsReport: (deviceKey: string) => Promise<{ fileName: string; content: string } | { error: string }>;
  /** Wizard-step routing — main.ts keeps the wizard state. */
  runWizardStep: (
    action: string,
    deviceKey: string,
    payload?: { indices?: number[] },
  ) => Promise<Record<string, unknown>>;
  /** Adapter-managed setTimeout (cleaned up on unload) for the bounded probe wait. */
  setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** Adapter-managed clearTimeout counterpart. */
  clearTimeout: (handle: ioBroker.Timeout | undefined) => void;
}

/**
 * Router for ioBroker.Message events (sendTo from the admin UI).
 *
 * Dispatches 4 commands:
 *  - `getSegmentDevices` — selectSendTo data source for the wizard
 *  - `segmentWizard` — wizard step (start/yes/no/done/abort)
 *  - `mqttAuth` — login test + verification-code request (with live credentials)
 *  - `diagnostics` — device list + report build for the diagnostics card
 */
export class MessageRouter {
  /** Last time `requestCode` was triggered — guards against double-click email spam. */
  private lastVerificationRequestMs = 0;
  /** Separate throttle for the `test` action so it doesn't share the requestCode window (SEC-I1). */
  private lastTestRequestMs = 0;

  /**
   * Map a probe failure (category + raw client message) onto the localized
   * admin result label AND a machine-readable status. Category first; the raw
   * message only disambiguates sub-cases inside a category (451 "email not
   * registered" is AUTH like a wrong password) and the not-classifiable Govee
   * account states.
   *
   * @param failure          Last error from the probe client
   * @param failure.category Classified error category
   * @param failure.message  Raw client error message
   */
  private resultForProbeFailure(failure: { category: ErrorCategory; message: string }): AuthResponse {
    switch (failure.category) {
      case "VERIFICATION_PENDING":
        return { result: resolveLabel("mqttAuthVerifyRequired"), status: "verifyRequired" };
      case "VERIFICATION_FAILED":
        return { result: resolveLabel("mqttAuthCodeInvalid"), status: "codeInvalid" };
      case "AUTH":
        return /email not registered/i.test(failure.message)
          ? { result: resolveLabel("mqttAuthEmailNotRegistered"), status: "emailNotRegistered" }
          : { result: resolveLabel("mqttAuthPasswordRejected"), status: "passwordRejected" };
      case "RATE_LIMIT":
        return { result: resolveLabel("mqttAuthRateLimited"), status: "rateLimited" };
      default:
        return /account temporarily locked/i.test(failure.message)
          ? { result: resolveLabel("mqttAuthAccountLocked"), status: "accountLocked" }
          : { result: resolveLabel("mqttAuthLoginFailed", failure.message), status: "loginFailed" };
    }
  }

  /**
   * @param host Adapter dependencies via the host interface
   * @param probeConnectTimeoutMs How long the "Test login" probe waits for the
   *   MQTT connect edge after login succeeds (default {@link MQTT_PROBE_CONNECT_MS};
   *   tests inject a small value)
   */
  constructor(
    private readonly host: MessageRouterHost,
    private readonly probeConnectTimeoutMs: number = MQTT_PROBE_CONNECT_MS,
  ) {}

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
        const payload = (obj.message ?? {}) as { action?: string; device?: string; indices?: number[] };
        const response = await this.host.runWizardStep(payload.action ?? "", payload.device ?? "", {
          indices: payload.indices,
        });
        this.host.sendResponse(obj, response);
        return;
      }
      if (obj.command === "diagnostics") {
        const payload = (obj.message ?? {}) as { action?: string; device?: string };
        if (payload.action === "list") {
          this.host.sendResponse(obj, { devices: this.host.getDiagnosticsDeviceList() });
          return;
        }
        if (payload.action === "export") {
          // The content travels back with the answer so the card can put a file
          // in the user's download folder in one click. Around 68 KB — well
          // inside what the admin socket carries, and it happens once per press.
          this.host.sendResponse(obj, await this.host.buildDiagnosticsReport(payload.device ?? ""));
          return;
        }
        this.host.sendResponse(obj, { error: `Unknown diagnostics action '${payload.action ?? ""}'` });
        return;
      }
      if (obj.command === "mqttAuth") {
        const payload = (obj.message ?? {}) as { action?: string; email?: string; password?: string; code?: string };
        const response = await this.runMqttAuthAction(payload.action ?? "", {
          email: payload.email,
          password: payload.password,
          code: payload.code,
        });
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
   *   - `test`        — try a one-shot login with the given credentials (live
   *                     from the card, or the saved config) and return the case.
   *   - `requestCode` — POST to /verification, Govee mails a fresh code.
   *                     30s in-memory throttle against double-click email spam.
   *
   * @param action Action name from the connection card
   * @param creds  Credentials the user is currently editing (fallback: saved config)
   */
  private async runMqttAuthAction(action: string, creds: AuthCreds = {}): Promise<AuthResponse> {
    const config = this.host.getConfig();
    const email = (creds.email ?? config.goveeEmail ?? "").trim();
    const password = creds.password ?? config.goveePassword ?? "";
    const code = (creds.code ?? config.mqttVerificationCode ?? "").trim();
    if (!email || !password) {
      return { result: resolveLabel("mqttAuthNeedCredentials"), status: "needCredentials" };
    }
    if (action === "test") {
      const now = Date.now();
      if (now - this.lastTestRequestMs < VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil((VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastTestRequestMs)) / 1000);
        return { result: resolveLabel("mqttAuthThrottled", remainingSec), status: "throttled" };
      }
      this.lastTestRequestMs = now;
      const probe = this.host.createMqttProbeClient(email, password);
      probe.setVerificationCode(code);
      let probeTimer: ioBroker.Timeout | undefined;
      try {
        // The "connected" edge (onConnection(true)) arrives asynchronously AFTER
        // connect() resolves — connect() only does the login + cert handshake and
        // then issues the MQTT connect. Set up the capture promise BEFORE calling
        // connect() so the edge can't be missed (M2: the old code read a flag
        // synchronously right after connect() and always reported "MQTT not up").
        let signalConnected: (v: boolean) => void = () => {};
        const connectedEdge = new Promise<boolean>(resolve => {
          signalConnected = resolve;
        });
        // connect() NEVER rejects — every failure path inside the client ends
        // in a classified return (see GoveeMqttClient.getLastError). The
        // outcome MUST be read from getLastError(), not from a try/catch.
        await probe.connect(
          () => {},
          isConnected => {
            if (isConnected) {
              signalConnected(true);
            }
          },
        );
        // Login-stage failure (wrong password, 2FA, rate limit …) is known
        // synchronously after connect() resolves — classify immediately
        // instead of burning the 10s edge-wait on a doomed probe.
        const loginFailure = probe.getLastError();
        if (loginFailure) {
          return this.resultForProbeFailure(loginFailure);
        }
        // Login + cert OK. Wait a bounded time for the MQTT socket to actually
        // connect + subscribe; a timeout means "credentials fine, MQTT not up".
        // The timeout also guarantees the admin sendTo never hangs on the probe.
        const connected = await Promise.race([
          connectedEdge,
          new Promise<boolean>(resolve => {
            probeTimer = this.host.setTimeout(() => resolve(false), this.probeConnectTimeoutMs);
          }),
        ]);
        if (connected) {
          return { result: resolveLabel("mqttAuthLoginOk"), status: "ok" };
        }
        // A broker-stage failure (cert rejected, subscribe refused) can land
        // during the edge-wait — prefer the concrete reason over "not up".
        const lateFailure = probe.getLastError();
        return lateFailure
          ? this.resultForProbeFailure(lateFailure)
          : { result: resolveLabel("mqttAuthLoginNoMqtt"), status: "mqttNotUp" };
      } catch (e) {
        // Safety net for unexpected synchronous throws only — the regular
        // failure paths never reject (see above).
        return {
          result: resolveLabel("mqttAuthLoginFailed", e instanceof Error ? e.message : String(e)),
          status: "loginFailed",
        };
      } finally {
        // Dispose on every path — success, timeout, and error — so the probe's
        // MQTT socket + reconnect timer never leak (the old code disconnected
        // only on the success path).
        if (probeTimer) {
          this.host.clearTimeout(probeTimer);
        }
        probe.disconnect();
      }
    }
    if (action === "requestCode") {
      const now = Date.now();
      if (now - this.lastVerificationRequestMs < VERIFICATION_REQUEST_THROTTLE_MS) {
        const remainingSec = Math.ceil(
          (VERIFICATION_REQUEST_THROTTLE_MS - (now - this.lastVerificationRequestMs)) / 1000,
        );
        return { result: resolveLabel("mqttAuthThrottled", remainingSec), status: "throttled" };
      }
      this.lastVerificationRequestMs = now;
      const probe = this.host.createMqttProbeClient(email, password);
      try {
        await probe.requestVerificationCode();
        return { result: resolveLabel("mqttAuthCodeSent"), status: "codeSent" };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { result: resolveLabel("mqttAuthCodeRejected", msg), status: "codeRejected" };
      }
    }
    return { result: resolveLabel("mqttAuthUnknownAction", action), status: "unknownAction" };
  }
}
