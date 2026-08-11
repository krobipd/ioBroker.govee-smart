import { describe, it, expect } from "vitest";
import { makeConnectionApi, type AuthResponse, type ConnectionSocket } from "./useConnectionApi";

function recordingSocket(response: AuthResponse): {
  socket: ConnectionSocket;
  calls: Array<{ instance: string; command: string; data: unknown }>;
} {
  const calls: Array<{ instance: string; command: string; data: unknown }> = [];
  const socket: ConnectionSocket = {
    sendTo: (instance, command, data) => {
      calls.push({ instance, command, data });
      return Promise.resolve(response);
    },
  };
  return { socket, calls };
}

describe("makeConnectionApi", () => {
  it("testLogin sends mqttAuth {action:test} with the live credentials + code", async () => {
    const { socket, calls } = recordingSocket({ result: "Login successful", status: "ok" });
    const api = makeConnectionApi(socket, "govee-smart.0");
    const res = await api.testLogin({ email: "a@b.com", password: "pw", code: "123456" });
    expect(res).toEqual({ result: "Login successful", status: "ok" });
    expect(calls).toEqual([
      {
        instance: "govee-smart.0",
        command: "mqttAuth",
        data: { action: "test", email: "a@b.com", password: "pw", code: "123456" },
      },
    ]);
  });

  it("returns the structured status so the card can open the 2FA field", async () => {
    const { socket } = recordingSocket({ result: "needs 2FA", status: "verifyRequired" });
    const api = makeConnectionApi(socket, "govee-smart.0");
    const res = await api.testLogin({ email: "a@b.com", password: "pw" });
    expect(res.status).toBe("verifyRequired");
  });

  it("requestCode sends mqttAuth {action:requestCode} for the given account", async () => {
    const { socket, calls } = recordingSocket({ result: "Code sent", status: "codeSent" });
    const api = makeConnectionApi(socket, "govee-smart.0");
    const res = await api.requestCode({ email: "a@b.com", password: "pw" });
    expect(res.status).toBe("codeSent");
    expect(calls[0].command).toBe("mqttAuth");
    expect((calls[0].data as { action: string }).action).toBe("requestCode");
  });
});
