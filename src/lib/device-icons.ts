/**
 * Inline SVG icons (data: URIs) for device types — used as `common.icon`
 * on device objects so the Object-Browser shows a glanceable type marker
 * next to each device.
 *
 * Sources: Material Design Icons (Apache 2.0). Kept inline so the build
 * pipeline doesn't need separate icon files.
 *
 * Every root carries `fill="currentColor"`: the Admin inlines a data:image/svg
 * icon into the object-tree row and does NOT recolour it, so the fill must
 * inherit the row's text colour — without it the icons were black on both dark
 * themes (measured at admin 7.9.13 and 8.0.12, 2026-09-12; fixed in 2.36.1).
 * Only `path`/`circle` may draw: the row's cell CSS zeroes the width of
 * rect/image/use/nested svg inside inlined markup (fleet rule, CLAUDE_PATTERNS
 * "Geräte-Piktogramme im Objektbaum"; device-icons.test.ts pins both).
 */

import { GOVEE_DEVICE_TYPE } from "./govee-constants";

const LIGHT =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNOSAyMWMwIC41NS40NSAxIDEgMWg0Yy41NSAwIDEtLjQ1IDEtMXYtMUg5djF6bTMtMTlDOC4xNCAyIDUgNS4xNCA1IDljMCAyLjM4IDEuMTkgNC40NyAzIDUuNzRWMTdjMCAuNTUuNDUgMSAxIDFoNmMuNTUgMCAxLS40NSAxLTF2LTIuMjZjMS44MS0xLjI3IDMtMy4zNiAzLTUuNzQgMC0zLjg2LTMuMTQtNy03LTd6Ii8+PC9zdmc+";

const THERMOMETER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTUgMTNWNWMwLTEuNjYtMS4zNC0zLTMtM1M5IDMuMzQgOSA1djhjLTEuMjEuOTEtMiAyLjM1LTIgNCAwIDIuNzYgMi4yNCA1IDUgNXM1LTIuMjQgNS01YzAtMS42NS0uNzktMy4wOS0yLTR6bS00LThjMC0uNTUuNDUtMSAxLTFzMSAuNDUgMSAxaC0ydjFoMnYyaC0ydjFoMnYyaC0ydjEuMWMxLjQ0LjQ3IDIuNSAxLjggMi41IDMuNCAwIDIuMDktMS43MSAzLjc1LTMuNzUgMy43NVM3IDE5LjE5IDcgMTcuMWMwLTEuNiAxLjA2LTIuOTMgMi41LTMuNFY1eiIvPjwvc3ZnPg==";

const HEATER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTcuNjYgMTEuMmMtLjIzLS4zMy0uNDgtLjY2LS43OC0uOThjLS41Ny0uNjYtMS4yMS0xLjMyLTEuODYtMS45N2MtMS4zOC0xLjM1LTIuODYtMi43My0zLjk3LTQuNTRjLS40OC0uNzgtLjgtMS41OS0xLjAyLTIuNDJjLS41OC44Ni0xLjA5IDEuNy0xLjU5IDIuNTVjLS44NyAxLjQ5LTEuNjcgMi45Ni0yLjIzIDQuNTJjLS43NyAyLjE2LTEuMDEgNC4zOC0uNTIgNi41NGMuNSAyLjE2IDEuNjcgNC4yNSAzLjM3IDUuNzFjLjg2Ljc0IDEuODkgMS4zMyAzIDEuNzZjMS4xLjQzIDIuMjguNjcgMy40Ny43MWMxLjE5LjA0IDIuNC0uMTIgMy41NC0uNTJjMS4xNC0uNCAyLjIxLTEuMDIgMy4xNy0xLjg1YzEuODktMS42MyAzLjI2LTMuNzggMy41Ny02LjE3Yy4zMS0yLjM5LS41NC00Ljg0LTIuMTUtNi41N3oiLz48L3N2Zz4=";

const HUMIDIFIER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTIgMi41UzE5IDcgMTkgMTNjMCAzLjg3LTMuMTMgNy03IDdzLTctMy4xMy03LTdjMC02IDctMTAuNSA3LTEwLjV6Ii8+PC9zdmc+";

const FAN =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTIgMTFjMS4xIDAgMi0uOSAyLTJjMC0xLjEtLjktMi0yLTJjLTEuMSAwLTIgLjktMiAyYzAgMS4xLjkgMiAyIDJ6bTkuNTYtMS4zYzAgLjExLjAzLjIuMDMuMzFjMCAyLjEzLTEuMjcgNC4zMy0zLjI0IDUuNjdjLjc2LTEuMzMgMS4yMS0yLjg3IDEuMjEtNC40N2MwLS41NC0uMDUtMS4wOC0uMTUtMS42MWMxLjItLjQxIDIuMTYtLjc5IDIuMTUuMXpNNi40NCA5LjdjMS4yLS45MSAyLjE2LTEuMjggMi4xNi4xYy0uMS41My0uMTUgMS4wNy0uMTUgMS42MWMwIDEuNi40NSAzLjE0IDEuMjEgNC40N2MtMS45Ny0xLjM0LTMuMjQtMy41My0zLjI0LTUuNjdjMC0uMS4wMy0uMi4wMy0uMzFtLS43IDQuMmMuMTYuMDkuMjguMTkuNDIuMjdjLTEuOTcgMS4zNC0zLjI0IDMuNTMtMy4yNCA1LjY3YzAgLjEuMDMuMi4wMy4zMWMwIC4xMS4wMy4yLjAzLjMxYzAgMS45NiAxLjQ4IDQuMTMgMy4xNSA1LjU5Yy0uMzMtMS4xNi0uNTItMi4zLS41Mi0zLjQ1YzAtMi4xIC40NC00LjE2IDEuMDUtNi4wOGMtLjMxLS4yMS0uNjEtLjQ0LS45Mi0uNjd6Ii8+PC9zdmc+";

const AIR_PURIFIER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMHMxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnptLjUgMTZjMCAuMjgtLjIyLjUtLjUuNXMtLjUtLjIyLS41LS41di0yYzAtLjI4LjIyLS41LjUtLjVzLjUuMjIuNS41djJ6bTAtNGMwIC4yOC0uMjIuNS0uNS41cy0uNS0uMjItLjUtLjV2LTEyYzAtLjI4LjIyLS41LjUtLjVzLjUuMjIuNS41djEyeiIvPjwvc3ZnPg==";

const SOCKET =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTYgN2gtMS45bC0uODUtMS43YS41LjUgMCAwIDAtLjQ1LS4zaC01LjZhLjUuNSAwIDAgMC0uNDUuM0w2LjkgN0g1Yy0xLjExIDAtMiAuODktMiAydjEyYzAgMS4xMS44OSAyIDIgMmgxMWMxLjExIDAgMi0uODkgMi0yVjljMC0xLjExLS44OS0yLTItMnpNMTAgOGgydjVoLTJ6TTggOGgydjVIOHoiLz48L3N2Zz4=";

const KETTLE =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTkgMTRWOWwtNC00aC00YTMgMyAwIDAgMC0zIDN2NmwtMiAydjRoMTZ2LTRsLTMtMnoiLz48L3N2Zz4=";

const ICE_MAKER = SOCKET; // placeholder until a dedicated icon is needed
const AROMA = HUMIDIFIER; // close enough — both diffuse moisture/scent

/** Battery button / remote — a press-ring. */
const BUTTON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTIgMmExMCAxMCAwIDEgMCAwIDIwIDEwIDEwIDAgMCAwIDAtMjB6bTAgMmE4IDggMCAxIDEgMCAxNiA4IDggMCAwIDEgMC0xNnoiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI0Ii8+PC9zdmc+";

const GROUP =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTYgMTFjMS42NiAwIDIuOTktMS4zNCAyLjk5LTNTMTcuNjYgNSAxNiA1Yy0xLjY2IDAtMyAxLjM0LTMgM3MxLjM0IDMgMyAzem0tOCAwYzEuNjYgMCAyLjk5LTEuMzQgMi45OS0zUzkuNjYgNSA4IDVDNi4zNCA1IDUgNi4zNCA1IDhzMS4zNCAzIDMgM3ptMCAyYy0yLjMzIDAtNyAxLjE3LTcgMy41VjE5aDE0di0yLjVjMC0yLjMzLTQuNjctMy41LTctMy41em04IDBjLS4yOSAwLS42Mi4wMi0uOTcuMDUgMS4xNi44NCAxLjk3IDEuOTcgMS45NyAzLjQ1VjE5aDZ2LTIuNWMwLTIuMzMtNC42Ny0zLjUtNy0zLjV6Ii8+PC9zdmc+";

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
