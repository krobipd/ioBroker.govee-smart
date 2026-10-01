import { vi } from "vitest";

// refreshLiveAppVersion calls the module-level httpsRequest (no DI) — mock it.
vi.mock("../http-client", () => ({ httpsRequest: vi.fn() }));

import { refreshLiveAppVersion } from "./app-version";
import { httpsRequest } from "../http-client";
import { GOVEE_APP_VERSION, getAppVersion, setAppVersion } from "../govee-constants";

const mockHttp = vi.mocked(httpsRequest);

function makeRig(_opts: Record<string, never>): {
  adapter: { log: ioBroker.Logger };
  logs: Record<string, string[]>;
  stateWrites: Array<{ id: string }>;
} {
  const logs: Record<string, string[]> = { debug: [], info: [], warn: [], error: [] };
  const log = {
    debug: (m: string) => logs.debug.push(m),
    info: (m: string) => logs.info.push(m),
    warn: (m: string) => logs.warn.push(m),
    error: (m: string) => logs.error.push(m),
    silly: () => {},
    level: "debug",
  } as unknown as ioBroker.Logger;
  // No datapoint exists for the version — the list stays empty by construction.
  return { adapter: { log }, logs, stateWrites: [] };
}

describe("refreshLiveAppVersion", () => {
  // NOTE: no beforeEach(mockReset) here — vitest 4's mockReset drops the
  // handled-marker of stored rejected mock results, re-reporting an already
  // CAUGHT rejection as unhandled at test end. Each test installs its own
  // implementation, which is isolation enough. We DO reset the module-level app
  // version so an adopted value doesn't leak between tests.
  beforeEach(() => setAppVersion(GOVEE_APP_VERSION));

  function itunesVersion(version: string): never {
    return { value: { resultCount: 1, results: [{ version }] }, statusCode: 200 } as never;
  }

  it("adopts the live app version for the request headers (no datapoint, no warning)", async () => {
    mockHttp.mockResolvedValue(itunesVersion("9.9.9"));
    const rig = makeRig({});
    await refreshLiveAppVersion(rig.adapter);
    expect(getAppVersion()).toBe("9.9.9");
    expect(rig.logs.warn).toHaveLength(0);
    expect(rig.stateWrites.find(w => w.id === "info.appVersionDrift")).toBeUndefined();
  });

  it("keeps the bundled fallback on a malformed store response", async () => {
    mockHttp.mockResolvedValue({ value: { results: [] }, statusCode: 200 });
    const rig = makeRig({});
    await refreshLiveAppVersion(rig.adapter);
    expect(getAppVersion()).toBe(GOVEE_APP_VERSION);
  });

  it("ignores a non-numeric version string (regex guard never breaks the headers)", async () => {
    mockHttp.mockResolvedValue(itunesVersion("garbage"));
    const rig = makeRig({});
    await refreshLiveAppVersion(rig.adapter);
    expect(getAppVersion()).toBe(GOVEE_APP_VERSION);
  });

  it("keeps the current version + logs debug on a network failure (never alarms)", async () => {
    mockHttp.mockImplementation(() => {
      return Promise.reject(new Error("ENOTFOUND itunes.apple.com"));
    });
    const rig = makeRig({});
    await refreshLiveAppVersion(rig.adapter);
    expect(rig.logs.warn).toHaveLength(0);
    expect(getAppVersion()).toBe(GOVEE_APP_VERSION);
    expect(rig.logs.debug.some(m => m.includes("App version lookup failed"))).toBe(true);
  });
});
