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
exports.GoveeCloudClient = exports.CloudApiError = void 0;
const https = __importStar(require("node:https"));
const BASE_URL = "https://openapi.api.govee.com";
/** Error with HTTP status code */
class CloudApiError extends Error {
    /** HTTP status code */
    statusCode;
    /**
     * @param message Error message
     * @param statusCode HTTP status code
     */
    constructor(message, statusCode) {
        super(message);
        this.name = "CloudApiError";
        this.statusCode = statusCode;
    }
}
exports.CloudApiError = CloudApiError;
/**
 * Govee Cloud API v2 client.
 * Used for device list, capabilities, scenes, segments, and as control fallback.
 */
class GoveeCloudClient {
    apiKey;
    log;
    /**
     * @param apiKey Govee API key
     * @param log ioBroker logger
     */
    constructor(apiKey, log) {
        this.apiKey = apiKey;
        this.log = log;
    }
    /** Fetch all devices with their capabilities */
    async getDevices() {
        const resp = await this.request("GET", "/router/api/v1/user/devices");
        return resp.data ?? [];
    }
    /**
     * Fetch current state of a device
     *
     * @param sku Product model
     * @param device Device identifier
     */
    async getDeviceState(sku, device) {
        const resp = await this.request("POST", "/router/api/v1/device/state", {
            requestId: `state_${Date.now()}`,
            payload: { sku, device },
        });
        return resp.data?.capabilities ?? [];
    }
    /**
     * Send a control command to a device
     *
     * @param sku Product model
     * @param device Device ID
     * @param capabilityType Full capability type string
     * @param instance Capability instance name
     * @param value Value to set
     */
    async controlDevice(sku, device, capabilityType, instance, value) {
        await this.request("POST", "/router/api/v1/device/control", {
            requestId: `ctrl_${Date.now()}`,
            payload: {
                sku,
                device,
                capability: {
                    type: capabilityType,
                    instance,
                    value,
                },
            },
        });
    }
    /**
     * Fetch dynamic scenes and snapshots for a device.
     * The scenes endpoint returns capabilities with options.
     *
     * @param sku Product model
     * @param device Device identifier
     */
    async getScenes(sku, device) {
        const resp = await this.request("POST", "/router/api/v1/device/scenes", {
            requestId: "scenes",
            payload: { sku, device },
        });
        const lightScenes = [];
        const diyScenes = [];
        const snapshots = [];
        for (const cap of resp.payload?.capabilities ?? []) {
            this.log.debug(`Scenes endpoint: instance=${cap.instance}, options=${cap.parameters.options?.length ?? 0}`);
            const opts = cap.parameters.options ?? [];
            const mapped = opts
                .filter((o) => typeof o.name === "string" && typeof o.value === "object")
                .map((o) => ({
                name: o.name,
                value: o.value,
            }));
            if (cap.instance === "lightScene") {
                lightScenes.push(...mapped);
            }
            else if (cap.instance === "diyScene") {
                diyScenes.push(...mapped);
            }
            else if (cap.instance === "snapshot") {
                snapshots.push(...mapped);
            }
        }
        return { lightScenes, diyScenes, snapshots };
    }
    /**
     * Fetch DIY scenes for a device from the dedicated diy-scenes endpoint.
     *
     * @param sku Product model
     * @param device Device identifier
     */
    async getDiyScenes(sku, device) {
        const resp = await this.request("POST", "/router/api/v1/device/diy-scenes", {
            requestId: "diy-scenes",
            payload: { sku, device },
        });
        const scenes = [];
        for (const cap of resp.payload?.capabilities ?? []) {
            this.log.debug(`DIY-Scenes endpoint: instance=${cap.instance}, options=${cap.parameters.options?.length ?? 0}`);
            const opts = cap.parameters.options ?? [];
            scenes.push(...opts
                .filter((o) => typeof o.name === "string" && typeof o.value === "object")
                .map((o) => ({ name: o.name, value: o.value })));
        }
        return scenes;
    }
    /** Check if the API key is valid */
    async checkConnection() {
        try {
            const devices = await this.getDevices();
            return {
                success: true,
                message: `Connected — ${devices.length} device(s) found`,
                deviceCount: devices.length,
            };
        }
        catch (err) {
            return {
                success: false,
                message: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /**
     * Make an HTTPS request to the Govee Cloud API
     *
     * @param method HTTP method (GET, POST)
     * @param path API endpoint path
     * @param body Optional request body
     */
    request(method, path, body) {
        this.log.debug(`Cloud API: ${method} ${path}`);
        return new Promise((resolve, reject) => {
            const url = new URL(path, BASE_URL);
            const postData = body ? JSON.stringify(body) : undefined;
            const options = {
                method,
                hostname: url.hostname,
                path: url.pathname,
                headers: {
                    "Content-Type": "application/json",
                    "Govee-API-Key": this.apiKey,
                    ...(postData
                        ? { "Content-Length": Buffer.byteLength(postData) }
                        : {}),
                },
                timeout: 15_000,
            };
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString();
                    const statusCode = res.statusCode ?? 0;
                    if (statusCode === 429) {
                        const retryAfter = res.headers["retry-after"];
                        reject(new CloudApiError(`Rate limited — retry after ${retryAfter ?? "unknown"}s`, 429));
                        return;
                    }
                    if (statusCode < 200 || statusCode >= 300) {
                        reject(new CloudApiError(`HTTP ${statusCode}: ${raw.slice(0, 200)}`, statusCode));
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
                        reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
                    }
                });
            });
            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy(new Error("Request timed out"));
            });
            if (postData) {
                req.write(postData);
            }
            req.end();
        });
    }
}
exports.GoveeCloudClient = GoveeCloudClient;
//# sourceMappingURL=govee-cloud-client.js.map