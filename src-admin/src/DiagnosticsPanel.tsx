import React from "react";

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { DeviceListStatus, useDeviceList } from "./DeviceListLoader";
import { isReport, makeDiagnosticsApi, type DiagnosticsSocket } from "./useDiagnosticsApi";

/** Props for the diagnostics React component. */
export interface DiagnosticsPanelProps {
  /** Admin socket (gui-components) used for the sendTo round-trips. */
  socket: unknown;
  /** Adapter instance namespace, e.g. "govee-smart.0". */
  namespace: string;
}

/**
 * Hand the browser a file. The report exists on the instance either way — this
 * is the convenient path, so the reporter can attach it to a GitHub issue
 * without first finding the admin file browser. That extra step is exactly
 * where bug reports were dying.
 *
 * @param fileName Name the file should be saved under
 * @param content The report JSON
 */
function offerDownload(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the blob goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Diagnostics card: pick a device, press one button, get a file.
 *
 * The report used to be a datapoint holding the whole JSON — measured 67,917
 * characters, past GitHub's issue-body limit, so it could not be pasted into
 * the issue it exists for. It is a file now, and this card is the short path
 * from "something is wrong with this device" to an attachment.
 *
 * The device list is deliberately unfiltered: a report is wanted precisely when
 * a device misbehaves, so hiding unreachable ones would hide the interesting
 * cases.
 *
 * @param root0 Component props
 * @param root0.socket Admin socket used for the sendTo round-trips
 * @param root0.namespace Adapter instance namespace
 */
export function DiagnosticsPanel({ socket, namespace }: DiagnosticsPanelProps): React.JSX.Element {
  const api = React.useMemo(() => makeDiagnosticsApi(socket as DiagnosticsSocket, namespace), [socket, namespace]);
  const list = useDeviceList(socket, namespace);
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState("");
  const devices = list.status === "ready" ? list.devices : [];

  React.useEffect(() => {
    // One device is the common case — pre-select it so the card is a single
    // click rather than a pick plus a click.
    if (devices.length === 1) {
      setSelected(devices[0].value);
    }
  }, [devices]);

  const onExport = React.useCallback((): void => {
    setBusy(true);
    setError("");
    setDone("");
    api
      .exportReport(selected)
      .then(res => {
        if (isReport(res)) {
          offerDownload(res.fileName, res.content);
          setDone(res.fileName);
        } else {
          setError(res.error);
        }
      })
      .catch(() => setError(I18n.t("gsw_diagExportFailed")))
      .finally(() => setBusy(false));
  }, [api, selected]);

  if (list.status !== "ready") {
    return <DeviceListStatus state={list} />;
  }

  return (
    <Box sx={{ p: 2, maxWidth: 720 }}>
      <Stack spacing={2}>
        <Typography variant="body2">{I18n.t("gsw_diagIntro")}</Typography>

        {devices.length === 0 ? (
          <Alert
            severity="info"
            data-testid="diag-no-devices"
          >
            {I18n.t("gsw_diagNoDevices")}
          </Alert>
        ) : (
          <>
            <FormControl fullWidth>
              <InputLabel id="gsw-diag-device">{I18n.t("gsw_diagDevice")}</InputLabel>
              <Select
                data-testid="diag-device-select"
                labelId="gsw-diag-device"
                label={I18n.t("gsw_diagDevice")}
                value={selected}
                onChange={e => setSelected(String(e.target.value))}
              >
                {devices.map(d => (
                  <MenuItem
                    key={d.value}
                    value={d.value}
                  >
                    {d.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box>
              <Button
                data-testid="diag-export"
                variant="contained"
                disabled={!selected || busy}
                onClick={onExport}
                startIcon={busy ? <CircularProgress size={16} /> : undefined}
              >
                {I18n.t("gsw_diagExport")}
              </Button>
            </Box>
          </>
        )}

        {done ? (
          <Alert severity="success">
            {I18n.t("gsw_diagDone", done)}{" "}
            <Link
              href="https://github.com/krobipd/ioBroker.govee-smart/issues/new/choose"
              target="_blank"
              rel="noreferrer"
            >
              {I18n.t("gsw_diagOpenIssue")}
            </Link>
          </Alert>
        ) : null}
        {error ? <Alert severity="error">{error}</Alert> : null}

        <Typography
          variant="caption"
          color="text.secondary"
        >
          {I18n.t("gsw_diagPrivacy")}
        </Typography>
      </Stack>
    </Box>
  );
}
