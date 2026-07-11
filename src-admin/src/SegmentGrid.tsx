import React from "react";

import { Box } from "@mui/material";

/** Visual state of a single grid cell. */
export type CellState = "confirmed" | "flashing" | "gap" | "open";

/** Props for the pure segment-map grid. */
export interface SegmentGridProps {
  /** Number of cells to render (0-based indices `0..total-1`). */
  total: number;
  /** Indices the user confirmed as lit. */
  confirmed: number[];
  /** Index currently flashing white, or `null` when nothing is flashing. */
  flashing: number | null;
  /** Indices marked as gaps (dark between lit segments). */
  gaps: number[];
  /** When true, cells are clickable and call {@link SegmentGridProps.onToggle}. */
  editable: boolean;
  /** Toggle handler for the review screen (only fired when `editable`). */
  onToggle?: (idx: number) => void;
}

// Per-state cell appearance. `flashing` wins over `confirmed` for the same index
// (the live-measurement highlight must always be visible).
const STATE_SX: Record<CellState, Record<string, unknown>> = {
  confirmed: { bgcolor: "success.main", color: "success.contrastText" },
  flashing: { bgcolor: "warning.light", color: "#000", boxShadow: 3 },
  gap: { bgcolor: "error.main", color: "error.contrastText" },
  open: { bgcolor: "action.disabledBackground", color: "text.secondary" },
};

/**
 * Resolve a cell's visual state. Precedence: flashing → confirmed → gap → open.
 *
 * @param idx          Cell index
 * @param confirmedSet Confirmed indices
 * @param flashing     Currently flashing index (or null)
 * @param gapSet       Gap indices
 */
function cellState(idx: number, confirmedSet: Set<number>, flashing: number | null, gapSet: Set<number>): CellState {
  if (flashing === idx) {
    return "flashing";
  }
  if (confirmedSet.has(idx)) {
    return "confirmed";
  }
  if (gapSet.has(idx)) {
    return "gap";
  }
  return "open";
}

/**
 * Pure visual map of a LED strip's segments — no socket/network knowledge. The
 * wizard passes the live measurement state (or the review-corrected state) and,
 * when `editable`, gets click callbacks to flip individual cells.
 *
 * @param props Grid state + optional toggle handler
 */
export function SegmentGrid(props: SegmentGridProps): React.JSX.Element {
  const { total, confirmed, flashing, gaps, editable, onToggle } = props;
  const confirmedSet = new Set(confirmed);
  const gapSet = new Set(gaps);

  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
      {Array.from({ length: Math.max(0, total) }, (_, i) => {
        const state = cellState(i, confirmedSet, flashing, gapSet);
        return (
          <Box
            key={i}
            data-testid={`seg-cell-${i}`}
            className={`seg-cell ${state}`}
            onClick={editable ? () => onToggle?.(i) : undefined}
            sx={{
              width: 34,
              height: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 1,
              fontSize: 12,
              userSelect: "none",
              cursor: editable ? "pointer" : "default",
              ...STATE_SX[state],
            }}
          >
            {i}
          </Box>
        );
      })}
    </Box>
  );
}
