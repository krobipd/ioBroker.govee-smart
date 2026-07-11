import React from "react";

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";

import { SegmentGrid } from "./SegmentGrid";
import {
  makeWizardApi,
  type DeviceOption,
  type WizardResponse,
  type WizardSnapshot,
  type WizardSocket,
} from "./useWizardApi";

/** Props for the segment-wizard React component. */
export interface SegmentWizardProps {
  /** Admin socket (adapter-react-v5) used for the wizard sendTo round-trips. */
  socket: unknown;
  /** Adapter instance namespace, e.g. "govee-smart.0". */
  namespace: string;
}

type Screen = "select" | "measure" | "review" | "success";

/**
 * Indices in `[0, limit)` that are not in `confirmed` — the gaps.
 *
 * @param limit
 * @param confirmed
 */
function gapsUpTo(limit: number, confirmed: number[]): number[] {
  const set = new Set(confirmed);
  const gaps: number[] = [];
  for (let i = 0; i < limit; i++) {
    if (!set.has(i)) {
      gaps.push(i);
    }
  }
  return gaps;
}

/**
 * Interactive segment-detection wizard. Drives the tested backend
 * (getSegmentDevices + segmentWizard onMessage handlers) through
 * {@link makeWizardApi} and renders a live {@link SegmentGrid} that fills in as
 * each segment is measured and can be corrected in the review screen before it
 * is applied.
 *
 * Flow: select → measure (yes/no) → "Finished" moves to review **locally**
 * (the backend session stays open) → apply finalizes with the corrected map.
 * The backend `done`/`finish` action is deliberately unused — `apply` is the
 * finalizer (see the backend wizard's `apply` branch).
 *
 * @param props Admin socket + adapter namespace
 */
export function SegmentWizard(props: SegmentWizardProps): React.JSX.Element {
  const api = React.useMemo(
    () => makeWizardApi(props.socket as WizardSocket, props.namespace),
    [props.socket, props.namespace],
  );

  const [screen, setScreen] = React.useState<Screen>("select");
  const [devices, setDevices] = React.useState<DeviceOption[]>([]);
  const [devicesLoaded, setDevicesLoaded] = React.useState(false);
  const [device, setDevice] = React.useState("");
  const [snapshot, setSnapshot] = React.useState<WizardSnapshot | null>(null);
  const [reviewTotal, setReviewTotal] = React.useState(0);
  const [reviewConfirmed, setReviewConfirmed] = React.useState<number[]>([]);
  const [appliedCount, setAppliedCount] = React.useState(0);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    void api.listDevices().then(list => {
      if (!alive) {
        return;
      }
      setDevices(list);
      setDevice(list.length ? list[0].value : "");
      setDevicesLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [api]);

  const resetToSelect = (): void => {
    setSnapshot(null);
    setScreen("select");
  };

  /**
   * Uniform response funnel applied after every wizard step. Terminal cases
   * (error / already-applied / aborted) set the screen here; a normal
   * measuring update returns false so the caller can advance to `measure`.
   *
   * @param res Wizard response
   * @returns true if the response was terminal (screen already set)
   */
  const reduce = (res: WizardResponse): boolean => {
    if (res.error) {
      setError(res.error);
      resetToSelect();
      return true;
    }
    if (res.aborted) {
      setError("");
      resetToSelect();
      return true;
    }
    if (res.applied || res.done) {
      // `applied` = review-corrected apply; `done` = backend auto-finalize at the
      // protocol limit (already applied + closed — no editable review).
      setAppliedCount(res.segmentCount ?? 0);
      setSnapshot(null);
      setScreen("success");
      return true;
    }
    setError("");
    if (res.snapshot) {
      setSnapshot(res.snapshot);
    }
    return false;
  };

  const onStart = async (): Promise<void> => {
    if (!device) {
      return;
    }
    setError("");
    const res = await api.start(device);
    if (!reduce(res)) {
      setScreen("measure");
    }
  };

  const onAnswer = async (lit: boolean): Promise<void> => {
    reduce(await (lit ? api.yes() : api.no()));
  };

  const onFinish = (): void => {
    const s = snapshot;
    if (!s || s.currentIndex < 1) {
      return;
    }
    const total = s.currentIndex; // segments answered so far (current is unanswered)
    setReviewTotal(total);
    setReviewConfirmed(s.confirmed.filter(i => i < total).sort((a, b) => a - b));
    setScreen("review");
  };

  const toggleReviewCell = (idx: number): void => {
    setReviewConfirmed(prev =>
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx].sort((a, b) => a - b),
    );
  };

  const onApply = async (): Promise<void> => {
    if (!reviewConfirmed.length) {
      return;
    }
    reduce(await api.apply(device, reviewConfirmed));
  };

  const onRemeasure = async (): Promise<void> => {
    await api.abort();
    const res = await api.start(device);
    if (!reduce(res)) {
      setScreen("measure");
    }
  };

  const onCancel = async (): Promise<void> => {
    await api.abort();
    resetToSelect();
  };

  const onClose = (): void => {
    setError("");
    setScreen("select");
  };

  const errorBanner = error ? (
    <Alert
      severity="error"
      data-testid="wiz-error"
      sx={{ mb: 2 }}
    >
      {I18n.t("gsw_error", error)}
    </Alert>
  ) : null;

  if (screen === "select") {
    return (
      <Box sx={{ maxWidth: 520 }}>
        <Typography
          variant="h6"
          sx={{ mb: 2 }}
        >
          {I18n.t("gsw_title")}
        </Typography>
        {errorBanner}
        {!devicesLoaded ? (
          <CircularProgress size={24} />
        ) : devices.length === 0 ? (
          <Alert
            severity="info"
            data-testid="wiz-no-devices"
          >
            {I18n.t("gsw_noDevices")}
          </Alert>
        ) : (
          <Stack spacing={2}>
            <FormControl fullWidth>
              <InputLabel>{I18n.t("gsw_deviceLabel")}</InputLabel>
              <Select
                data-testid="wiz-device-select"
                value={device}
                label={I18n.t("gsw_deviceLabel")}
                onChange={e => setDevice(e.target.value)}
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
                variant="contained"
                data-testid="wiz-start"
                disabled={!device}
                onClick={() => void onStart()}
              >
                {I18n.t("gsw_start")}
              </Button>
            </Box>
          </Stack>
        )}
      </Box>
    );
  }

  if (screen === "measure" && snapshot) {
    const idx = snapshot.currentIndex;
    return (
      <Box sx={{ maxWidth: 520 }}>
        <Typography
          variant="h6"
          sx={{ mb: 1 }}
        >
          {I18n.t("gsw_measureHint")}
        </Typography>
        <SegmentGrid
          total={idx + 1}
          confirmed={snapshot.confirmed}
          flashing={idx}
          gaps={gapsUpTo(idx, snapshot.confirmed)}
          editable={false}
        />
        <Typography sx={{ my: 2 }}>{I18n.t("gsw_question", idx)}</Typography>
        <Stack
          direction="row"
          spacing={1}
          flexWrap="wrap"
          useFlexGap
        >
          <Button
            variant="contained"
            color="success"
            data-testid="wiz-lit"
            onClick={() => void onAnswer(true)}
          >
            {I18n.t("gsw_lit")}
          </Button>
          <Button
            variant="outlined"
            data-testid="wiz-dark"
            onClick={() => void onAnswer(false)}
          >
            {I18n.t("gsw_dark")}
          </Button>
          <Button
            variant="contained"
            data-testid="wiz-finish"
            disabled={idx < 1}
            onClick={onFinish}
          >
            {I18n.t("gsw_finish")}
          </Button>
          <Button
            variant="text"
            color="secondary"
            data-testid="wiz-cancel"
            onClick={() => void onCancel()}
          >
            {I18n.t("gsw_cancel")}
          </Button>
        </Stack>
      </Box>
    );
  }

  if (screen === "review") {
    const segmentCount = reviewConfirmed.length ? Math.max(...reviewConfirmed) + 1 : 0;
    const gapCount = segmentCount - reviewConfirmed.length;
    const result =
      gapCount > 0 ? I18n.t("gsw_resultGaps", segmentCount, gapCount) : I18n.t("gsw_resultNoGaps", segmentCount);
    return (
      <Box sx={{ maxWidth: 520 }}>
        <Typography
          variant="h6"
          sx={{ mb: 1 }}
        >
          {result}
        </Typography>
        <Typography
          variant="body2"
          sx={{ mb: 1, opacity: 0.8 }}
        >
          {I18n.t("gsw_reviewHint")}
        </Typography>
        <SegmentGrid
          total={reviewTotal}
          confirmed={reviewConfirmed}
          flashing={null}
          gaps={gapsUpTo(reviewTotal, reviewConfirmed)}
          editable
          onToggle={toggleReviewCell}
        />
        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 2 }}
          flexWrap="wrap"
          useFlexGap
        >
          <Button
            variant="contained"
            data-testid="wiz-apply"
            disabled={!reviewConfirmed.length}
            onClick={() => void onApply()}
          >
            {I18n.t("gsw_apply")}
          </Button>
          <Button
            variant="outlined"
            data-testid="wiz-remeasure"
            onClick={() => void onRemeasure()}
          >
            {I18n.t("gsw_remeasure")}
          </Button>
          <Button
            variant="text"
            color="secondary"
            data-testid="wiz-cancel"
            onClick={() => void onCancel()}
          >
            {I18n.t("gsw_cancel")}
          </Button>
        </Stack>
      </Box>
    );
  }

  // success
  return (
    <Box
      sx={{ maxWidth: 520 }}
      data-testid="wiz-success"
    >
      <Alert
        severity="success"
        sx={{ mb: 2 }}
      >
        {I18n.t("gsw_applied", appliedCount)}
      </Alert>
      <Button
        variant="contained"
        data-testid="wiz-close"
        onClick={onClose}
      >
        {I18n.t("gsw_close")}
      </Button>
    </Box>
  );
}
