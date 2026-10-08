// K18: which command goes over the account broker — LAN first, then the broker, then the Cloud (krobi 2026-10-08 10:02).
// One rule for the command router (where the command goes) and the confirmation (who acks it, GV-13).
import { hexToRgb } from "./color";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import type { GoveeDevice } from "./types";

/** The light commands the account broker carries (govee2mqtt `src/service/iot.rs`), with the datapoint each writes. */
export const BROKER_COMMAND_DATAPOINTS: Readonly<Record<string, string>> = {
  power: "control.power",
  brightness: "control.brightness",
  colorRgb: "control.color_rgb",
  colorTemperature: "control.color_temperature",
};

/** What decides the broker route besides the device itself, as it stands when the command goes out. */
export interface BrokerRoute {
  /** The device has a LAN path right now — LAN always goes first. */
  lanPath: boolean;
  /** The account broker is connected. */
  brokerConnected: boolean;
  /** The catalog's `brokenBrokerCommands` quirk excludes this model. */
  brokerExcluded: boolean;
}

/**
 * Whether a command goes over the account broker: one of the four light commands, for a light without a LAN path that
 * has its device topic, while the broker is connected and the catalog does not exclude the model.
 *
 * @param device Target device
 * @param command Command token (`power`, `brightness`, `colorRgb`, `colorTemperature`)
 * @param route LAN path, broker connection and catalog exclusion at send time
 */
export function brokerCarries(device: GoveeDevice, command: string, route: BrokerRoute): boolean {
  return (
    Object.hasOwn(BROKER_COMMAND_DATAPOINTS, command) &&
    device.type === GOVEE_DEVICE_TYPE.LIGHT &&
    typeof device.iotTopic === "string" &&
    device.iotTopic !== "" &&
    !route.lanPath &&
    route.brokerConnected &&
    !route.brokerExcluded
  );
}

/**
 * The command token a datapoint is written by, when it is one the broker carries.
 *
 * @param stateSuffix Datapoint below the device (`control.power`, …)
 */
export function brokerCommandOf(stateSuffix: string): string | undefined {
  return Object.keys(BROKER_COMMAND_DATAPOINTS).find(c => BROKER_COMMAND_DATAPOINTS[c] === stateSuffix);
}

/** One broker command: Govee's command word, its data and the value that went out. */
export interface BrokerMessage {
  /** Govee's command word. */
  cmd: string;
  /** The command's data object. */
  data: Record<string, unknown>;
  /** The value that went out — the written one, clamped where the command carries less. */
  sent: unknown;
}

/**
 * The broker message for a light command, in govee2mqtt's form: `turn` 1/0, `brightness` 0–100, `colorwc` with either
 * the colour (and 0 K) or the colour temperature (and black).
 *
 * @param command Command token
 * @param value Written value
 */
export function brokerMessage(command: string, value: unknown): BrokerMessage {
  switch (command) {
    case "power": {
      const on = value === true || value === 1 || value === "true";
      return { cmd: "turn", data: { val: on ? 1 : 0 }, sent: on };
    }
    case "brightness": {
      const pct = Math.max(0, Math.min(100, Math.round(Number(value))));
      if (!Number.isFinite(pct)) {
        throw new Error(`Brightness ${JSON.stringify(value)} is no number`);
      }
      return { cmd: "brightness", data: { val: pct }, sent: pct };
    }
    case "colorRgb": {
      const color = hexToRgb(String(value));
      return { cmd: "colorwc", data: { color, colorTemInKelvin: 0 }, sent: value };
    }
    case "colorTemperature": {
      const kelvin = Math.round(Number(value));
      if (!Number.isFinite(kelvin) || kelvin <= 0) {
        throw new Error(`Colour temperature ${JSON.stringify(value)} is no Kelvin value`);
      }
      return { cmd: "colorwc", data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: kelvin }, sent: kelvin };
    }
    default:
      throw new Error(`The account broker carries no ${command} command`);
  }
}
