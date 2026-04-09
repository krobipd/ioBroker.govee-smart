"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const capability_mapper_js_1 = require("./lib/capability-mapper.js");
const device_manager_js_1 = require("./lib/device-manager.js");
const govee_cloud_client_js_1 = require("./lib/govee-cloud-client.js");
const govee_lan_client_js_1 = require("./lib/govee-lan-client.js");
const govee_mqtt_client_js_1 = require("./lib/govee-mqtt-client.js");
const rate_limiter_js_1 = require("./lib/rate-limiter.js");
const state_manager_js_1 = require("./lib/state-manager.js");
class GoveeAdapter extends utils.Adapter {
    deviceManager = null;
    stateManager = null;
    lanClient = null;
    mqttClient = null;
    cloudClient = null;
    rateLimiter = null;
    cloudPollTimer = undefined;
    cloudWasConnected = false;
    readyLogged = false;
    /** @param options Adapter options */
    constructor(options = {}) {
        super({ ...options, name: "govee-smart" });
        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", (callback) => this.onUnload(callback));
    }
    /** Adapter started — initialize all channels */
    async onReady() {
        const config = this.config;
        // Ensure info.connection exists
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Connection status",
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.mqttConnected", {
            type: "state",
            common: {
                name: "MQTT connected",
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.cloudConnected", {
            type: "state",
            common: {
                name: "Cloud API connected",
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: false, ack: true });
        await this.setStateAsync("info.mqttConnected", { val: false, ack: true });
        await this.setStateAsync("info.cloudConnected", { val: false, ack: true });
        this.stateManager = new state_manager_js_1.StateManager(this);
        this.deviceManager = new device_manager_js_1.DeviceManager(this.log);
        this.deviceManager.setCallbacks((device, state) => this.onDeviceStateUpdate(device, state), (devices) => this.onDeviceListChanged(devices));
        // Update info.ip when LAN IP changes
        this.deviceManager.onLanIpChanged = (device, ip) => {
            const prefix = this.stateManager.devicePrefix(device);
            this.setStateAsync(`${prefix}.info.ip`, { val: ip, ack: true }).catch(() => { });
        };
        // Sync individual segment states after batch command
        this.deviceManager.onSegmentBatchUpdate = (device, batch) => {
            const prefix = this.stateManager.devicePrefix(device);
            for (const idx of batch.segments) {
                if (batch.color !== undefined) {
                    const hex = `#${batch.color.toString(16).padStart(6, "0")}`;
                    this.setStateAsync(`${prefix}.segments.${idx}.color`, {
                        val: hex,
                        ack: true,
                    }).catch(() => { });
                }
                if (batch.brightness !== undefined) {
                    this.setStateAsync(`${prefix}.segments.${idx}.brightness`, {
                        val: batch.brightness,
                        ack: true,
                    }).catch(() => { });
                }
            }
        };
        // Log startup hint — initialization may take a while with Cloud/MQTT
        if (config.apiKey || (config.goveeEmail && config.goveePassword)) {
            this.log.info("Starting Govee adapter — initializing channels, this may take a moment...");
        }
        // --- LAN (always active) ---
        this.lanClient = new govee_lan_client_js_1.GoveeLanClient(this.log, this);
        this.deviceManager.setLanClient(this.lanClient);
        this.lanClient.start((lanDevice) => {
            this.deviceManager.handleLanDiscovery(lanDevice);
            // Request status after discovery
            this.lanClient.requestStatus(lanDevice.ip);
        }, (sourceIp, status) => {
            this.deviceManager.handleLanStatus(sourceIp, status);
        }, 30_000, config.networkInterface || "");
        // --- Cloud (if API key provided) ---
        if (config.apiKey) {
            this.cloudClient = new govee_cloud_client_js_1.GoveeCloudClient(config.apiKey, this.log);
            this.deviceManager.setCloudClient(this.cloudClient);
            this.rateLimiter = new rate_limiter_js_1.RateLimiter(this.log, this);
            this.rateLimiter.start();
            this.deviceManager.setRateLimiter(this.rateLimiter);
            // Initial cloud load
            const cloudOk = await this.deviceManager.loadFromCloud();
            this.cloudWasConnected = cloudOk;
            this.setStateAsync("info.cloudConnected", {
                val: cloudOk,
                ack: true,
            }).catch(() => { });
            // Load current device states from Cloud
            if (cloudOk) {
                await this.loadCloudStates();
            }
            // Periodic cloud refresh
            const intervalMs = Math.max(30, config.pollInterval ?? 60) * 1000;
            this.cloudPollTimer = this.setInterval(() => {
                this.deviceManager.loadFromCloud()
                    .then((ok) => {
                    if (ok && !this.cloudWasConnected) {
                        this.log.info("Cloud API connection restored");
                    }
                    this.cloudWasConnected = ok;
                    this.setStateAsync("info.cloudConnected", {
                        val: ok,
                        ack: true,
                    }).catch(() => { });
                })
                    .catch(() => { });
            }, intervalMs);
        }
        // --- MQTT (if account credentials provided) ---
        if (config.goveeEmail && config.goveePassword) {
            this.mqttClient = new govee_mqtt_client_js_1.GoveeMqttClient(config.goveeEmail, config.goveePassword, this.log, this);
            this.deviceManager.setMqttClient(this.mqttClient);
            await this.mqttClient.connect((update) => this.deviceManager.handleMqttStatus(update), (connected) => {
                this.setStateAsync("info.mqttConnected", {
                    val: connected,
                    ack: true,
                }).catch(() => { });
                if (connected) {
                    this.log.debug("MQTT connected — real-time status active");
                    for (const dev of this.deviceManager.getDevices()) {
                        if (dev.mqttTopic) {
                            this.mqttClient.registerDeviceTopic(dev.deviceId, dev.mqttTopic);
                        }
                    }
                    // Log ready message now that MQTT is also connected
                    if (!this.readyLogged) {
                        this.readyLogged = true;
                        this.logDeviceSummary();
                    }
                }
                this.updateConnectionState();
            });
        }
        // Subscribe to all writable device and group states
        await this.subscribeStatesAsync("devices.*");
        await this.subscribeStatesAsync("groups.*");
        // Cleanup stale devices after initial discovery (30s delay for LAN scan)
        this.setTimeout(() => {
            if (this.stateManager && this.deviceManager) {
                this.stateManager
                    .cleanupDevices(this.deviceManager.getDevices())
                    .catch(() => { });
            }
        }, 30_000);
        this.updateConnectionState();
        // Log final ready message — wait for MQTT if configured, otherwise log now
        if (!this.mqttClient) {
            this.readyLogged = true;
            this.logDeviceSummary();
        }
        else {
            // Safety timeout: log ready even if MQTT takes too long
            this.setTimeout(() => {
                if (!this.readyLogged) {
                    this.readyLogged = true;
                    this.logDeviceSummary();
                }
            }, 15_000);
        }
    }
    /**
     * Adapter stopping — MUST be synchronous.
     *
     * @param callback Completion callback
     */
    onUnload(callback) {
        try {
            if (this.cloudPollTimer) {
                this.clearInterval(this.cloudPollTimer);
                this.cloudPollTimer = undefined;
            }
            this.lanClient?.stop();
            this.mqttClient?.disconnect();
            this.rateLimiter?.stop();
            void this.setState("info.connection", { val: false, ack: true });
        }
        catch {
            // ignore
        }
        callback();
    }
    /**
     * Handle state changes from user (write operations).
     *
     * @param id State ID
     * @param state New state value
     */
    async onStateChange(id, state) {
        if (!state || state.ack || !this.deviceManager || !this.stateManager) {
            return;
        }
        // Find which device this state belongs to
        const localId = id.replace(`${this.namespace}.`, "");
        if (!localId.startsWith("devices.") && !localId.startsWith("groups.")) {
            return;
        }
        const device = this.findDeviceForState(localId);
        if (!device) {
            return;
        }
        // Determine command from state suffix after device prefix
        const prefix = this.stateManager.devicePrefix(device);
        const stateSuffix = localId.slice(prefix.length + 1);
        const command = this.stateToCommand(stateSuffix);
        if (!command) {
            // Try generic capability routing via state object metadata
            const obj = await this.getObjectAsync(id);
            if (obj?.native?.capabilityType && obj?.native?.capabilityInstance) {
                try {
                    await this.deviceManager.sendCapabilityCommand(device, obj.native.capabilityType, obj.native.capabilityInstance, state.val);
                    await this.setStateAsync(id, { val: state.val, ack: true });
                }
                catch (err) {
                    this.log.warn(`Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            else {
                this.log.debug(`Unknown writable state: ${stateSuffix}`);
            }
            return;
        }
        try {
            // Music mode: combine all music states into one STRUCT command
            if (command === "music") {
                await this.sendMusicCommand(device, prefix, stateSuffix, state.val);
                await this.setStateAsync(id, { val: state.val, ack: true });
                return;
            }
            await this.deviceManager.sendCommand(device, command, state.val);
            // Optimistic ack
            await this.setStateAsync(id, { val: state.val, ack: true });
            // Reset scene dropdowns when switching to solid color/colorTemp
            if (command === "colorRgb" || command === "colorTemperature") {
                for (const sceneKey of ["light_scene", "diy_scene", "snapshot"]) {
                    const sceneId = `${this.namespace}.${prefix}.control.${sceneKey}`;
                    const sceneState = await this.getStateAsync(sceneId);
                    if (sceneState?.val && sceneState.val !== "0") {
                        await this.setStateAsync(sceneId, { val: "0", ack: true });
                    }
                }
            }
        }
        catch (err) {
            this.log.warn(`Command failed for ${device.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * Build and send a music_setting STRUCT command.
     * Reads sibling music state values and combines them into one API call.
     *
     * @param device Target device
     * @param prefix Device state prefix
     * @param changedSuffix Which music state was changed
     * @param newValue New value for the changed state
     */
    async sendMusicCommand(device, prefix, changedSuffix, newValue) {
        const base = `${this.namespace}.${prefix}.control`;
        // Read current sibling values
        const modeState = await this.getStateAsync(`${base}.music_mode`);
        const sensState = await this.getStateAsync(`${base}.music_sensitivity`);
        const autoState = await this.getStateAsync(`${base}.music_auto_color`);
        // Apply the changed value, use siblings for the rest
        const musicMode = changedSuffix === "control.music_mode"
            ? parseInt(String(newValue), 10)
            : parseInt(String(modeState?.val ?? 0), 10);
        const sensitivity = changedSuffix === "control.music_sensitivity"
            ? newValue
            : (sensState?.val ?? 100);
        const autoColor = changedSuffix === "control.music_auto_color"
            ? newValue
                ? 1
                : 0
            : autoState?.val
                ? 1
                : 0;
        if (!musicMode || musicMode === 0) {
            this.log.debug("Music mode not selected, skipping command");
            return;
        }
        const structValue = {
            musicMode,
            sensitivity,
            autoColor,
        };
        await this.deviceManager.sendCapabilityCommand(device, "devices.capabilities.music_setting", "musicMode", structValue);
    }
    /**
     * Called by device-manager when a device state changes
     *
     * @param device Updated device
     * @param state Changed state values
     */
    onDeviceStateUpdate(device, state) {
        if (this.stateManager) {
            this.stateManager.updateDeviceState(device, state).catch(() => { });
        }
        this.updateConnectionState();
    }
    /**
     * Called by device-manager when the device list changes
     *
     * @param devices Current list of all devices
     */
    onDeviceListChanged(devices) {
        if (!this.stateManager) {
            return;
        }
        for (const device of devices) {
            let stateDefs;
            if (device.lanIp) {
                // LAN-capable: use LAN defaults for basic states, add Cloud extras
                stateDefs = (0, capability_mapper_js_1.getDefaultLanStates)();
                if (device.capabilities.length > 0) {
                    const lanIds = new Set(stateDefs.map((d) => d.id));
                    const cloudDefs = (0, capability_mapper_js_1.mapCapabilities)(device.capabilities);
                    for (const cd of cloudDefs) {
                        if (!lanIds.has(cd.id)) {
                            stateDefs.push(cd);
                        }
                    }
                }
            }
            else {
                // Cloud-only: use Cloud capabilities
                stateDefs = (0, capability_mapper_js_1.mapCapabilities)(device.capabilities);
            }
            // Remove generic JSON states from capability mapper —
            // only add back as real dropdowns if we have actual scene/snapshot/diy data
            stateDefs = stateDefs.filter((d) => d.id !== "light_scene" && d.id !== "diy_scene" && d.id !== "snapshot");
            if (device.scenes.length > 0) {
                const sceneStates = { 0: "---" };
                device.scenes.forEach((s, i) => {
                    sceneStates[i + 1] = s.name;
                });
                stateDefs.push({
                    id: "light_scene",
                    name: "Light Scene",
                    type: "string",
                    role: "text",
                    write: true,
                    states: sceneStates,
                    def: "0",
                    capabilityType: "devices.capabilities.dynamic_scene",
                    capabilityInstance: "lightScene",
                });
            }
            if (device.diyScenes.length > 0) {
                const diyStates = { 0: "---" };
                device.diyScenes.forEach((s, i) => {
                    diyStates[i + 1] = s.name;
                });
                stateDefs.push({
                    id: "diy_scene",
                    name: "DIY Scene",
                    type: "string",
                    role: "text",
                    write: true,
                    states: diyStates,
                    def: "0",
                    capabilityType: "devices.capabilities.dynamic_scene",
                    capabilityInstance: "diyScene",
                });
            }
            if (device.snapshots.length > 0) {
                const snapStates = { 0: "---" };
                device.snapshots.forEach((s, i) => {
                    snapStates[i + 1] = s.name;
                });
                stateDefs.push({
                    id: "snapshot",
                    name: "Snapshot",
                    type: "string",
                    role: "text",
                    write: true,
                    states: snapStates,
                    def: "0",
                    capabilityType: "devices.capabilities.dynamic_scene",
                    capabilityInstance: "snapshot",
                });
            }
            this.stateManager.createDeviceStates(device, stateDefs).catch((e) => {
                this.log.error(`createDeviceStates failed for ${device.name}: ${e instanceof Error ? e.message : String(e)}`);
            });
        }
        this.updateConnectionState();
    }
    /** Update global info.connection */
    updateConnectionState() {
        const hasDevices = (this.deviceManager?.getDevices().length ?? 0) > 0;
        const anyOnline = this.deviceManager?.getDevices().some((d) => d.state.online) ?? false;
        const lanRunning = this.lanClient !== null;
        const connected = hasDevices ? anyOnline : lanRunning;
        this.setStateAsync("info.connection", { val: connected, ack: true }).catch(() => { });
    }
    /**
     * Log final ready message with device/group/channel summary.
     * Called once at the end of onReady after all channels are initialized.
     *
     */
    logDeviceSummary() {
        if (!this.deviceManager) {
            return;
        }
        const all = this.deviceManager.getDevices();
        const devices = all.filter((d) => d.sku !== "BaseGroup");
        const groups = all.filter((d) => d.sku === "BaseGroup");
        const parts = [];
        if (devices.length > 0) {
            parts.push(`${devices.length} device${devices.length > 1 ? "s" : ""}`);
        }
        if (groups.length > 0) {
            parts.push(`${groups.length} group${groups.length > 1 ? "s" : ""}`);
        }
        const channels = ["LAN"];
        if (this.cloudWasConnected) {
            channels.push("Cloud");
        }
        if (this.mqttClient?.connected) {
            channels.push("MQTT");
        }
        const deviceInfo = parts.length > 0 ? parts.join(", ") : "no devices found";
        this.log.info(`Govee adapter ready (${deviceInfo}, channels: ${channels.join("+")})`);
    }
    /**
     * Load current state for all Cloud devices and populate state values.
     * Called once after initial Cloud device list load.
     */
    async loadCloudStates() {
        if (!this.cloudClient || !this.deviceManager || !this.stateManager) {
            return;
        }
        const devices = this.deviceManager.getDevices();
        // LAN-first: never overwrite LAN states with Cloud values
        const lanStateIds = new Set((0, capability_mapper_js_1.getDefaultLanStates)().map((s) => s.id));
        let loaded = 0;
        for (const device of devices) {
            if (!device.channels.cloud || device.capabilities.length === 0) {
                continue;
            }
            try {
                const caps = await this.cloudClient.getDeviceState(device.sku, device.deviceId);
                const prefix = this.stateManager.devicePrefix(device);
                for (const cap of caps) {
                    const mapped = (0, capability_mapper_js_1.mapCloudStateValue)(cap);
                    if (!mapped) {
                        continue;
                    }
                    // Skip LAN-covered states for LAN-capable devices
                    if (device.lanIp && lanStateIds.has(mapped.stateId)) {
                        continue;
                    }
                    const obj = await this.getObjectAsync(`${prefix}.control.${mapped.stateId}`);
                    if (obj) {
                        await this.setStateAsync(`${prefix}.control.${mapped.stateId}`, {
                            val: mapped.value,
                            ack: true,
                        });
                    }
                }
                loaded++;
            }
            catch {
                this.log.debug(`Could not load Cloud state for ${device.name} (${device.sku})`);
            }
        }
        if (loaded > 0) {
            this.log.debug(`Cloud states loaded for ${loaded} devices`);
        }
    }
    /**
     * Find device for a state ID
     *
     * @param localId Local state ID without namespace prefix
     */
    findDeviceForState(localId) {
        if (!this.deviceManager || !this.stateManager) {
            return undefined;
        }
        for (const device of this.deviceManager.getDevices()) {
            const prefix = this.stateManager.devicePrefix(device);
            if (localId.startsWith(`${prefix}.`)) {
                return device;
            }
        }
        return undefined;
    }
    /**
     * Map state suffix to command name
     *
     * @param suffix State ID suffix (e.g. "power", "brightness")
     */
    stateToCommand(suffix) {
        if (suffix === "control.power") {
            return "power";
        }
        if (suffix === "control.brightness") {
            return "brightness";
        }
        if (suffix === "control.colorRgb") {
            return "colorRgb";
        }
        if (suffix === "control.colorTemperature") {
            return "colorTemperature";
        }
        if (suffix === "control.scene") {
            return "scene";
        }
        if (suffix === "control.light_scene") {
            return "lightScene";
        }
        if (suffix === "control.diy_scene") {
            return "diyScene";
        }
        if (suffix === "control.snapshot") {
            return "snapshot";
        }
        // Music mode states — routed via buildMusicCommand
        if (suffix === "control.music_mode" ||
            suffix === "control.music_sensitivity" ||
            suffix === "control.music_auto_color") {
            return "music";
        }
        // Segment commands — encode segment index in command name
        const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
        if (segColorMatch) {
            return `segmentColor:${segColorMatch[1]}`;
        }
        const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
        if (segBrightMatch) {
            return `segmentBrightness:${segBrightMatch[1]}`;
        }
        // Batch segment command
        if (suffix === "segments.command") {
            return "segmentBatch";
        }
        return null;
    }
}
if (require.main !== module) {
    module.exports = (options) => new GoveeAdapter(options);
}
else {
    (() => new GoveeAdapter())();
}
//# sourceMappingURL=main.js.map