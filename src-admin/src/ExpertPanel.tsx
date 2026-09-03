import React from "react";

import { Box, Button, Stack, Typography } from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SegmentWizard } from "./SegmentWizard";

/** Which half of the Expert tab is showing. */
type Tool = "wizard" | "diagnostics";

/** Props for the Expert panel. */
export interface ExpertPanelProps {
  /** Admin socket (gui-components) handed down to whichever tool is showing. */
  socket: unknown;
  /** Adapter instance namespace, e.g. "govee-smart.0". */
  namespace: string;
}

/**
 * The Expert tab: two tools, one tab.
 *
 * Segment detection and diagnostics used to be a tab each, which put two
 * rarely-used tools permanently in front of everyone and made the config look
 * like it had three equal parts. They are one tab now, chosen by a pair of
 * buttons.
 *
 * Only the selected tool is mounted. That is what makes the device list fresh
 * on every switch — both tools load it on mount, and `online` is live state
 * that would age in a list kept across switches.
 *
 * @param root0 Component props
 * @param root0.socket Admin socket used for the sendTo round-trips
 * @param root0.namespace Adapter instance namespace
 */
export function ExpertPanel({ socket, namespace }: ExpertPanelProps): React.JSX.Element {
  const [tool, setTool] = React.useState<Tool>("wizard");

  return (
    <Box sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="body2">{I18n.t("gsw_expertIntro")}</Typography>
        <Stack
          direction="row"
          spacing={1}
          sx={{ flexWrap: "wrap" }}
        >
          <Button
            data-testid="expert-tool-wizard"
            variant={tool === "wizard" ? "contained" : "outlined"}
            onClick={() => setTool("wizard")}
          >
            {I18n.t("gsw_expertWizard")}
          </Button>
          <Button
            data-testid="expert-tool-diagnostics"
            variant={tool === "diagnostics" ? "contained" : "outlined"}
            onClick={() => setTool("diagnostics")}
          >
            {I18n.t("gsw_expertDiagnostics")}
          </Button>
        </Stack>
        {tool === "wizard" ? (
          <SegmentWizard
            socket={socket}
            namespace={namespace}
          />
        ) : (
          <DiagnosticsPanel
            socket={socket}
            namespace={namespace}
          />
        )}
      </Stack>
    </Box>
  );
}
