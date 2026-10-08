// GV-13: which written datapoint a device report confirms, and which counts as confirmed once it went out without an error.
import { isLanDriven } from "./device-manager/lookups";
import type { GoveeDevice } from "./types";

/** `report` — only the device's own report acks the datapoint; `send` — a clean send (or Govee's "success") acks it. */
export type Confirmation = "report" | "send";

/** The channels that carry device reports, as they stand when the command goes out. */
export interface ReportChannels {
  /** The LAN client is bound and hears `devStatus` answers. */
  lanListening: boolean;
  /** The account broker is connected — the device's own status push arrives over it. */
  brokerConnected: boolean;
}

/** The four values a LAN light answers in its `devStatus` (govee-lan-client `parseStatus`). */
const LAN_STATUS_DATAPOINTS: ReadonlySet<string> = new Set([
  "control.power",
  "control.brightness",
  "control.color_rgb",
  "control.color_temperature",
]);

/** A segment's colour or brightness — the AA A5 echo carries both, learned as one key. */
const SEGMENT_DATAPOINT = /^segments\.\d+\.(?:color|brightness)$/;

/**
 * The key a datapoint is learned under in `GoveeDevice.pushReports`.
 *
 * @param stateSuffix Datapoint below the device
 */
export function pushReportKey(stateSuffix: string): string {
  return SEGMENT_DATAPOINT.test(stateSuffix) ? "segments" : stateSuffix;
}

/**
 * How a write to this datapoint is confirmed (GV-13, krobi 2026-10-08: where Govee delivers a device report only it
 * confirms; elsewhere a clean send or Govee's "success" counts). A report counts only where its writer really runs: the
 * LAN status of a light the LAN client hears, and — with the account broker connected — a field this device's own status
 * push has carried before (learned per device and field, never a model list). Everything else is confirmed by the send.
 *
 * @param device Target device
 * @param stateSuffix Written datapoint below the device (`control.power`, …)
 * @param channels Report channels at send time
 * @param now Current time (ms)
 */
export function confirmationFor(
  device: GoveeDevice,
  stateSuffix: string,
  channels: ReportChannels,
  now: number = Date.now(),
): Confirmation {
  if (LAN_STATUS_DATAPOINTS.has(stateSuffix) && channels.lanListening && device.lanIp && isLanDriven(device, now)) {
    return "report";
  }
  if (channels.brokerConnected && device.iotTopic && device.pushReports?.includes(pushReportKey(stateSuffix))) {
    return "report";
  }
  return "send";
}
