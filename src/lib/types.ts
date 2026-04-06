/** Adapter configuration from ioBroker native config */
export interface AdapterConfig {
  /** Govee Cloud API key (optional — enables scenes, segments, device names) */
  apiKey: string;
  /** Govee account email (optional — enables MQTT real-time status) */
  goveeEmail: string;
  /** Govee account password (optional — enables MQTT real-time status) */
  goveePassword: string;
  /** Cloud device list refresh interval in seconds */
  pollInterval: number;
}

// --- Cloud API v2 Types ---

/** Device from Cloud API GET /router/api/v1/user/devices */
export interface CloudDevice {
  /** Product model (e.g. H6160) */
  sku: string;
  /** Unique device identifier */
  device: string;
  /** User-assigned device name */
  deviceName: string;
  /** Device category (e.g. "light") */
  type: string;
  /** Device capabilities from Cloud API */
  capabilities: CloudCapability[];
}

/** A single capability from the Cloud API */
export interface CloudCapability {
  /** Capability type (e.g. "devices.capabilities.on_off") */
  type: string;
  /** Capability instance (e.g. "powerSwitch", "brightness") */
  instance: string;
  /** Parameter definition for this capability */
  parameters: CapabilityParameters;
}

/** Parameter definition for a capability */
export interface CapabilityParameters {
  /** Value data type */
  dataType: "ENUM" | "INTEGER" | "STRUCT";
  /** Available options for ENUM type */
  options?: CapabilityOption[];
  /** Value range for INTEGER type */
  range?: { min: number; max: number; precision: number };
  /** Unit of measurement */
  unit?: string;
  /** Field definitions for STRUCT type */
  fields?: CapabilityField[];
}

/** ENUM option */
export interface CapabilityOption {
  /** Display name of the option */
  name: string;
  /** Option value (number, string, or complex object) */
  value: number | string | Record<string, unknown>;
}

/** STRUCT field definition */
export interface CapabilityField {
  /** Field name identifier */
  fieldName: string;
  /** Value data type */
  dataType: "ENUM" | "INTEGER" | "STRUCT";
  /** Available options for ENUM fields */
  options?: CapabilityOption[];
  /** Value range for INTEGER fields */
  range?: { min: number; max: number; precision: number };
  /** Whether this field is required */
  required?: boolean;
}

/** Cloud API device list response */
export interface CloudDeviceListResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** List of devices */
  data: CloudDevice[];
}

/** Cloud API device state response */
export interface CloudDeviceStateResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** Device state data */
  data: {
    /** Product model */
    sku: string;
    /** Device identifier */
    device: string;
    /** Current capability states */
    capabilities: CloudStateCapability[];
  };
}

/** A capability value from state response */
export interface CloudStateCapability {
  /** Capability type */
  type: string;
  /** Capability instance */
  instance: string;
  /** Current state value */
  state: { value: unknown };
}

/** Cloud API scenes response — payload contains capabilities with options */
export interface CloudScenesResponse {
  /** Response status code */
  code: number;
  /** Response message */
  message: string;
  /** Payload with capabilities (scenes endpoint format) */
  payload?: {
    /** Scene capabilities with options */
    capabilities: CloudCapability[];
  };
}

/** A scene/snapshot option from the Cloud API */
export interface CloudScene {
  /** Display name */
  name: string;
  /** Activation value (passed directly to control endpoint) */
  value: Record<string, unknown>;
}

// --- AWS IoT MQTT Types ---

/** Login response from app2.govee.com */
export interface GoveeLoginResponse {
  /** API status code (200 = success) */
  status?: number;
  /** API status message */
  message?: string;
  /** Client authentication data (missing on auth failure) */
  client?: {
    /** Bearer token for API calls */
    token: string;
    /** Account identifier (numeric) */
    accountId: number | string;
    /** MQTT topic for status updates */
    topic: string;
  };
}

/** IoT key response from app2.govee.com */
export interface GoveeIotKeyResponse {
  /** IoT credential data */
  data?: {
    /** AWS IoT endpoint hostname */
    endpoint: string;
    /** Base64-encoded PKCS12 certificate */
    p12: string;
    /** Password for the PKCS12 certificate */
    p12Pass: string;
  };
}

/** MQTT status update received on account topic */
export interface MqttStatusUpdate {
  /** Product model */
  sku: string;
  /** Device identifier */
  device: string;
  /** Device state values */
  state?: {
    /** Power state (1 = on, 0 = off) */
    onOff?: number;
    /** Brightness percentage 0-100 */
    brightness?: number;
    /** RGB color values */
    color?: { r: number; g: number; b: number };
    /** Color temperature in Kelvin */
    colorTemInKelvin?: number;
  };
  /** Operation data */
  op?: {
    /** Command strings */
    command?: string[];
  };
}

/** MQTT command message */
export interface MqttCommand {
  /** Message payload */
  msg: {
    /** Command name */
    cmd: string;
    /** Command data */
    data: Record<string, unknown>;
    /** Command version */
    cmdVersion: number;
    /** Transaction ID */
    transaction: string;
    /** Message type */
    type: number;
  };
}

// --- LAN API Types ---

/** LAN discovery response */
export interface LanDevice {
  /** Device IP address */
  ip: string;
  /** Device identifier */
  device: string;
  /** Product model */
  sku: string;
  /** BLE hardware version */
  bleVersionHard: string;
  /** BLE software version */
  bleVersionSoft: string;
  /** Wi-Fi hardware version */
  wifiVersionHard: string;
  /** Wi-Fi software version */
  wifiVersionSoft: string;
}

/** LAN status response */
export interface LanStatus {
  /** Power state (1 = on, 0 = off) */
  onOff: number;
  /** Brightness percentage 0-100 */
  brightness: number;
  /** RGB color values */
  color: { r: number; g: number; b: number };
  /** Color temperature in Kelvin */
  colorTemInKelvin: number;
}

/** LAN command message wrapper */
export interface LanMessage {
  /** Message payload */
  msg: {
    /** Command name */
    cmd: string;
    /** Command data */
    data: Record<string, unknown>;
  };
}

// --- Internal Device Model ---

/** Unified device representation used by device-manager */
export interface GoveeDevice {
  /** Product model (e.g. H6160) */
  sku: string;
  /** Unique device ID (8-byte hex) */
  deviceId: string;
  /** Display name (from Cloud or SKU fallback) */
  name: string;
  /** Device type from Cloud (e.g. "light") */
  type: string;
  /** LAN IP address if discovered */
  lanIp?: string;
  /** MQTT device topic for publishing commands */
  mqttTopic?: string;
  /** Capabilities from Cloud API */
  capabilities: CloudCapability[];
  /** Available light scenes (from Cloud scenes endpoint) */
  scenes: CloudScene[];
  /** Available snapshots (from Cloud scenes endpoint) */
  snapshots: CloudScene[];
  /** Last known state */
  state: DeviceState;
  /** Which channels are available */
  channels: {
    /** LAN UDP reachable */
    lan: boolean;
    /** MQTT connected */
    mqtt: boolean;
    /** Cloud API available */
    cloud: boolean;
  };
}

/** Current device state */
export interface DeviceState {
  /** Whether device is reachable */
  online: boolean;
  /** Power on/off */
  power?: boolean;
  /** Brightness 0-100 */
  brightness?: number;
  /** Color as "#RRGGBB" hex string */
  colorRgb?: string;
  /** Color temperature in Kelvin */
  colorTemperature?: number;
  /** Active scene name */
  scene?: string;
  /** Additional dynamic state values */
  [key: string]: unknown;
}

/** Timer/callback interfaces for helper classes */
export interface TimerAdapter {
  /** Create a repeating interval timer */
  setInterval(callback: () => void, ms: number): ioBroker.Interval | undefined;
  /** Clear a repeating interval timer */
  clearInterval(timer: ioBroker.Interval): void;
  /** Create a one-shot timeout timer */
  setTimeout(callback: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Clear a one-shot timeout timer */
  clearTimeout(timer: ioBroker.Timeout): void;
}
