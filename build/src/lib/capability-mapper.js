"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapCapabilities = mapCapabilities;
exports.getDefaultLanStates = getDefaultLanStates;
exports.mapCloudStateValue = mapCloudStateValue;
/**
 * Maps Govee Cloud API capabilities to ioBroker state definitions.
 * Pure function — no side effects, easily testable.
 *
 * @param capabilities Device capabilities from Cloud API
 */
function mapCapabilities(capabilities) {
    const states = [];
    for (const cap of capabilities) {
        const mapped = mapSingleCapability(cap);
        if (mapped) {
            states.push(...mapped);
        }
    }
    return states;
}
/**
 * Default state definitions for LAN-only devices (no Cloud capabilities).
 * All LAN-capable Govee lights support: power, brightness, color, color temperature.
 */
function getDefaultLanStates() {
    return [
        {
            id: "power",
            name: "Power",
            type: "boolean",
            role: "switch",
            write: true,
            def: false,
            capabilityType: "lan",
            capabilityInstance: "powerSwitch",
        },
        {
            id: "brightness",
            name: "Brightness",
            type: "number",
            role: "level.brightness",
            write: true,
            min: 0,
            max: 100,
            unit: "%",
            def: 0,
            capabilityType: "lan",
            capabilityInstance: "brightness",
        },
        {
            id: "colorRgb",
            name: "Color RGB",
            type: "string",
            role: "level.color.rgb",
            write: true,
            def: "#000000",
            capabilityType: "lan",
            capabilityInstance: "colorRgb",
        },
        {
            id: "colorTemperature",
            name: "Color Temperature",
            type: "number",
            role: "level.color.temperature",
            write: true,
            min: 2000,
            max: 9000,
            unit: "K",
            def: 2000,
            capabilityType: "lan",
            capabilityInstance: "colorTemperatureK",
        },
    ];
}
/**
 * Map a single capability to state definition(s)
 *
 * @param cap Cloud capability to map
 */
function mapSingleCapability(cap) {
    const shortType = cap.type.replace("devices.capabilities.", "");
    switch (shortType) {
        case "on_off":
            return [
                {
                    id: "power",
                    name: "Power",
                    type: "boolean",
                    role: "switch",
                    write: true,
                    def: false,
                    capabilityType: cap.type,
                    capabilityInstance: cap.instance,
                },
            ];
        case "range":
            return mapRange(cap);
        case "color_setting":
            return mapColorSetting(cap);
        case "toggle":
            return [
                {
                    id: sanitizeId(cap.instance),
                    name: humanize(cap.instance),
                    type: "boolean",
                    role: "switch",
                    write: true,
                    def: false,
                    capabilityType: cap.type,
                    capabilityInstance: cap.instance,
                },
            ];
        case "mode":
            return mapMode(cap);
        case "property":
            return mapProperty(cap);
        case "online":
            // Handled separately — not a regular state
            return null;
        case "segment_color_setting":
            // Segments are handled specially by state-manager
            return [
                {
                    id: `_segment_${sanitizeId(cap.instance)}`,
                    name: humanize(cap.instance),
                    type: "string",
                    role: "json",
                    write: true,
                    capabilityType: cap.type,
                    capabilityInstance: cap.instance,
                },
            ];
        case "dynamic_scene":
        case "work_mode":
        case "temperature_setting":
            // Complex types — expose as JSON for now
            return [
                {
                    id: sanitizeId(cap.instance),
                    name: humanize(cap.instance),
                    type: "string",
                    role: "json",
                    write: true,
                    def: "",
                    capabilityType: cap.type,
                    capabilityInstance: cap.instance,
                },
            ];
        case "music_setting":
            return mapMusicSetting(cap);
        default:
            return null;
    }
}
/**
 * Map range capability (brightness, humidity, etc.)
 *
 * @param cap Cloud range capability
 */
function mapRange(cap) {
    const range = cap.parameters.range;
    const isBrightness = cap.instance.toLowerCase().includes("brightness");
    return [
        {
            id: sanitizeId(cap.instance),
            name: humanize(cap.instance),
            type: "number",
            role: isBrightness ? "level.brightness" : "level",
            write: true,
            min: range?.min ?? 0,
            max: range?.max ?? 100,
            unit: normalizeUnit(cap.parameters.unit),
            def: range?.min ?? 0,
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        },
    ];
}
/**
 * Map color_setting capability (RGB or color temperature)
 *
 * @param cap Cloud color setting capability
 */
function mapColorSetting(cap) {
    if (cap.instance === "colorRgb") {
        return [
            {
                id: "colorRgb",
                name: "Color RGB",
                type: "string",
                role: "level.color.rgb",
                write: true,
                def: "#000000",
                capabilityType: cap.type,
                capabilityInstance: cap.instance,
            },
        ];
    }
    if (cap.instance === "colorTemperatureK" ||
        cap.instance.includes("colorTem")) {
        const range = cap.parameters.range;
        return [
            {
                id: "colorTemperature",
                name: "Color Temperature",
                type: "number",
                role: "level.color.temperature",
                write: true,
                min: range?.min ?? 2000,
                max: range?.max ?? 9000,
                unit: "K",
                def: range?.min ?? 2000,
                capabilityType: cap.type,
                capabilityInstance: cap.instance,
            },
        ];
    }
    return [];
}
/**
 * Map mode capability (scenes with ENUM options)
 *
 * @param cap Cloud mode capability
 */
function mapMode(cap) {
    if (cap.instance !== "presetScene" || !cap.parameters.options) {
        return [];
    }
    const states = {};
    for (const opt of cap.parameters.options) {
        const val = typeof opt.value === "object"
            ? JSON.stringify(opt.value)
            : String(opt.value);
        states[val] = opt.name;
    }
    return [
        {
            id: "scene",
            name: "Scene",
            type: "string",
            role: "text",
            write: true,
            states,
            def: "",
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        },
    ];
}
/**
 * Map property capability (read-only sensors)
 *
 * @param cap Cloud property capability
 */
function mapProperty(cap) {
    const instance = cap.instance.toLowerCase();
    let role = "value";
    let unit;
    if (instance.includes("temperature")) {
        role = "value.temperature";
        unit = "°C";
    }
    else if (instance.includes("humidity")) {
        role = "value.humidity";
        unit = "%";
    }
    else if (instance.includes("battery")) {
        role = "value.battery";
        unit = "%";
    }
    else if (instance.includes("co2") || instance.includes("carbondioxide")) {
        role = "value.co2";
        unit = "ppm";
    }
    return [
        {
            id: sanitizeId(cap.instance),
            name: humanize(cap.instance),
            type: "number",
            role,
            write: false,
            unit: normalizeUnit(cap.parameters.unit) ?? unit,
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        },
    ];
}
/**
 * Map music_setting capability to user-friendly states.
 * Parses STRUCT fields into: mode dropdown, sensitivity slider, auto-color toggle.
 *
 * @param cap Cloud music_setting capability
 */
function mapMusicSetting(cap) {
    const fields = cap.parameters.fields;
    if (!fields || fields.length === 0) {
        // No field details from API — can't create usable states
        return [];
    }
    const states = [];
    // Mode dropdown — only if API provides actual mode options
    const modeField = fields.find((f) => f.fieldName === "musicMode");
    if (modeField?.options && modeField.options.length > 0) {
        const modeStates = { 0: "---" };
        for (const opt of modeField.options) {
            modeStates[typeof opt.value === "object"
                ? JSON.stringify(opt.value)
                : String(opt.value)] = opt.name;
        }
        states.push({
            id: "music_mode",
            name: "Music Mode",
            type: "string",
            role: "text",
            write: true,
            states: modeStates,
            def: "0",
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        });
    }
    // Sensitivity slider
    const sensField = fields.find((f) => f.fieldName === "sensitivity");
    if (sensField?.range) {
        states.push({
            id: "music_sensitivity",
            name: "Music Sensitivity",
            type: "number",
            role: "level",
            write: true,
            min: sensField.range.min,
            max: sensField.range.max,
            unit: "%",
            def: sensField.range.max,
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        });
    }
    // Auto color toggle
    const autoColorField = fields.find((f) => f.fieldName === "autoColor");
    if (autoColorField) {
        states.push({
            id: "music_auto_color",
            name: "Music Auto Color",
            type: "boolean",
            role: "switch",
            write: true,
            def: true,
            capabilityType: cap.type,
            capabilityInstance: cap.instance,
        });
    }
    return states;
}
/** Known Govee API unit strings → ioBroker units */
const UNIT_MAP = {
    "unit.percent": "%",
    "unit.kelvin": "K",
    "unit.celsius": "°C",
    "unit.fahrenheit": "°F",
};
/**
 * Normalize Govee API unit string to ioBroker standard
 *
 * @param unit Raw unit string from API
 */
function normalizeUnit(unit) {
    if (!unit) {
        return undefined;
    }
    return UNIT_MAP[unit] ?? unit;
}
/**
 * Sanitize a string for use as ioBroker state ID
 *
 * @param str Input string to sanitize
 */
function sanitizeId(str) {
    return str
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .toLowerCase();
}
/**
 * Convert camelCase to human-readable name
 *
 * @param str camelCase input string
 */
function humanize(str) {
    return str
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
}
/**
 * Map a Cloud device state capability to a state ID + converted value.
 * Uses the same ID logic as mapCapabilities so IDs always match.
 *
 * @param cap Cloud state capability with current value
 */
function mapCloudStateValue(cap) {
    const shortType = cap.type.replace("devices.capabilities.", "");
    const raw = cap.state?.value;
    if (raw === undefined || raw === null) {
        return null;
    }
    switch (shortType) {
        case "on_off":
            return { stateId: "power", value: raw === 1 };
        case "range":
            return { stateId: sanitizeId(cap.instance), value: raw };
        case "color_setting":
            if (cap.instance === "colorRgb") {
                const num = typeof raw === "number" ? raw : 0;
                const r = (num >> 16) & 0xff;
                const g = (num >> 8) & 0xff;
                const b = num & 0xff;
                return {
                    stateId: "colorRgb",
                    value: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
                };
            }
            if (cap.instance.includes("colorTem")) {
                return { stateId: "colorTemperature", value: raw };
            }
            return null;
        case "toggle":
            return { stateId: sanitizeId(cap.instance), value: raw === 1 };
        case "mode":
            if (cap.instance === "presetScene") {
                return {
                    stateId: "scene",
                    value: typeof raw === "object" || typeof raw === "function"
                        ? JSON.stringify(raw)
                        : String(raw),
                };
            }
            return null;
        case "dynamic_scene":
        case "work_mode":
        case "temperature_setting":
            return {
                stateId: sanitizeId(cap.instance),
                value: typeof raw === "object" || typeof raw === "function"
                    ? JSON.stringify(raw)
                    : String(raw),
            };
        case "music_setting":
            // Extract mode value from STRUCT state
            if (typeof raw === "object" && raw !== null) {
                const struct = raw;
                const mode = struct.musicMode;
                return {
                    stateId: "music_mode",
                    value: typeof mode === "number" ? String(mode) : "0",
                };
            }
            return null;
        case "property":
            return { stateId: sanitizeId(cap.instance), value: raw };
        default:
            return null;
    }
}
//# sourceMappingURL=capability-mapper.js.map