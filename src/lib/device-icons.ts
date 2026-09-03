/**
 * Inline SVG icons (data: URIs) for device types — used as `common.icon`
 * on device objects so the Object-Browser shows a glanceable type marker
 * next to each device.
 *
 * Sources: Material Design Icons (Apache 2.0). Kept inline so the build
 * pipeline doesn't need separate icon files.
 */

import { GOVEE_DEVICE_TYPE } from "./govee-constants";

const LIGHT =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTkgMjFjMCAuNTUuNDUgMSAxIDFoNGMuNTUgMCAxLS40NSAxLTF2LTFIOXYxem0zLTE5QzguMTQgMiA1IDUuMTQgNSA5YzAgMi4zOCAxLjE5IDQuNDcgMyA1Ljc0VjE3YzAgLjU1LjQ1IDEgMSAxaDZjLjU1IDAgMS0uNDUgMS0xdi0yLjI2YzEuODEtMS4yNyAzLTMuMzYgMy01Ljc0IDAtMy44Ni0zLjE0LTctNy03eiIvPjwvc3ZnPg==";

const THERMOMETER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE1IDEzVjVjMC0xLjY2LTEuMzQtMy0zLTNTOSAzLjM0IDkgNXY4Yy0xLjIxLjkxLTIgMi4zNS0yIDQgMCAyLjc2IDIuMjQgNSA1IDVzNS0yLjI0IDUtNWMwLTEuNjUtLjc5LTMuMDktMi00em0tNC04YzAtLjU1LjQ1LTEgMS0xczEgLjQ1IDEgMWgtMnYxaDJ2MmgtMnYxaDJ2MmgtMnYxLjFjMS40NC40NyAyLjUgMS44IDIuNSAzLjQgMCAyLjA5LTEuNzEgMy43NS0zLjc1IDMuNzVTNyAxOS4xOSA3IDE3LjFjMC0xLjYgMS4wNi0yLjkzIDIuNS0zLjRWNXoiLz48L3N2Zz4=";

const HEATER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE3LjY2IDExLjJjLS4yMy0uMzMtLjQ4LS42Ni0uNzgtLjk4Yy0uNTctLjY2LTEuMjEtMS4zMi0xLjg2LTEuOTdjLTEuMzgtMS4zNS0yLjg2LTIuNzMtMy45Ny00LjU0Yy0uNDgtLjc4LS44LTEuNTktMS4wMi0yLjQyYy0uNTguODYtMS4wOSAxLjctMS41OSAyLjU1Yy0uODcgMS40OS0xLjY3IDIuOTYtMi4yMyA0LjUyYy0uNzcgMi4xNi0xLjAxIDQuMzgtLjUyIDYuNTRjLjUgMi4xNiAxLjY3IDQuMjUgMy4zNyA1LjcxYy44Ni43NCAxLjg5IDEuMzMgMyAxLjc2YzEuMS40MyAyLjI4LjY3IDMuNDcuNzFjMS4xOS4wNCAyLjQtLjEyIDMuNTQtLjUyYzEuMTQtLjQgMi4yMS0xLjAyIDMuMTctMS44NWMxLjg5LTEuNjMgMy4yNi0zLjc4IDMuNTctNi4xN2MuMzEtMi4zOS0uNTQtNC44NC0yLjE1LTYuNTd6Ii8+PC9zdmc+";

const HUMIDIFIER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDIuNVMxOSA3IDE5IDEzYzAgMy44Ny0zLjEzIDctNyA3cy03LTMuMTMtNy03YzAtNiA3LTEwLjUgNy0xMC41eiIvPjwvc3ZnPg==";

const FAN =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDExYzEuMSAwIDItLjkgMi0yYzAtMS4xLS45LTItMi0yYy0xLjEgMC0yIC45LTIgMmMwIDEuMS45IDIgMiAyem05LjU2LTEuM2MwIC4xMS4wMy4yLjAzLjMxYzAgMi4xMy0xLjI3IDQuMzMtMy4yNCA1LjY3Yy43Ni0xLjMzIDEuMjEtMi44NyAxLjIxLTQuNDdjMC0uNTQtLjA1LTEuMDgtLjE1LTEuNjFjMS4yLS40MSAyLjE2LS43OSAyLjE1LjF6TTYuNDQgOS43YzEuMi0uOTEgMi4xNi0xLjI4IDIuMTYuMWMtLjEuNTMtLjE1IDEuMDctLjE1IDEuNjFjMCAxLjYuNDUgMy4xNCAxLjIxIDQuNDdjLTEuOTctMS4zNC0zLjI0LTMuNTMtMy4yNC01LjY3YzAtLjEuMDMtLjIuMDMtLjMxbS0uNyA0LjJjLjE2LjA5LjI4LjE5LjQyLjI3Yy0xLjk3IDEuMzQtMy4yNCAzLjUzLTMuMjQgNS42N2MwIC4xLjAzLjIuMDMuMzFjMCAuMTEuMDMuMi4wMy4zMWMwIDEuOTYgMS40OCA0LjEzIDMuMTUgNS41OWMtLjMzLTEuMTYtLjUyLTIuMy0uNTItMy40NWMwLTIuMSAuNDQtNC4xNiAxLjA1LTYuMDhjLS4zMS0uMjEtLjYxLS40NC0uOTItLjY3eiIvPjwvc3ZnPg==";

const AIR_PURIFIER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTBzMTAtNC40OCAxMC0xMFMxNy41MiAyIDEyIDJ6bS41IDE2YzAgLjI4LS4yMi41LS41LjVzLS41LS4yMi0uNS0uNXYtMmMwLS4yOC4yMi0uNS41LS41cy41LjIyLjUuNXYyem0wLTRjMCAuMjgtLjIyLjUtLjUuNXMtLjUtLjIyLS41LS41di0xMmMwLS4yOC4yMi0uNS41LS41cy41LjIyLjUuNXYxMnoiLz48L3N2Zz4=";

const SOCKET =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE2IDdoLTEuOWwtLjg1LTEuN2EuNS41IDAgMCAwLS40NS0uM2gtNS42YS41LjUgMCAwIDAtLjQ1LjNMNi45IDdINWMtMS4xMSAwLTIgLjg5LTIgMnYxMmMwIDEuMTEuODkgMiAyIDJoMTFjMS4xMSAwIDItLjg5IDItMlY5YzAtMS4xMS0uODktMi0yLTJ6TTEwIDhoMnY1aC0yek04IDhoMnY1SDh6Ii8+PC9zdmc+";

const KETTLE =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE5IDE0VjlsLTQtNGgtNGEzIDMgMCAwIDAtMyAzdjZsLTIgMnY0aDE2di00bC0zLTJ6Ii8+PC9zdmc+";

const ICE_MAKER = SOCKET; // placeholder until a dedicated icon is needed
const AROMA = HUMIDIFIER; // close enough — both diffuse moisture/scent

/** Battery button / remote — a press-ring. */
const BUTTON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJhMTAgMTAgMCAxIDAgMCAyMCAxMCAxMCAwIDAgMCAwLTIwem0wIDJhOCA4IDAgMSAxIDAgMTYgOCA4IDAgMCAxIDAtMTZ6Ii8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIvPjwvc3ZnPg==";

const GROUP =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTE2IDExYzEuNjYgMCAyLjk5LTEuMzQgMi45OS0zUzE3LjY2IDUgMTYgNWMtMS42NiAwLTMgMS4zNC0zIDNzMS4zNCAzIDMgM3ptLTggMGMxLjY2IDAgMi45OS0xLjM0IDIuOTktM1M5LjY2IDUgOCA1QzYuMzQgNSA1IDYuMzQgNSA4czEuMzQgMyAzIDN6bTAgMmMtMi4zMyAwLTcgMS4xNy03IDMuNVYxOWgxNHYtMi41YzAtMi4zMy00LjY3LTMuNS03LTMuNXptOCAwYy0uMjkgMC0uNjIuMDItLjk3LjA1IDEuMTYuODQgMS45NyAxLjk3IDEuOTcgMy40NVYxOWg2di0yLjVjMC0yLjMzLTQuNjctMy41LTctMy41eiIvPjwvc3ZnPg==";

/**
 * Map a Govee device type (e.g. "devices.types.light") to a `data:` URI
 * suitable for `common.icon`. Unknown / unmapped types fall back to the
 * LIGHT icon (lights are by far the most common Govee device).
 *
 * @param govType Govee API type string (full prefix like "devices.types.light")
 * @returns Data-URI string ready to assign to `common.icon`
 */
export function iconForGoveeType(govType: string | undefined): string {
  switch (govType) {
    case GOVEE_DEVICE_TYPE.LIGHT:
      return LIGHT;
    case GOVEE_DEVICE_TYPE.THERMOMETER:
    case GOVEE_DEVICE_TYPE.SENSOR:
      return THERMOMETER;
    case GOVEE_DEVICE_TYPE.HEATER:
      return HEATER;
    case GOVEE_DEVICE_TYPE.HUMIDIFIER:
    case GOVEE_DEVICE_TYPE.DEHUMIDIFIER:
      return HUMIDIFIER;
    case GOVEE_DEVICE_TYPE.FAN:
      return FAN;
    case GOVEE_DEVICE_TYPE.AIR_PURIFIER:
      return AIR_PURIFIER;
    case GOVEE_DEVICE_TYPE.SOCKET:
      return SOCKET;
    case GOVEE_DEVICE_TYPE.KETTLE:
      return KETTLE;
    case GOVEE_DEVICE_TYPE.ICE_MAKER:
      return ICE_MAKER;
    case GOVEE_DEVICE_TYPE.AROMA_DIFFUSER:
      return AROMA;
    case GOVEE_DEVICE_TYPE.BUTTON:
      return BUTTON;
    default:
      return LIGHT;
  }
}

/**
 * Strip the "devices.types." prefix from a Govee type so it's a clean
 * label like "light", "thermometer", "heater" — used as the value of
 * `info.type` so scripts can filter without parsing the prefix.
 *
 * @param govType Full Govee type or undefined
 * @returns Short label (or "unknown" if the input is missing/empty)
 */
export function shortenGoveeType(govType: string | undefined): string {
  if (!govType || typeof govType !== "string") {
    return "unknown";
  }
  return govType.replace(/^devices\.types\./, "") || "unknown";
}

/** Icon for BaseGroup virtual devices */
export const GROUP_ICON = GROUP;
