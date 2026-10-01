import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";

import enJson from "./i18n/en.json";
import { ConnectionPanel, type ConnectionValues } from "./ConnectionPanel";
import type { AuthResponse } from "../../src/lib/auth-status";

type Handler = (id: string, state: { val: unknown } | null | undefined) => void;

/**
 * Scriptable fake admin socket: records `sendTo` calls, serves initial state
 * values, and lets a test `emit` a live state change to the subscribers. No
 * real socket — the panel drives the real `makeConnectionApi` + live-status
 * hook against this.
 */
function fakeSocket(opts: { states?: Record<string, unknown>; auth?: AuthResponse }): {
  socket: unknown;
  sent: Array<{ command: string; data: Record<string, unknown> }>;
  emit: (id: string, val: unknown) => void;
} {
  const states = opts.states ?? {};
  const auth = opts.auth ?? { status: "ok" };
  const subs = new Map<string, Handler[]>();
  const sent: Array<{ command: string; data: Record<string, unknown> }> = [];
  const socket = {
    sendTo: (_ns: string, command: string, data: unknown) => {
      sent.push({ command, data: data as Record<string, unknown> });
      return Promise.resolve(auth);
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
  const emit = (id: string, val: unknown): void => {
    (subs.get(id) ?? []).forEach(cb => cb(id, { val }));
  };
  return { socket, sent, emit };
}

function renderPanel(opts?: {
  values?: Partial<ConnectionValues>;
  states?: Record<string, unknown>;
  auth?: AuthResponse;
}): {
  onChange: ReturnType<typeof vi.fn>;
  sent: Array<{ command: string; data: Record<string, unknown> }>;
  emit: (id: string, val: unknown) => void;
} {
  const onChange = vi.fn();
  const values: ConnectionValues = {
    apiKey: "",
    email: "user@example.com",
    password: "secret",
    code: "",
    ...opts?.values,
  };
  const { socket, sent, emit } = fakeSocket({ states: opts?.states, auth: opts?.auth });
  render(
    <ConnectionPanel
      socket={socket}
      namespace="govee-smart.0"
      values={values}
      onChange={onChange}
    />,
  );
  return { onChange, sent, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  I18n.extendTranslations(enJson, "en");
  I18n.setLanguage("en");
});

describe("ConnectionPanel", () => {
  it("renders the three tiers (LAN / Cloud / real-time)", () => {
    renderPanel();
    expect(screen.getByText(I18n.t("gsw_conn_lan_title"))).toBeTruthy();
    expect(screen.getByText(I18n.t("gsw_conn_cloud_title"))).toBeTruthy();
    expect(screen.getByText(I18n.t("gsw_conn_rt_title"))).toBeTruthy();
  });

  it("persists a typed email through onChange('goveeEmail') and reflects it locally", () => {
    const { onChange } = renderPanel({ values: { email: "" } });
    const field = screen.getByLabelText(I18n.t("gsw_conn_email_label")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "new@example.com" } });
    expect(onChange).toHaveBeenCalledWith("goveeEmail", "new@example.com");
    // The local draft buffer shows the keystroke immediately (no round-trip lag).
    expect(field.value).toBe("new@example.com");
  });

  it("adopts an external value change from props (e.g. adapter cleared the code)", () => {
    const onChange = vi.fn();
    const { socket } = fakeSocket({});
    const base = { apiKey: "", password: "", code: "" };
    const { rerender } = render(
      <ConnectionPanel
        socket={socket}
        namespace="govee-smart.0"
        values={{ ...base, email: "old@example.com" }}
        onChange={onChange}
      />,
    );
    const field = screen.getByLabelText(I18n.t("gsw_conn_email_label")) as HTMLInputElement;
    expect(field.value).toBe("old@example.com");
    rerender(
      <ConnectionPanel
        socket={socket}
        namespace="govee-smart.0"
        values={{ ...base, email: "new@example.com" }}
        onChange={onChange}
      />,
    );
    expect(field.value).toBe("new@example.com");
  });

  it("Connect sends mqttAuth {action:test} with the LIVE credentials + shows feedback", async () => {
    const { sent } = renderPanel({ auth: { status: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].command).toBe("mqttAuth");
    expect(sent[0].data).toMatchObject({ action: "test", email: "user@example.com", password: "secret" });
    expect(await screen.findByText(I18n.t("gsw_conn_st_ok"))).toBeTruthy();
  });

  it("a failed login shows Govee's reason in the card's own sentence (audit E11, DRY-13)", async () => {
    renderPanel({ auth: { status: "loginFailed", reason: "account frozen" } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_st_loginFailedReason", "account frozen"))).toBeTruthy();
    expect(screen.queryByText(I18n.t("gsw_conn_st_loginFailed"))).toBeNull();
  });

  it("a refused code request shows Govee's reason too", async () => {
    renderPanel({ auth: { status: "codeRejected", reason: "too many codes" } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_st_codeRejectedReason", "too many codes"))).toBeTruthy();
  });

  it("a full login window names the time on the viewer's clock", async () => {
    const retryAt = Date.UTC(2026, 9, 1, 20, 15);
    renderPanel({ auth: { status: "loginWindowFull", retryAt } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    const time = new Date(retryAt).toLocaleTimeString();
    expect(await screen.findByText(I18n.t("gsw_conn_st_loginWindowFull", time))).toBeTruthy();
    // The adapter's own pause is a wait, not a failure — the same colour as the other throttle.
    expect(screen.getByRole("alert").className).toMatch(/Warning/);
  });

  it("a full login window without its time falls back to the rate-limit text, never a sentence with a hole", async () => {
    renderPanel({ auth: { status: "loginWindowFull" } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_st_rateLimited"))).toBeTruthy();
  });

  it("a case without a reason keeps the card's own text", async () => {
    renderPanel({ auth: { status: "passwordRejected" } });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_st_passwordRejected"))).toBeTruthy();
  });

  it("an answer without a status shows its error, never the raw key (audit E11)", async () => {
    renderPanel({ auth: { error: "Adapter is starting" } as never });
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_err", "Adapter is starting"))).toBeTruthy();
    expect(screen.queryByText(/gsw_conn_st_/)).toBeNull();
  });

  it("a sendTo that rejects shows the reason (audit E11)", async () => {
    const { socket } = fakeSocket({});
    (socket as { sendTo: unknown }).sendTo = () => Promise.reject(new Error("timeout after 20 s"));
    render(
      <ConnectionPanel
        socket={socket}
        namespace="govee-smart.0"
        values={{ apiKey: "", email: "user@example.com", password: "secret", code: "" }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_err", "timeout after 20 s"))).toBeTruthy();
  });

  it("a code request whose sendTo rejects shows the reason too (audit E11)", async () => {
    const { socket } = fakeSocket({ states: { "govee-smart.0.info.verificationPending": true } });
    (socket as { sendTo: unknown }).sendTo = () => Promise.reject(new Error("socket closed"));
    render(
      <ConnectionPanel
        socket={socket}
        namespace="govee-smart.0"
        values={{ apiKey: "", email: "user@example.com", password: "secret", code: "" }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: I18n.t("gsw_conn_request_btn") }));
    expect(await screen.findByText(I18n.t("gsw_conn_err", "socket closed"))).toBeTruthy();
  });

  it("a verifyRequired result opens the 2FA code field", async () => {
    renderPanel({ auth: { status: "verifyRequired" } });
    expect(screen.queryByLabelText(I18n.t("gsw_conn_code_label"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") }));
    expect(await screen.findByLabelText(I18n.t("gsw_conn_code_label"))).toBeTruthy();
  });

  it("info.verificationPending opens the code field passively — without a click", async () => {
    const { emit, sent } = renderPanel();
    // Let the live-status effect subscribe + settle the initial getState reads.
    await act(async () => undefined);
    expect(screen.queryByLabelText(I18n.t("gsw_conn_code_label"))).toBeNull();
    act(() => emit("govee-smart.0.info.verificationPending", true));
    expect(await screen.findByLabelText(I18n.t("gsw_conn_code_label"))).toBeTruthy();
    expect(sent).toHaveLength(0); // the passive path never triggers a login
  });

  it("reflects the live info.mqttConnected state on the real-time dot", async () => {
    renderPanel({ states: { "govee-smart.0.info.mqttConnected": true } });
    await waitFor(() => expect(screen.getByTestId("dot-mqtt").getAttribute("data-on")).toBe("true"));
    expect(screen.getByTestId("dot-cloud").getAttribute("data-on")).toBe("false");
  });

  it("disables Connect until both email and password are present", () => {
    renderPanel({ values: { email: "user@example.com", password: "" } });
    expect(screen.getByRole("button", { name: I18n.t("gsw_conn_connect_btn") })).toHaveProperty("disabled", true);
  });
});
