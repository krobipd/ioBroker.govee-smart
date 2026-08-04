import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";

import enJson from "./i18n/en.json";

// Mock the sendTo wrapper so the tests drive the state machine through
// controlled responses (no socket). vi.hoisted keeps the mock stable across
// the hoisted vi.mock factory.
const mockApi = vi.hoisted(() => ({
  listDevices: vi.fn(),
  start: vi.fn(),
  yes: vi.fn(),
  no: vi.fn(),
  done: vi.fn(),
  abort: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("./useWizardApi", () => ({
  makeWizardApi: () => mockApi,
}));

import { SegmentWizard } from "./SegmentWizard";

const DEVICE = "H6160:AABB";

beforeEach(() => {
  vi.clearAllMocks();
  I18n.extendTranslations(enJson, "en");
  I18n.setLanguage("en");
  mockApi.listDevices.mockResolvedValue([{ value: DEVICE, label: "Strip Living" }]);
  mockApi.abort.mockResolvedValue({ aborted: true, done: true });
});

function renderWizard(): void {
  render(<SegmentWizard socket={{} as never} namespace="govee-smart.0" />);
}

describe("SegmentWizard", () => {
  it("happy path: select → measure → review → apply, and never calls done", async () => {
    mockApi.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    mockApi.yes.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 1, confirmed: [0] },
    });
    mockApi.apply.mockResolvedValue({ applied: true, segmentCount: 1, list: "", hasGaps: false });

    renderWizard();

    // Devices load and the first is pre-selected → start uses it.
    fireEvent.click(await screen.findByTestId("wiz-start"));
    await waitFor(() => expect(mockApi.start).toHaveBeenCalledWith(DEVICE));

    // Measure screen: confirm segment 0 is lit.
    fireEvent.click(await screen.findByTestId("wiz-lit"));
    await waitFor(() => expect(mockApi.yes).toHaveBeenCalledTimes(1));

    // "Finished" moves to review LOCALLY — no backend done call.
    fireEvent.click(screen.getByTestId("wiz-finish"));
    fireEvent.click(await screen.findByTestId("wiz-apply"));

    await waitFor(() => expect(mockApi.apply).toHaveBeenCalledWith(DEVICE, [0]));
    expect(mockApi.done).not.toHaveBeenCalled();
    await screen.findByTestId("wiz-success");
  });

  it("review lets you toggle a cell before applying", async () => {
    mockApi.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    // Answer three: 0 lit, 1 lit, 2 lit → currentIndex 3, confirmed [0,1,2]
    mockApi.yes
      .mockResolvedValueOnce({ snapshot: { phase: "measuring", total: 55, currentIndex: 1, confirmed: [0] } })
      .mockResolvedValueOnce({ snapshot: { phase: "measuring", total: 55, currentIndex: 2, confirmed: [0, 1] } })
      .mockResolvedValueOnce({ snapshot: { phase: "measuring", total: 55, currentIndex: 3, confirmed: [0, 1, 2] } });
    mockApi.apply.mockResolvedValue({ applied: true, segmentCount: 2, list: "", hasGaps: false });

    renderWizard();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    fireEvent.click(await screen.findByTestId("wiz-lit"));
    await waitFor(() => expect(mockApi.yes).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("wiz-lit"));
    await waitFor(() => expect(mockApi.yes).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("wiz-lit"));
    await waitFor(() => expect(mockApi.yes).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByTestId("wiz-finish"));
    // Review shows 3 cells (measured); toggle cell 2 off → apply [0,1]
    fireEvent.click(await screen.findByTestId("seg-cell-2"));
    fireEvent.click(screen.getByTestId("wiz-apply"));
    await waitFor(() => expect(mockApi.apply).toHaveBeenCalledWith(DEVICE, [0, 1]));
  });

  it("routes to success (not review) when a step auto-finalizes at the protocol limit", async () => {
    mockApi.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    // Backend auto-finished (HARD_MAX): session already applied + closed.
    mockApi.yes.mockResolvedValue({ done: true, segmentCount: 56, hasGaps: false });

    renderWizard();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    fireEvent.click(await screen.findByTestId("wiz-lit"));

    await screen.findByTestId("wiz-success");
    expect(mockApi.apply).not.toHaveBeenCalled();
    expect(screen.queryByTestId("wiz-finish")).toBeNull();
  });

  it("abort from measure resets to the select screen", async () => {
    mockApi.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    renderWizard();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    fireEvent.click(await screen.findByTestId("wiz-cancel"));
    await waitFor(() => expect(mockApi.abort).toHaveBeenCalled());
    await screen.findByTestId("wiz-start");
  });

  it("shows an error and returns to select when a step errors", async () => {
    mockApi.start.mockResolvedValue({ error: "already active" });
    renderWizard();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    await waitFor(() => expect(screen.getByTestId("wiz-error")).toHaveTextContent(/already active/i));
    await screen.findByTestId("wiz-start");
  });

  it("Finished is disabled until at least one segment is answered", async () => {
    mockApi.start.mockResolvedValue({
      snapshot: { phase: "measuring", total: 55, currentIndex: 0, confirmed: [] },
      active: true,
    });
    renderWizard();
    fireEvent.click(await screen.findByTestId("wiz-start"));
    expect(await screen.findByTestId("wiz-finish")).toBeDisabled();
  });

  it("shows a hint when no segment-capable devices exist", async () => {
    mockApi.listDevices.mockResolvedValue([]);
    renderWizard();
    expect(await screen.findByTestId("wiz-no-devices")).toBeInTheDocument();
  });
});
