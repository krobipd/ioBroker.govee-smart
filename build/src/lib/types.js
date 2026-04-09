"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDeviceId = normalizeDeviceId;
exports.classifyError = classifyError;
/**
 * Normalize device ID — remove colons, lowercase
 *
 * @param id Raw device identifier
 */
function normalizeDeviceId(id) {
    return id.replace(/:/g, "").toLowerCase();
}
/**
 * Classify an error into a category for dedup logging.
 * Only the category is used as key — not context or full message.
 *
 * @param err Error to classify
 */
function classifyError(err) {
    if (err instanceof Error) {
        const code = err.code;
        if (code === "ECONNREFUSED" ||
            code === "EHOSTUNREACH" ||
            code === "ENOTFOUND" ||
            code === "ENETUNREACH" ||
            code === "ECONNRESET" ||
            code === "EAI_AGAIN") {
            return "NETWORK";
        }
        if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
            return "TIMEOUT";
        }
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("ENETUNREACH") ||
        msg.includes("ECONNRESET")) {
        return "NETWORK";
    }
    if (msg.includes("Timeout")) {
        return "TIMEOUT";
    }
    if (msg.includes("429") ||
        msg.includes("Rate limit") ||
        msg.includes("Rate limited")) {
        return "RATE_LIMIT";
    }
    if (msg.includes("401") ||
        msg.includes("403") ||
        msg.includes("Login failed") ||
        msg.includes("auth")) {
        return "AUTH";
    }
    return "UNKNOWN";
}
//# sourceMappingURL=types.js.map