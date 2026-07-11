import { describe, it, expect } from "vitest";

import { makeWizardApi, type WizardSocket } from "./useWizardApi";

function recordingSocket(response: unknown = { ok: true }): {
  socket: WizardSocket;
  calls: { ns: string; cmd: string; data: unknown }[];
} {
  const calls: { ns: string; cmd: string; data: unknown }[] = [];
  const socket: WizardSocket = {
    sendTo: (ns, cmd, data) => {
      calls.push({ ns, cmd, data });
      return Promise.resolve(response);
    },
  };
  return { socket, calls };
}

describe("makeWizardApi", () => {
  it("yes() sends the segmentWizard action and returns the response", async () => {
    const { socket, calls } = recordingSocket({
      snapshot: { phase: "measuring", confirmed: [0], currentIndex: 1, total: 5 },
    });
    const api = makeWizardApi(socket, "govee-smart.0");
    const res = await api.yes();
    expect(calls[0]).toEqual({ ns: "govee-smart.0", cmd: "segmentWizard", data: { action: "yes", device: "" } });
    expect(res.snapshot?.confirmed).toEqual([0]);
  });

  it("start(device) remembers the device for the following steps", async () => {
    const { socket, calls } = recordingSocket();
    const api = makeWizardApi(socket, "govee-smart.0");
    await api.start("H6160:AABB");
    await api.no();
    expect(calls[0].data).toEqual({ action: "start", device: "H6160:AABB" });
    expect(calls[1].data).toEqual({ action: "no", device: "H6160:AABB" });
  });

  it("done() and abort() carry the current device", async () => {
    const { socket, calls } = recordingSocket();
    const api = makeWizardApi(socket, "govee-smart.0");
    await api.start("H61:1");
    await api.done();
    await api.abort();
    expect(calls[1].data).toEqual({ action: "done", device: "H61:1" });
    expect(calls[2].data).toEqual({ action: "abort", device: "H61:1" });
  });

  it("apply(device, indices) sends the review-corrected map", async () => {
    const { socket, calls } = recordingSocket({ applied: true });
    const api = makeWizardApi(socket, "govee-smart.0");
    const res = await api.apply("H6160:AABB", [0, 1, 2, 4]);
    expect(calls[0]).toEqual({
      ns: "govee-smart.0",
      cmd: "segmentWizard",
      data: { action: "apply", device: "H6160:AABB", indices: [0, 1, 2, 4] },
    });
    expect(res.applied).toBe(true);
  });

  it("listDevices() calls getSegmentDevices and returns the array", async () => {
    const list = [{ value: "H61:1", label: "Strip 1" }];
    const { socket, calls } = recordingSocket(list);
    const api = makeWizardApi(socket, "govee-smart.0");
    const res = await api.listDevices();
    expect(calls[0]).toEqual({ ns: "govee-smart.0", cmd: "getSegmentDevices", data: {} });
    expect(res).toEqual(list);
  });

  it("listDevices() returns [] when the response is not an array", async () => {
    const { socket } = recordingSocket({ error: "boom" });
    const api = makeWizardApi(socket, "govee-smart.0");
    expect(await api.listDevices()).toEqual([]);
  });
});
