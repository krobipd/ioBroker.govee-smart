import React from "react";

import { Box, Button, Stack, Typography } from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { SegmentWizard } from "./SegmentWizard";

/** Which half of the Expert tab is showing. */
type Tool = "wizard" | "diagnostics";

/** The tab ids of `admin/jsonConfig.json` — the only values the tab memory can hold for this adapter. */
const OWN_TAB_IDS = new Set(["_main", "_expert"]);

/**
 * Forget which tab was open last, so the next visit to the instance settings
 * starts on the Configuration tab.
 *
 * The admin's json-config remembers the last tab per adapter (measured on
 * Admin 8.0.12 / json-config 10.0.0, `ConfigTabs`): every tab switch writes
 * `localStorage["<dialogName || 'App'>.<adapterName>"] = <tab id>`, and the
 * dialog opens on that entry whenever the URL hash names no tab — which it
 * never does on a fresh open. There is no schema switch against it. This
 * component mounts exactly when the Expert tab is entered, AFTER that write,
 * so removing the entry here is enough: the next open finds nothing and
 * takes the first tab. Only this adapter's entries are touched, and only
 * those holding one of its own tab ids.
 *
 * @param namespace Adapter instance namespace, e.g. "govee-smart.0"
 */
export function forgetLastTab(namespace: string): void {
  const adapterName = namespace.split(".")[0];
  try {
    const w = window as Window & { _localStorage?: Storage };
    const storage = w._localStorage ?? window.localStorage;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.endsWith(`.${adapterName}`) && OWN_TAB_IDS.has(storage.getItem(key) ?? "")) {
        stale.push(key);
      }
    }
    // Collect first, then remove — deleting while indexing skips entries.
    for (const key of stale) {
      storage.removeItem(key);
    }
  } catch {
    // Storage blocked (private window, disabled site data): nothing to forget.
  }
}

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
  React.useEffect(() => forgetLastTab(namespace), [namespace]);

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
