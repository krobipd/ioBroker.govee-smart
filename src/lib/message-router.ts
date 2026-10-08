import { errText } from "./types";
import { type ErrorCategory } from "./error-category";
import { accountEmail, hasAccountCredentials } from "./account-credentials";
import type { GoveeMqttClient, LoginVerdict } from "./govee-mqtt-client";
import { MQTT_PROBE_CONNECT_MS, VERIFICATION_REQUEST_THROTTLE_MS } from "./timing-constants";
import type { AuthCreds, AuthResponse } from "./auth-status";

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
  /**
   * Every device for the segment wizard's picker, with its reachability and segment count — the card offers what
   * it can measure. The diagnostics card has the fleet's own list (`diagnostics` `list`).
   */
  getDeviceList: () => Array<{ value: string; label: string; model: string; online: boolean; segments: number }>;
  /** The fleet's report jobs (`diagnostics/report-jobs.ts`): `list`, `start`, `result`. */
  handleDiagnostics: (payload: unknown) => Promise<unknown>;
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
 * Dispatches 3 commands:
 *  - `segmentWizard` — wizard step (start/yes/no/apply/abort)
 *  - `mqttAuth` — login test + verification-code request (with live credentials)
 *  - `diagnostics` — the fleet's report jobs (list, start, result) for the diagnostics card
 */
export class MessageRouter {
  /** Last time `requestCode` was triggered — guards against double-click email spam. */
  private lastVerificationRequestMs = 0;
  /** Separate throttle for the `test` action so it doesn't share the requestCode window (SEC-I1). */
  private lastTestRequestMs = 0;

  /**
   * Map a probe failure onto the case the card words. Category first; the verdict's `reason` names the
   * sub-cases inside a category (451 "email not registered" is AUTH like a
   * wrong password; a temporarily locked account; the adapter's own pause).
   *
   * @param failure          Last error from the probe client
   * @param failure.category Classified error category
   * @param failure.message  Client error message (the reason of a failed login)
   * @param failure.reason   Sub-case of the login verdict
   * @param failure.retryAt  When the login window has room again (ms), with `loginWindowFull`
   */
  private resultForProbeFailure(failure: {
    category: ErrorCategory;
    message: string;
    reason?: LoginVerdict["reason"];
    retryAt?: number;
  }): AuthResponse {
    // The sub-cases come as a field from the login verdict — never read back
    // out of the sentence.
    if (failure.reason === "loginWindowFull") {
      // The adapter's own pause: the account's login window is full, no login
      // was sent; retryAt is when it has room again.
      return { status: "loginWindowFull", retryAt: failure.retryAt };
    }
    switch (failure.category) {
      case "VERIFICATION_PENDING":
        return { status: "verifyRequired" };
      case "VERIFICATION_FAILED":
        return { status: "codeInvalid" };
      case "AUTH":
        return failure.reason === "emailNotRegistered"
          ? { status: "emailNotRegistered" }
          : { status: "passwordRejected" };
      case "RATE_LIMIT":
        return { status: "rateLimited" };
      default:
        return failure.reason === "accountLocked"
          ? { status: "accountLocked" }
          : { status: "loginFailed", reason: failure.message };
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
      this.host.log.warn(`onMessage handler crashed for ${obj.command}: ${errText(e)}`);
      this.host.sendResponse(obj, { error: errText(e) });
    });
  }

  /**
   * Async handler — dispatches to the 3 sub-handlers.
   *
   * @param obj Incoming ioBroker message
   */
  private async handleMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (obj.command === "segmentWizard") {
        const payload = (obj.message ?? {}) as { action?: string; device?: string; indices?: number[] };
        if (payload.action === "list") {
          this.host.sendResponse(obj, { devices: this.host.getDeviceList() });
          return;
        }
        const response = await this.host.runWizardStep(payload.action ?? "", payload.device ?? "", {
          indices: payload.indices,
        });
        this.host.sendResponse(obj, response);
        return;
      }
      if (obj.command === "diagnostics") {
        // The fleet's report jobs answer at once — a report may take longer than the admin's 30 s per answer.
        this.host.sendResponse(obj, await this.host.handleDiagnostics(obj.message));
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
      this.host.log.warn(`onMessage failed for ${obj.command}: ${errText(e)}`);
      this.host.sendResponse(obj, { error: errText(e) });
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
    const email = accountEmail(creds.email ?? config.goveeEmail);
    const password = creds.password ?? config.goveePassword ?? "";
    const code = (creds.code ?? config.mqttVerificationCode ?? "").trim();
    if (!hasAccountCredentials(email, password)) {
      return { status: "needCredentials" };
    }
    if (action === "test") {
      const now = Date.now();
      if (now - this.lastTestRequestMs < VERIFICATION_REQUEST_THROTTLE_MS) {
        return { status: "throttled" };
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
          return { status: "ok" };
        }
        // A broker-stage failure (cert rejected, subscribe refused) can land
        // during the edge-wait — prefer the concrete reason over "not up".
        const lateFailure = probe.getLastError();
        return lateFailure ? this.resultForProbeFailure(lateFailure) : { status: "mqttNotUp" };
      } catch (e) {
        // Safety net for unexpected synchronous throws only — the regular
        // failure paths never reject (see above).
        return { status: "loginFailed", reason: errText(e) };
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
        return { status: "throttled" };
      }
      this.lastVerificationRequestMs = now;
      const probe = this.host.createMqttProbeClient(email, password);
      try {
        await probe.requestVerificationCode();
        return { status: "codeSent" };
      } catch (e) {
        return { status: "codeRejected", reason: errText(e) };
      }
    }
    return { status: "unknownAction" };
  }
}
