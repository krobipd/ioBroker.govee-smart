import { httpsRequest } from "../http-client";
import { errMessage } from "../types";
import { GOVEE_APP_VERSION, getAppVersion, setAppVersion } from "../govee-constants";

/**
 * Keep the impersonated Govee-app version current — self-healing, no datapoint.
 *
 * Govee's undocumented app2.govee.com endpoints reject very stale app versions.
 * Instead of comparing a hardcoded constant against the live version and asking
 * a human to bump + release, the adapter looks the live iOS version up (iTunes)
 * and just uses it in the request headers ({@link setAppVersion}). A failed or
 * malformed lookup is silently ignored; the bundled {@link GOVEE_APP_VERSION}
 * stays as the fallback.
 *
 * @param adapter Adapter surface
 * @param adapter.log The adapter log
 */
export async function refreshLiveAppVersion(adapter: { readonly log: ioBroker.Logger }): Promise<void> {
  try {
    const result = await httpsRequest<{ resultCount?: number; results?: Array<{ version?: string }> }>({
      method: "GET",
      url: "https://itunes.apple.com/lookup?bundleId=com.ihoment.GoVeeSensor",
      headers: { "User-Agent": "ioBroker.govee-smart" },
      timeout: 10_000,
    });
    const liveVersion = result.value?.results?.[0]?.version;
    // Defence in depth, deliberately kept without its own test: setAppVersion()
    // validates the same thing itself (typeof + /^\d+(\.\d+)+$/), so removing
    // this guard changes nothing but one debug line. Measured as an equivalent
    // mutant in the 2026-08-22 test audit.
    if (typeof liveVersion !== "string" || liveVersion.length === 0) {
      return;
    }
    setAppVersion(liveVersion);
    adapter.log.debug(`Govee app version: using ${getAppVersion()} (bundled fallback ${GOVEE_APP_VERSION})`);
  } catch (e) {
    adapter.log.debug(`App version lookup failed, keeping ${getAppVersion()}: ${errMessage(e)}`);
  }
}
