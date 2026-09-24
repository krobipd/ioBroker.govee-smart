import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";

import enJson from "./i18n/en.json";

const mockList = vi.hoisted(() => ({ listDevices: vi.fn() }));

vi.mock("./useDeviceList", async importOriginal => ({
  ...(await importOriginal<typeof import("./useDeviceList")>()),
  makeDeviceListApi: () => mockList,
}));

const mockWizard = vi.hoisted(() => ({
  start: vi.fn(),
  yes: vi.fn(),
  no: vi.fn(),
  abort: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("./useWizardApi", () => ({
  makeWizardApi: () => mockWizard,
}));

vi.mock("./useDiagnosticsApi", async importOriginal => ({
  ...(await importOriginal<typeof import("./useDiagnosticsApi")>()),
  makeDiagnosticsApi: () => ({ exportReport: vi.fn() }),
}));

import { ExpertPanel } from "./ExpertPanel";

const STRIP = { value: "H6160:AABB", label: "Strip Living", model: "H6160", online: true, segments: 10 };
const SENSOR = { value: "H5179:CCDD", label: "Thermometer", model: "H5179", online: true, segments: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  I18n.extendTranslations(enJson, "en");
  I18n.setLanguage("en");
  mockList.listDevices.mockResolvedValue([STRIP, SENSOR]);
});

function renderPanel(): void {
  render(
    <ExpertPanel
      socket={{}}
      namespace="govee-smart.0"
    />,
  );
}

describe("ExpertPanel", () => {
  it("starts on the segment wizard and shows both tools as buttons", async () => {
    renderPanel();
    expect(screen.getByTestId("expert-tool-wizard")).toBeTruthy();
    expect(screen.getByTestId("expert-tool-diagnostics")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("wiz-start")).toBeTruthy());
    expect(screen.queryByTestId("diag-export")).toBeNull();
  });

  it("switching mounts the other tool and unmounts the first", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("wiz-start")).toBeTruthy());

    fireEvent.click(screen.getByTestId("expert-tool-diagnostics"));
    await waitFor(() => expect(screen.getByTestId("diag-export")).toBeTruthy());
    expect(screen.queryByTestId("wiz-start")).toBeNull();
  });

  it("switching away from a running measurement aborts it (audit M13)", async () => {
    mockWizard.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    mockWizard.abort.mockResolvedValue({ aborted: true });
    renderPanel();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    await screen.findByTestId("wiz-finish");

    fireEvent.click(screen.getByTestId("expert-tool-diagnostics"));
    await waitFor(() => expect(mockWizard.abort).toHaveBeenCalledTimes(1));
  });

  it("re-reads the device list on every switch — reachability is live state", async () => {
    // Deliberately NOT cached across the switch. `online` decides what the
    // wizard offers, and a list kept from four minutes ago would offer a device
    // that has since dropped off.
    renderPanel();
    await waitFor(() => expect(mockList.listDevices).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("expert-tool-diagnostics"));
    await waitFor(() => expect(mockList.listDevices).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId("expert-tool-wizard"));
    await waitFor(() => expect(mockList.listDevices).toHaveBeenCalledTimes(3));
  });

  it("the two tools see the same list through different filters", async () => {
    // One command, two views: the wizard can only measure a reachable device
    // with segments, while a report is wanted for ANY device — most of all a
    // misbehaving one.
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("wiz-device-select")).toBeTruthy());
    expect(screen.getByTestId("wiz-device-select").textContent).toContain("Strip Living");
    expect(screen.getByTestId("wiz-device-select").textContent).not.toContain("Thermometer");

    fireEvent.click(screen.getByTestId("expert-tool-diagnostics"));
    await waitFor(() => expect(screen.getByTestId("diag-device-select")).toBeTruthy());
    // MUI renders the options into a popup, so open it to see the offer.
    fireEvent.mouseDown(screen.getByTestId("diag-device-select").querySelector("[role=combobox]")!);
    const offered = (await screen.findAllByRole("option")).map(o => o.textContent);
    expect(offered.join(" ")).toContain("Thermometer");
    expect(offered.join(" ")).toContain("Strip Living");
  });
});

describe("the tab memory", () => {
  // The admin remembers the last tab per adapter in localStorage and opens
  // the settings on it. Entering the Expert tab is the moment that memory
  // gets written; the panel forgets it right after, so the next open lands
  // on Configuration — the tabs themselves stay as they are.
  afterEach(() => {
    window.localStorage.clear();
  });

  it("forgets the adapter's remembered tab when the Expert tab is entered", () => {
    window.localStorage.setItem("App.govee-smart", "_expert");
    renderPanel();
    expect(window.localStorage.getItem("App.govee-smart")).toBeNull();
  });

  it("leaves other adapters and foreign values alone", () => {
    window.localStorage.setItem("App.govee-smart", "_expert");
    window.localStorage.setItem("App.hm-rpc", "_expert");
    window.localStorage.setItem("Other.govee-smart", "_main");
    window.localStorage.setItem("something.govee-smart", "not-a-tab");
    renderPanel();
    expect(window.localStorage.getItem("App.hm-rpc")).toBe("_expert");
    expect(window.localStorage.getItem("Other.govee-smart")).toBeNull();
    expect(window.localStorage.getItem("something.govee-smart")).toBe("not-a-tab");
  });

  it("forgets the tab in the admin's server-synced storage, which cannot be enumerated", () => {
    // With "store GUI settings on the server" the admin replaces the storage by
    // a plain object with getItem/setItem/removeItem only — no length, no key().
    // Measured on the live admin 8.0.12 after 2.37.0: the enumeration never ran,
    // the entry stayed on the server and every open still landed on Expert.
    const data: Record<string, string> = { "App.govee-smart": "_expert", "App.hm-rpc": "_expert" };
    const synced = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      removeItem: vi.fn((k: string) => {
        delete data[k];
      }),
    };
    (window as Window & { _localStorage?: unknown })._localStorage = synced;
    try {
      const { unmount } = render(
        <ExpertPanel
          socket={{}}
          namespace="govee-smart.0"
        />,
      );
      expect(synced.removeItem).toHaveBeenCalledWith("App.govee-smart");
      expect(data["App.govee-smart"]).toBeUndefined();
      expect(data["App.hm-rpc"]).toBe("_expert");
      // The admin may write the entry again after the mount (its own tab-switch
      // write) — leaving the settings removes it once more.
      synced.setItem("App.govee-smart", "_expert");
      unmount();
      expect(data["App.govee-smart"]).toBeUndefined();
    } finally {
      delete (window as Window & { _localStorage?: unknown })._localStorage;
    }
  });

  it("survives a blocked storage", () => {
    window.localStorage.setItem("App.govee-smart", "_expert");
    const spy = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      expect(() => renderPanel()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the loading state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("explains a long wait instead of spinning silently", async () => {
    // A wheel alone cannot be told from a stall. After a few seconds the card
    // says what the wait depends on — which is exactly the question the user
    // is asking by then.
    vi.useFakeTimers();
    mockList.listDevices.mockReturnValue(new Promise(() => {}));
    renderPanel();

    expect(screen.getByText(/loading devices/i)).toBeTruthy();
    expect(screen.queryByTestId("list-slow-hint")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId("list-slow-hint")).toBeTruthy();
  });

  it("a list that arrives in time is never talked over by the slow hint", async () => {
    vi.useFakeTimers();
    renderPanel();
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByTestId("list-slow-hint")).toBeNull();
  });
});
