import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";

import enJson from "./i18n/en.json";

const mockList = vi.hoisted(() => ({ listDevices: vi.fn() }));

vi.mock("./useDeviceList", async importOriginal => ({
  ...(await importOriginal<typeof import("./useDeviceList")>()),
  makeDeviceListApi: () => mockList,
}));

vi.mock("./useWizardApi", () => ({
  makeWizardApi: () => ({
    start: vi.fn(),
    yes: vi.fn(),
    no: vi.fn(),
    abort: vi.fn(),
    apply: vi.fn(),
  }),
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
