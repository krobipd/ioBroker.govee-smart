import { describe, it, expect, vi } from "vitest";

import { DeviceListError, makeDeviceListApi, segmentCapable, type DeviceEntry } from "./useDeviceList";

function socketReturning(value: unknown): { socket: { sendTo: typeof sendTo }; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const sendTo = (instance: string, command: string, data: unknown): Promise<unknown> => {
    calls.push([instance, command, data]);
    return Promise.resolve(value);
  };
  return { calls, socket: { sendTo } };
}

const entry = (over: Partial<DeviceEntry> = {}): DeviceEntry => ({
  value: "H61BE:AA:BB",
  label: "Strip (H61BE)",
  model: "H61BE",
  online: true,
  segments: 15,
  ...over,
});

describe("makeDeviceListApi", () => {
  it("asks the adapter once, on the diagnostics command", async () => {
    const { socket, calls } = socketReturning({ devices: [entry()] });
    const devices = await makeDeviceListApi(socket, "govee-smart.0").listDevices();
    expect(calls).toEqual([["govee-smart.0", "diagnostics", { action: "list" }]]);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ online: true, segments: 15 });
  });

  it("an answer that is not a list THROWS — it must never look like an empty account", async () => {
    // This is the defect that cost an hour on 2026-09-03. Both hooks used to
    // turn a failed round-trip into `[]`, so a dead message box rendered as
    // "No devices yet" on an adapter running ten of them — and the card's own
    // error path could never fire, because nothing ever threw.
    await expect(makeDeviceListApi(socketReturning(undefined).socket, "govee-smart.0").listDevices()).rejects.toThrow(
      DeviceListError,
    );
    await expect(
      makeDeviceListApi(socketReturning({ devices: "nope" }).socket, "govee-smart.0").listDevices(),
    ).rejects.toThrow(DeviceListError);
  });

  it("a rejected round-trip becomes the same error type", async () => {
    // The card has one failure path to handle, whether the socket refused or
    // the adapter answered nonsense.
    const socket = { sendTo: vi.fn(() => Promise.reject(new Error("no connection"))) };
    await expect(makeDeviceListApi(socket, "govee-smart.0").listDevices()).rejects.toThrow(DeviceListError);
    await expect(makeDeviceListApi(socket, "govee-smart.0").listDevices()).rejects.toThrow("no connection");
  });

  it("an empty list is a RESULT, not a failure", async () => {
    // An account really can have no devices yet. That must still render the
    // friendly "nothing here yet" message, not an error.
    await expect(makeDeviceListApi(socketReturning({ devices: [] }).socket, "govee-smart.0").listDevices()).resolves
      .toEqual([]);
  });
});

describe("segmentCapable", () => {
  it("offers only reachable devices that have segments", () => {
    // The filter the backend used to apply before handing the wizard its own
    // list. A device with no segments cannot be measured, and an unreachable
    // one would just flash at nothing.
    const devices = [
      entry({ value: "a", online: true, segments: 10 }),
      entry({ value: "b", online: true, segments: 0 }),
      entry({ value: "c", online: false, segments: 5 }),
    ];
    expect(segmentCapable(devices).map(d => d.value)).toEqual(["a"]);
  });

  it("leaves the full list untouched — the diagnostics half needs every device", () => {
    const devices = [entry({ value: "a", online: false, segments: 0 })];
    expect(segmentCapable(devices)).toEqual([]);
    expect(devices).toHaveLength(1);
  });
});
