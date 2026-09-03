import React from "react";

import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { DeviceListError, makeDeviceListApi, type DeviceEntry, type DeviceListSocket } from "./useDeviceList";

/**
 * After this long without an answer the wait gets an explanation. Short enough
 * that a stuck card says something while the user is still looking at it, long
 * enough that a normal load never shows it.
 */
const SLOW_AFTER_MS = 4_000;

/** What the card knows about its device list. */
export type DeviceListState =
  | { status: "loading"; slow: boolean }
  | { status: "ready"; devices: DeviceEntry[] }
  | { status: "failed"; message: string };

/**
 * Load the device list once per mount and report the three states a card has
 * to tell apart: still loading, loaded, failed.
 *
 * Both halves of the Expert tab use this, so the rule lives once. Before 2.31.0
 * each card had its own version and they disagreed — the wizard tracked a
 * `devicesLoaded` flag, the diagnostics card a `devices === null` sentinel, and
 * NEITHER could show a failure, because both hooks turned one into an empty
 * list. An adapter with ten devices reported "no devices yet".
 *
 * The card is unmounted when the other half is shown, so switching tabs
 * re-runs this — deliberately. `online` is live state and a list kept across a
 * switch would age.
 *
 * @param socket Admin socket exposing `sendTo`
 * @param namespace Adapter instance, e.g. "govee-smart.0"
 */
export function useDeviceList(socket: unknown, namespace: string): DeviceListState {
  const api = React.useMemo(() => makeDeviceListApi(socket as DeviceListSocket, namespace), [socket, namespace]);
  const [state, setState] = React.useState<DeviceListState>({ status: "loading", slow: false });

  React.useEffect(() => {
    let alive = true;
    setState({ status: "loading", slow: false });
    const slowTimer = setTimeout(() => {
      // Only escalate a wait that is STILL a wait — a list that arrived while
      // the timer ran must not be talked over.
      setState(prev => (prev.status === "loading" ? { status: "loading", slow: true } : prev));
    }, SLOW_AFTER_MS);

    api
      .listDevices()
      .then(devices => {
        if (alive) {
          setState({ status: "ready", devices });
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setState({
            status: "failed",
            message: e instanceof DeviceListError && e.message ? e.message : I18n.t("gsw_listFailed"),
          });
        }
      });

    return () => {
      alive = false;
      clearTimeout(slowTimer);
    };
  }, [api]);

  return state;
}

/** Props for {@link DeviceListStatus}. */
export interface DeviceListStatusProps {
  /** The state to render — only `loading` and `failed` produce output. */
  state: DeviceListState;
}

/**
 * The shared rendering of "loading" and "failed". A card renders this and, when
 * the list is ready, its own content instead.
 *
 * The spinner never stands alone: a wheel with no words is the same dead end as
 * a wrong "no devices" message — the user cannot tell waiting from broken.
 *
 * @param root0 Component props
 * @param root0.state The device-list state to render
 */
export function DeviceListStatus({ state }: DeviceListStatusProps): React.JSX.Element | null {
  if (state.status === "loading") {
    return (
      <Box sx={{ p: 2 }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "center" }}
        >
          <CircularProgress size={24} />
          <Box>
            <Typography variant="body2">{I18n.t("gsw_loadingDevices")}</Typography>
            {state.slow ? (
              <Typography
                variant="caption"
                color="text.secondary"
                data-testid="list-slow-hint"
              >
                {I18n.t("gsw_loadingDevicesSlow")}
              </Typography>
            ) : null}
          </Box>
        </Stack>
      </Box>
    );
  }
  if (state.status === "failed") {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          data-testid="list-failed"
        >
          {state.message}
        </Alert>
      </Box>
    );
  }
  return null;
}
