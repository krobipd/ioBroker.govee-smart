// The account broker's events: its diagnostics hooks, the verification code, the problems the user has to act on
// (a code Govee wants, rejected credentials, a blocked login) and what a (re)connection sets right.
import type { ActionableProblems } from "../actionable-problems";
import type { DeviceManager } from "../device-manager";
import type { GoveeMqttClient } from "../govee-mqtt-client";
import type { StateManager } from "../state-manager";
import { errText, logRejected } from "../types";
import * as cloudCreds from "./cloud-creds-handler";
import * as connectionState from "./connection-state";

/** The adapter surface the account handler needs. */
export interface AccountHandlerAdapter extends cloudCreds.CloudCredsAdapter {
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  readonly actionableProblems: ActionableProblems;
}

/**
 * Wire the account client's hooks: the recent packets and the two account calls into the report, the verification
 * code from the settings, and the problems the user has to act on.
 *
 * @param adapter Adapter surface
 * @param client The account client
 * @param verificationCode The code from the settings (may be empty)
 */
export function wireAccountClient(
  adapter: AccountHandlerAdapter,
  client: GoveeMqttClient,
  verificationCode: string,
): void {
  // Forward every parsed MQTT message into the diagnostics ring buffer
  // so the report contains the recent packets per device. v2.9.1: the
  // hook gets both BLE-hex (op.command) and the raw JSON envelope so
  // state-only pushes are also captured.
  client.setPacketHook((deviceId, topic, payload) => {
    adapter.deviceManager?.getDiagnostics().addMqttPacket(deviceId, topic, payload);
  });

  // Login + IoT-key outcome into the report. Credentials never travel —
  // only which call, whether Govee accepted it, its status and its own
  // message. Two filed issues were exactly this case and the report could
  // not tell them apart from "no account entered".
  client.setOnAccountCall((endpoint, ok, statusCode, message) => {
    adapter.deviceManager?.getDiagnostics().recordAccountCall(endpoint, ok, statusCode, message);
  });

  // 2FA: forward optional code from settings into the next login attempt;
  // clear the field automatically once Govee has accepted it.
  client.setVerificationCode(verificationCode);
  client.setOnVerificationConsumed(() => {
    cloudCreds.clearVerificationCodeSetting(adapter).catch(e => {
      adapter.log.warn(`Could not clear mqttVerificationCode: ${errText(e)}`);
    });
  });
  client.setOnVerificationFailed(reason => {
    // On 'failed' (455 / 454+code-was-sent) blank the code so the user
    // doesn't keep retrying with a stale value. On 'pending' (454 + no
    // code) we leave the field as-is — the user is about to fill it.
    // Surface the "code needed" state on info.verificationPending so the
    // connection card can show it live (the notification below is only a
    // nudge for when the user isn't in the settings — the actual flow
    // runs through the card, never a second login path).
    adapter.stateManager
      ?.writeReadOnly("info.verificationPending", true)
      .catch(logRejected(adapter.log, "best-effort write"));
    if (reason === "failed") {
      cloudCreds
        .clearVerificationCodeSetting(adapter)
        .catch(logRejected(adapter.log, "clear the verification code setting"));
      adapter.actionableProblems.report({
        key: "mqtt-verification",
        title: "Govee rejected the verification code for real-time status",
        action:
          "open the adapter settings — the connection card requests a fresh code; enter the one Govee e-mails you",
      });
    } else {
      adapter.actionableProblems.report({
        key: "mqtt-verification",
        title: "Govee requires a verification code to enable real-time status (lights/sensors stay readable)",
        action: "open the adapter settings — the connection card requests a code and takes the one Govee e-mails you",
      });
    }
  });
  client.setOnAuthFailed(() => {
    adapter.actionableProblems.report({
      key: "mqtt-auth",
      title: "Govee rejected the account login for real-time status",
      action: "check the Govee email and password in the adapter settings (connection card)",
    });
  });
  client.setOnLoginBlocked(() => {
    adapter.actionableProblems.report({
      key: "mqtt-login-blocked",
      title: "Govee stopped accepting the account login for real-time status",
      action:
        "Govee rejected repeated login attempts (the account may be temporarily locked). Automatic retries are stopped — check your Govee account, then restart the adapter",
    });
  });
}

/**
 * The account broker connected or dropped: the indicator, the problems a connection settles, and on a
 * (re)connection the status requests for what went quiet meanwhile.
 *
 * @param adapter Adapter surface
 * @param connected The broker is connected
 */
export function onAccountConnection(
  adapter: AccountHandlerAdapter & connectionState.ConnectionStateAdapter,
  connected: boolean,
): void {
  adapter.stateManager
    ?.writeReadOnly("info.mqttConnected", connected)
    .catch(logRejected(adapter.log, "best-effort write"));
  if (connected) {
    adapter.actionableProblems.resolve("mqtt-verification", "Govee real-time status connected — verification accepted");
    adapter.actionableProblems.resolve("mqtt-auth", "Govee account login accepted");
    adapter.actionableProblems.resolve("mqtt-login-blocked", "Govee account login accepted");
    adapter.stateManager
      ?.writeReadOnly("info.verificationPending", false)
      .catch(logRejected(adapter.log, "best-effort write"));
    connectionState.checkAllReady(adapter);
    // A (re)connected broker: ask right away what went quiet while
    // it was down — the topics are known from the last list poll.
    adapter.deviceManager?.requestStaleStatuses();
  }
  connectionState.updateConnectionState(adapter);
}
