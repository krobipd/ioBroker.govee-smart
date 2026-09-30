// The labels a user reads for a value — in the system language, never Govee's wording or a raw identifier
// (fleet rule "readable values", CLAUDE_PATTERNS.md). Resolved once when a datapoint is built (plain strings:
// a translation object as a `common.states` label crashes the admin).
import { shortenGoveeType } from "./device-icons";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import { type I18nKey, resolveLabel } from "./i18n";

/**
 * Govee's words for the settings of an appliance (work modes, levels, the heater's stop behaviour), lower-cased.
 * `gearMode` is Govee's name for the manual level mode — the levels hang below it (lasswellt/govee-homeassistant
 * `humidifier.py`: "gearMode (workMode=1) — manual speed"; Hubitat-by-Mavrrick names the same field "Manual").
 * Scene, effect and music names are Govee's content, not settings, and stay as Govee names them.
 */
const OPTION_WORDS: Readonly<Record<string, I18nKey>> = {
  low: "optLow",
  medium: "optMedium",
  high: "optHigh",
  sleep: "optSleep",
  auto: "optAuto",
  manual: "optManual",
  gearmode: "optManual",
  custom: "optCustom",
  fan: "optFan",
  normal: "optNormal",
  maintain: "optMaintain",
  "auto stop": "optAutoStop",
  boiling: "optBoiling",
  tea: "optTea",
  coffee: "optCoffee",
  dryer: "optDryer",
};

/** `Speed 3` — the numbered levels of a fan-speed mode. */
const SPEED_LEVEL = /^speed\s+(\d+)$/i;

/**
 * The label of one option Govee declares for a setting: the translation where the word is known, Govee's own
 * text otherwise — a new word shows as Govee wrote it, never as nothing.
 *
 * @param name The option name Govee declares
 */
export function optionLabel(name: string): string {
  const word = name.trim();
  const key = OPTION_WORDS[word.toLowerCase()];
  if (key) {
    return resolveLabel(key);
  }
  const speed = SPEED_LEVEL.exec(word);
  return speed ? resolveLabel("optSpeedN", Number(speed[1])) : name;
}

/** The `info.type` value of a device whose Govee type the adapter does not know. */
export const UNKNOWN_DEVICE_TYPE = "unknown";

/** One label per Govee device type — the compiler keeps it complete. */
const DEVICE_TYPE_LABELS: Readonly<Record<keyof typeof GOVEE_DEVICE_TYPE, I18nKey>> = {
  LIGHT: "deviceTypeLight",
  THERMOMETER: "deviceTypeThermometer",
  SENSOR: "deviceTypeSensor",
  HEATER: "deviceTypeHeater",
  HUMIDIFIER: "deviceTypeHumidifier",
  DEHUMIDIFIER: "deviceTypeDehumidifier",
  FAN: "deviceTypeFan",
  AIR_PURIFIER: "deviceTypeAirPurifier",
  SOCKET: "deviceTypeSocket",
  KETTLE: "deviceTypeKettle",
  ICE_MAKER: "deviceTypeIceMaker",
  AROMA_DIFFUSER: "deviceTypeAromaDiffuser",
  BUTTON: "deviceTypeButton",
};

/**
 * The value of `info.type`: Govee's type without its prefix (`light`, `heater`) — scripts filter on it —, or
 * {@link UNKNOWN_DEVICE_TYPE} for a type outside the list, so the value is always one the list explains.
 *
 * @param govType Govee's device type (`devices.types.light`)
 */
export function infoTypeValue(govType: string | undefined): string {
  const short = shortenGoveeType(govType);
  return Object.values(GOVEE_DEVICE_TYPE).some(t => shortenGoveeType(t) === short) ? short : UNKNOWN_DEVICE_TYPE;
}

/** The value list of `info.type`: every Govee device type plus the unknown one, labelled in the system language. */
export function infoTypeStates(): Record<string, string> {
  const states: Record<string, string> = {};
  for (const [name, type] of Object.entries(GOVEE_DEVICE_TYPE)) {
    states[shortenGoveeType(type)] = resolveLabel(DEVICE_TYPE_LABELS[name as keyof typeof GOVEE_DEVICE_TYPE]);
  }
  states[UNKNOWN_DEVICE_TYPE] = resolveLabel("deviceTypeUnknown");
  return states;
}
