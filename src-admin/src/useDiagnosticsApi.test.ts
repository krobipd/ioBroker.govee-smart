import { describe, it, expect, vi } from "vitest";
import { isReport, makeDiagnosticsApi, type DiagnosticsSocket } from "./useDiagnosticsApi";

function socketReturning(value: unknown): { socket: DiagnosticsSocket; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    socket: {
      sendTo: (instance: string, command: string, data: unknown) => {
        calls.push([instance, command, data]);
        return Promise.resolve(value);
      },
    },
  };
}

describe("makeDiagnosticsApi", () => {
  it("asks the adapter for the device list on the diagnostics command", async () => {
    const { socket, calls } = socketReturning({
      devices: [{ value: "H61BE:AA:BB", label: "Strip (H61BE)", model: "H61BE" }],
    });
    const api = makeDiagnosticsApi(socket, "govee-smart.0");
    const devices = await api.listDevices();
    expect(calls[0]).toEqual(["govee-smart.0", "diagnostics", { action: "list" }]);
    expect(devices).toHaveLength(1);
  });

  it("survives an answer without a device list", async () => {
    // A stopped instance answers nothing useful; the card must show an empty
    // list rather than throw inside a render.
    const api = makeDiagnosticsApi(socketReturning(undefined).socket, "govee-smart.0");
    await expect(api.listDevices()).resolves.toEqual([]);
    const api2 = makeDiagnosticsApi(socketReturning({ devices: "nope" }).socket, "govee-smart.0");
    await expect(api2.listDevices()).resolves.toEqual([]);
  });

  it("passes the selected device through to the export action", async () => {
    const { socket, calls } = socketReturning({ fileName: "f.json", content: "{}" });
    const api = makeDiagnosticsApi(socket, "govee-smart.1");
    await api.exportReport("H61BE:AA:BB");
    expect(calls[0]).toEqual(["govee-smart.1", "diagnostics", { action: "export", device: "H61BE:AA:BB" }]);
  });
});

describe("isReport", () => {
  it("tells a finished report apart from an error answer", () => {
    // The card branches on this: one path downloads a file, the other shows a
    // message. Getting it wrong would offer an empty download.
    expect(isReport({ fileName: "f.json", content: "{}" })).toBe(true);
    expect(isReport({ error: "Unknown device" })).toBe(false);
  });
});

describe("the download the card offers", () => {
  it("names the file exactly as the adapter stored it", async () => {
    // The name carries model, device short id, adapter version and timestamp —
    // that is what lets a stranger tell two attached reports apart. Renaming it
    // in the browser would throw that away.
    const name = "govee-smart_H61BE_1d6f_v2.29.0_2026-09-03_101500.json";
    const api = makeDiagnosticsApi(socketReturning({ fileName: name, content: "{}" }).socket, "govee-smart.0");
    const res = await api.exportReport("H61BE:AA:BB");
    expect(isReport(res) && res.fileName).toBe(name);
  });
});

describe("socket rejection", () => {
  it("propagates so the card can show its own message", async () => {
    const socket: DiagnosticsSocket = { sendTo: vi.fn(() => Promise.reject(new Error("no connection"))) };
    const api = makeDiagnosticsApi(socket, "govee-smart.0");
    await expect(api.listDevices()).rejects.toThrow("no connection");
  });
});
