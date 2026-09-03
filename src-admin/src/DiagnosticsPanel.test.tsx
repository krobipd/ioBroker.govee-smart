import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";

import enJson from "./i18n/en.json";

// Mock the sendTo wrapper so the tests drive the card through controlled
// answers (no socket). vi.hoisted keeps the mock stable across the hoisted
// vi.mock factory.
const mockApi = vi.hoisted(() => ({
  listDevices: vi.fn(),
  exportReport: vi.fn(),
}));

vi.mock("./useDiagnosticsApi", async importOriginal => {
  const actual = await importOriginal<typeof import("./useDiagnosticsApi")>();
  return { ...actual, makeDiagnosticsApi: () => mockApi };
});

import { DiagnosticsPanel } from "./DiagnosticsPanel";

const DEVICE = { value: "H61BE:AA:BB", label: "Strip (H61BE)", model: "H61BE" };
const OTHER = { value: "H6160:CC:DD", label: "Lamp (H6160)", model: "H6160" };

/** Records what the browser was asked to download. */
function captureDownloads(): { names: string[]; contents: string[] } {
  const names: string[] = [];
  const contents: string[] = [];
  const blobs = new Map<string, string>();
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => {
      const url = `blob:${blobs.size}`;
      // jsdom's Blob has no sync reader — record what was handed in instead.
      blobs.set(url, (b as unknown as { __text?: string }).__text ?? "");
      return url;
    },
    revokeObjectURL: () => {},
  });
  const origBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class {
      __text: string;
      constructor(parts: string[]) {
        this.__text = parts.join("");
        contents.push(this.__text);
      }
    } as unknown as typeof origBlob,
  );
  // Patch the prototype through vi.spyOn so vitest restores it afterwards —
  // a raw assignment would leak into every later test in the file.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement): void {
    names.push(this.download);
  });
  return { names, contents };
}

beforeEach(() => {
  I18n.extendTranslations(enJson, "en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockApi.listDevices.mockResolvedValue([DEVICE]);
  mockApi.exportReport.mockReset();
});

describe("DiagnosticsPanel", () => {
  it("pre-selects the only device so the card is one click", async () => {
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("diag-export")).toBeTruthy());
    expect(screen.getByTestId("diag-export").hasAttribute("disabled")).toBe(false);
  });

  it("does not pre-select when there is a choice to make", async () => {
    mockApi.listDevices.mockResolvedValue([DEVICE, OTHER]);
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("diag-export")).toBeTruthy());
    expect(screen.getByTestId("diag-export").hasAttribute("disabled")).toBe(true);
  });

  it("hands the browser the file under the name the adapter stored it as", async () => {
    // The name carries model, device short id, version and timestamp — that is
    // what lets a stranger tell two attached reports apart.
    const dl = captureDownloads();
    const fileName = "govee-smart_H61BE_1d6f_v2.29.0_2026-09-03_101500.json";
    mockApi.exportReport.mockResolvedValue({ fileName, content: '{"readMe":{}}' });
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("diag-export")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() => expect(dl.names).toEqual([fileName]));
    expect(dl.contents).toEqual(['{"readMe":{}}']);
  });

  it("shows the adapter's reason instead of a download when the export fails", async () => {
    mockApi.exportReport.mockResolvedValue({ error: "Export failed or was throttled — try again in a moment" });
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("diag-export")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diag-export"));
    await waitFor(() => expect(screen.getByText(/throttled/)).toBeTruthy());
  });

  it("says so when there is nothing to report on yet", async () => {
    mockApi.listDevices.mockResolvedValue([]);
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("diag-no-devices")).toBeTruthy());
  });

  it("explains that the report is pseudonymised", async () => {
    // Without that line a reader takes `address-1` in the file for a bug — and
    // a reporter has no way to know what is safe to attach.
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByText(/pseudonymised/i)).toBeTruthy());
  });

  it("survives a socket that cannot answer", async () => {
    mockApi.listDevices.mockRejectedValue(new Error("no connection"));
    render(
      <DiagnosticsPanel
        socket={{}}
        namespace="govee-smart.0"
      />,
    );
    await waitFor(() => expect(screen.getByText(/device list/i)).toBeTruthy());
  });
});
