import React from "react";

import { Alert, Box, Button, CircularProgress, Collapse, Divider, Stack, TextField, Typography } from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { makeConnectionApi, type AuthStatus } from "./useConnectionApi";

/**
 * Socket seam the panel needs: the `sendTo` round-trip (login test / code
 * request) plus the live `info.*Connected` state feed. Declared narrowly so a
 * jsdom test can inject a recording/scripted fake. Matches the relevant slice
 * of `@iobroker/socket-client`'s Connection.
 */
export interface ConnectionSocketFull {
  /** Fire a `mqttAuth` action at the adapter instance. */
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
  /** Read one state once (for the initial dot color). */
  getState(id: string): Promise<ioBroker.State | null | undefined>;
  /** Subscribe to a state; `cb` fires on every change. */
  subscribeState(id: string, cb: ioBroker.StateChangeHandler): Promise<void> | void;
  /** Drop a subscription — must be called with the SAME `cb` reference. */
  unsubscribeState(id: string, cb: ioBroker.StateChangeHandler): void;
}

/** The four credential values the card owns, lifted from `native.*`. */
export interface ConnectionValues {
  /** Cloud REST API key (`native.apiKey`). */
  apiKey: string;
  /** Govee account email (`native.goveeEmail`). */
  email: string;
  /** Govee account password (`native.goveePassword`). */
  password: string;
  /** 2FA verification code (`native.mqttVerificationCode`). */
  code: string;
}

/** Props for the connection card. */
export interface ConnectionPanelProps {
  /** Admin socket (see {@link ConnectionSocketFull}). */
  socket: unknown;
  /** Adapter instance, e.g. "govee-smart.0". */
  namespace: string;
  /** Current credential values (from `ConfigGeneric.getValue`). */
  values: ConnectionValues;
  /** Persist one native attribute — wires the admin Save button. */
  onChange: (attr: string, value: string) => void;
}

/** Live connection flags derived from the adapter's `info.*` states. */
interface LiveConnected {
  /** `info.cloudConnected` — Cloud REST reachable with the current API key. */
  cloud: boolean;
  /** `info.mqttConnected` — AWS-IoT real-time push authenticated. */
  mqtt: boolean;
  /** `info.verificationPending` — Govee is waiting for a 2FA code. */
  verifyPending: boolean;
}

/**
 * Subscribe to `info.cloudConnected`, `info.mqttConnected` and
 * `info.verificationPending` and return their live values. The change handlers
 * are created once per (socket, namespace) effect run and used for BOTH
 * subscribe and unsubscribe, so no subscription leaks on unmount or namespace
 * change. The card only ever reads these — it never triggers a login, so it
 * cannot contribute to the account-login storm guard (#39).
 *
 * @param socket    Admin socket, or null before it is ready
 * @param namespace Adapter instance namespace
 */
function useLiveConnected(socket: ConnectionSocketFull | null, namespace: string): LiveConnected {
  const [live, setLive] = React.useState<LiveConnected>({ cloud: false, mqtt: false, verifyPending: false });

  React.useEffect(() => {
    if (!socket) {
      return undefined;
    }
    const cloudId = `${namespace}.info.cloudConnected`;
    const mqttId = `${namespace}.info.mqttConnected`;
    const verifyId = `${namespace}.info.verificationPending`;
    let alive = true;

    const onCloud: ioBroker.StateChangeHandler = (_id, s) => {
      if (alive) {
        setLive(prev => ({ ...prev, cloud: !!s?.val }));
      }
    };
    const onMqtt: ioBroker.StateChangeHandler = (_id, s) => {
      if (alive) {
        setLive(prev => ({ ...prev, mqtt: !!s?.val }));
      }
    };
    const onVerify: ioBroker.StateChangeHandler = (_id, s) => {
      if (alive) {
        setLive(prev => ({ ...prev, verifyPending: !!s?.val }));
      }
    };

    void Promise.resolve(socket.getState(cloudId))
      .then(s => onCloud(cloudId, s))
      .catch(() => undefined);
    void Promise.resolve(socket.getState(mqttId))
      .then(s => onMqtt(mqttId, s))
      .catch(() => undefined);
    void Promise.resolve(socket.getState(verifyId))
      .then(s => onVerify(verifyId, s))
      .catch(() => undefined);
    void Promise.resolve(socket.subscribeState(cloudId, onCloud)).catch(() => undefined);
    void Promise.resolve(socket.subscribeState(mqttId, onMqtt)).catch(() => undefined);
    void Promise.resolve(socket.subscribeState(verifyId, onVerify)).catch(() => undefined);

    return () => {
      alive = false;
      socket.unsubscribeState(cloudId, onCloud);
      socket.unsubscribeState(mqttId, onMqtt);
      socket.unsubscribeState(verifyId, onVerify);
    };
  }, [socket, namespace]);

  return live;
}

/**
 * MUI Alert severity for each auth outcome.
 *
 * @param status
 */
function severityFor(status: AuthStatus): "success" | "info" | "warning" | "error" {
  switch (status) {
    case "ok":
      return "success";
    case "verifyRequired":
    case "codeSent":
      return "info";
    case "codeInvalid":
    case "codeRejected":
    case "needCredentials":
    case "throttled":
      return "warning";
    default:
      return "error";
  }
}

/**
 * Whether an outcome means the 2FA code field should be shown.
 *
 * @param status
 */
function wantsCode(status: AuthStatus): boolean {
  return status === "verifyRequired" || status === "codeSent" || status === "codeInvalid" || status === "codeRejected";
}

/**
 * A small colored status dot: green when connected, grey when not.
 *
 * @param root0
 * @param root0.on
 * @param root0.testId
 */
function StatusDot({ on, testId }: { on: boolean; testId?: string }): React.JSX.Element {
  return (
    <Box
      component="span"
      data-testid={testId}
      data-on={on ? "true" : "false"}
      sx={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: "50%",
        flexShrink: 0,
        bgcolor: on ? "success.main" : "action.disabled",
      }}
    />
  );
}

/**
 * The Govee connection card ("Stufen-Karte"): three stacked tiers — LAN (always
 * on), Cloud API key, and real-time account login with an inline 2FA flow. It
 * owns the four `native.*` credential values (controlled inputs → `onChange`),
 * drives a live login probe through the `mqttAuth` backend, and shows real-time
 * connection state from the adapter's `info.*Connected` datapoints — so the 2FA
 * status flows through the UI on one path instead of the log/notification.
 *
 * @param props Socket, namespace, current values, and the persist callback
 */
export function ConnectionPanel(props: ConnectionPanelProps): React.JSX.Element {
  const { socket, namespace, values, onChange } = props;
  const { apiKey, email, password, code } = values;
  const api = React.useMemo(() => makeConnectionApi(socket as ConnectionSocketFull, namespace), [socket, namespace]);
  const live = useLiveConnected(socket as ConnectionSocketFull, namespace);

  const [busy, setBusy] = React.useState<"" | "login" | "code">("");
  const [feedback, setFeedback] = React.useState<{ status: AuthStatus; text: string } | null>(null);
  const [codeOpen, setCodeOpen] = React.useState(false);

  // Local draft buffer so typing stays smooth: the admin re-render that feeds
  // `values` back is async, and a pure controlled input would fight the cursor.
  // json-config's own ConfigText keeps a state.value for the same reason. A
  // field is adopted from props only when it actually differs from the buffer —
  // so the async echo of the user's own keystroke (buffer already equals it) is
  // ignored, while a genuine external change (initial load, or the adapter
  // clearing the code after success) is pulled in.
  const [draft, setDraft] = React.useState<ConnectionValues>({ apiKey, email, password, code });
  React.useEffect(() => {
    setDraft(prev => {
      const next = { ...prev };
      let changed = false;
      if (prev.apiKey !== apiKey) {
        next.apiKey = apiKey;
        changed = true;
      }
      if (prev.email !== email) {
        next.email = email;
        changed = true;
      }
      if (prev.password !== password) {
        next.password = password;
        changed = true;
      }
      if (prev.code !== code) {
        next.code = code;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [apiKey, email, password, code]);

  const setField = (attr: string, key: keyof ConnectionValues, val: string): void => {
    setDraft(prev => ({ ...prev, [key]: val }));
    onChange(attr, val);
  };

  // When the running adapter reports it is waiting for a 2FA code, open the
  // code field on its own — the user should not have to press Connect first to
  // learn that. This is the passive path; the Connect probe is the active one.
  React.useEffect(() => {
    if (live.verifyPending) {
      setCodeOpen(true);
    }
  }, [live.verifyPending]);

  const t = (key: string, ...args: (string | number)[]): string => I18n.t(key, ...args);

  const showFeedback = (status: AuthStatus): void => {
    setFeedback({ status, text: t(`gsw_conn_st_${status}`) });
    if (wantsCode(status)) {
      setCodeOpen(true);
    }
  };

  const runLogin = async (): Promise<void> => {
    setBusy("login");
    try {
      const res = await api.testLogin({ email: draft.email, password: draft.password, code: draft.code });
      showFeedback(res.status);
    } catch {
      showFeedback("loginFailed");
    } finally {
      setBusy("");
    }
  };

  const runRequestCode = async (): Promise<void> => {
    setBusy("code");
    try {
      const res = await api.requestCode({ email: draft.email, password: draft.password });
      showFeedback(res.status);
    } catch {
      showFeedback("loginFailed");
    } finally {
      setBusy("");
    }
  };

  const hasAccount = draft.email.trim() !== "" && draft.password.trim() !== "";

  return (
    <Box sx={{ maxWidth: 640 }}>
      {/* Tier 1 — LAN, always on, no input */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ py: 1, alignItems: "center" }}
      >
        <StatusDot
          on
          testId="dot-lan"
        />
        <Box>
          <Typography variant="subtitle2">{t("gsw_conn_lan_title")}</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
          >
            {t("gsw_conn_lan_desc")}
          </Typography>
        </Box>
      </Stack>

      <Divider />

      {/* Tier 2 — Cloud API key */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ py: 1.5, alignItems: "flex-start" }}
      >
        <Box sx={{ pt: 1 }}>
          <StatusDot
            on={live.cloud}
            testId="dot-cloud"
          />
        </Box>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="subtitle2">{t("gsw_conn_cloud_title")}</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1 }}
          >
            {t("gsw_conn_cloud_desc")}
          </Typography>
          <TextField
            fullWidth
            size="small"
            type="password"
            label={t("gsw_conn_apikey_label")}
            value={draft.apiKey}
            onChange={e => setField("apiKey", "apiKey", e.target.value)}
            slotProps={{ htmlInput: { "data-testid": "conn-apikey" } }}
            autoComplete="off"
          />
        </Box>
      </Stack>

      <Divider />

      {/* Tier 3 — real-time account login + 2FA */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ py: 1.5, alignItems: "flex-start" }}
      >
        <Box sx={{ pt: 1 }}>
          <StatusDot
            on={live.mqtt}
            testId="dot-mqtt"
          />
        </Box>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="subtitle2">{t("gsw_conn_rt_title")}</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1 }}
          >
            {t("gsw_conn_rt_desc")}
          </Typography>
          <Stack spacing={1}>
            <TextField
              fullWidth
              size="small"
              label={t("gsw_conn_email_label")}
              value={draft.email}
              onChange={e => setField("goveeEmail", "email", e.target.value)}
              slotProps={{ htmlInput: { "data-testid": "conn-email" } }}
              autoComplete="off"
            />
            <TextField
              fullWidth
              size="small"
              type="password"
              label={t("gsw_conn_password_label")}
              value={draft.password}
              onChange={e => setField("goveePassword", "password", e.target.value)}
              slotProps={{ htmlInput: { "data-testid": "conn-password" } }}
              autoComplete="off"
            />
            <Box>
              <Button
                variant="contained"
                size="small"
                data-testid="conn-connect"
                disabled={!hasAccount || busy !== ""}
                onClick={() => void runLogin()}
                startIcon={
                  busy === "login" ? (
                    <CircularProgress
                      size={16}
                      color="inherit"
                    />
                  ) : undefined
                }
              >
                {t("gsw_conn_connect_btn")}
              </Button>
            </Box>

            <Collapse
              in={codeOpen}
              unmountOnExit
            >
              <Stack
                spacing={1}
                sx={{ mt: 1, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}
              >
                <Typography
                  variant="body2"
                  color="text.secondary"
                >
                  {t("gsw_conn_2fa_hint")}
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  label={t("gsw_conn_code_label")}
                  value={draft.code}
                  onChange={e => setField("mqttVerificationCode", "code", e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 8 } }}
                  autoComplete="off"
                />
                <Stack
                  direction="row"
                  spacing={1}
                >
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={!hasAccount || busy !== ""}
                    onClick={() => void runRequestCode()}
                    startIcon={
                      busy === "code" ? (
                        <CircularProgress
                          size={16}
                          color="inherit"
                        />
                      ) : undefined
                    }
                  >
                    {t("gsw_conn_request_btn")}
                  </Button>
                  <Button
                    variant="contained"
                    size="small"
                    disabled={!hasAccount || draft.code.trim() === "" || busy !== ""}
                    onClick={() => void runLogin()}
                    startIcon={
                      busy === "login" ? (
                        <CircularProgress
                          size={16}
                          color="inherit"
                        />
                      ) : undefined
                    }
                  >
                    {t("gsw_conn_verify_btn")}
                  </Button>
                </Stack>
              </Stack>
            </Collapse>
          </Stack>
        </Box>
      </Stack>

      {feedback && (
        <Alert
          severity={severityFor(feedback.status)}
          sx={{ mt: 1 }}
          onClose={() => setFeedback(null)}
        >
          {feedback.text}
        </Alert>
      )}
    </Box>
  );
}
