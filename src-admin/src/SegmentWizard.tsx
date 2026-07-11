import React from "react";
import { Box } from "@mui/material";

/** Props for the segment-wizard React component. */
export interface SegmentWizardProps {
  /** Admin socket (adapter-react-v5) used for the wizard sendTo round-trips. */
  socket: unknown;
  /** Adapter instance namespace, e.g. "govee-smart.0". */
  namespace: string;
}

/**
 * Segment-detection wizard UI. Shell for now — the 3-screen state machine
 * (select → measure → review) with the live segment map lands in a later task.
 *
 * @param _props Socket + namespace (unused by the shell)
 */
export function SegmentWizard(_props: SegmentWizardProps): React.JSX.Element {
  return <Box>Segment wizard</Box>;
}
