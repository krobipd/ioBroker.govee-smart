// B4 — Login and the two-factor code run through a connection card of their own with live status, instead of a flat list
// of buttons.
// krobi 2026-08 (note): "full consequence"; approved 2026-10-08 09:39 ("b4 yes, it is admin, yes")
/// <reference types="node" />
import * as fs from "node:fs";
import * as path from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";
import { beforeEach, describe, expect, it } from "vitest";

import enJson from "../i18n/en.json";
import { ConnectionPanel } from "../ConnectionPanel";

type Handler = (id: string, state: { val: unknown } | null | undefined) => void;

function fakeSocket(states: Record<string, unknown>): {
  socket: unknown;
  sent: Array<{ command: string; data: Record<string, unknown> }>;
  emit: (id: string, val: unknown) => void;
} {
  const subs = new Map<string, Handler[]>();
  const sent: Array<{ command: string; data: Record<string, unknown> }> = [];
  const socket = {
    sendTo: (_ns: string, command: string, data: unknown) => {
      sent.push({ command, data: data as Record<string, unknown> });
      return Promise.resolve({ status: "verifyRequired" });
    },
    getState: (id: string) => Promise.resolve(id in states ? { val: states[id] } : null),
    subscribeState: (id: string, cb: Handler) => {
      subs.set(id, [...(subs.get(id) ?? []), cb]);
      return Promise.resolve();
    },
    unsubscribeState: (id: string, cb: Handler) => {
      subs.set(
        id,
        (subs.get(id) ?? []).filter(h => h !== cb),
      );
    },
  };
  return { socket, sent, emit: (id, val) => (subs.get(id) ?? []).forEach(cb => cb(id, { val })) };
}

function renderCard(states: Record<string, unknown> = {}): ReturnType<typeof fakeSocket> {
  const fake = fakeSocket(states);
  render(
    <ConnectionPanel
      socket={fake.socket}
      namespace="govee-smart.0"
      values={{ apiKey: "", email: "user@example.com", password: "secret", code: "" }}
      onChange={() => {}}
    />,
  );
  return fake;
}

beforeEach(() => {
  I18n.extendTranslations(enJson, "en");
  I18n.setLanguage("en");
});

describe("B4 login and two-factor code in the connection card", () => {
  it("the settings page mounts the connection card and carries no flat sendTo buttons", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "..", "admin", "jsonConfig.json"), "utf-8");
    const types: string[] = [];
    const names: string[] = [];
    JSON.parse(text, (key, value: unknown) => {
      if (key === "type" && typeof value === "string") {
        types.push(value);
      }
      if (key === "name" && typeof value === "string") {
        names.push(value);
      }
      return value;
    });
    expect(names.some(n => n.endsWith("/ConnectionConfig"))).toBe(true);
    expect(types.filter(t => t.toLowerCase() === "sendto")).toEqual([]);
  });

  it("Connect logs in through the card, and Govee's request for a code opens the code field in the card", async () => {
    const { sent } = renderCard();
    expect(screen.queryByLabelText(I18n.t("gsw_conn_code_label"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: "mqttAuth", data: { action: "test", email: "user@example.com" } });
    expect(await screen.findByLabelText(I18n.t("gsw_conn_code_label"))).toBeTruthy();
  });

  it("the card follows the adapter live: a pending verification opens the code field without a click", async () => {
    const { emit, sent } = renderCard();
    await act(async () => undefined);
    expect(screen.queryByLabelText(I18n.t("gsw_conn_code_label"))).toBeNull();
    act(() => emit("govee-smart.0.info.verificationPending", true));
    expect(await screen.findByLabelText(I18n.t("gsw_conn_code_label"))).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("the card shows the live connection of the account broker", async () => {
    renderCard({ "govee-smart.0.info.mqttConnected": true });
    await waitFor(() => expect(screen.getByTestId("dot-mqtt").getAttribute("data-on")).toBe("true"));
  });
});
