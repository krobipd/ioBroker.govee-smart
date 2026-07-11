import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SegmentGrid } from "./SegmentGrid";

describe("SegmentGrid", () => {
  it("renders one cell per segment with the right state class", () => {
    render(<SegmentGrid total={5} confirmed={[0, 1]} flashing={2} gaps={[]} editable={false} />);
    expect(screen.getAllByTestId(/^seg-cell-\d+$/)).toHaveLength(5);
    expect(screen.getByTestId("seg-cell-0")).toHaveClass("confirmed");
    expect(screen.getByTestId("seg-cell-1")).toHaveClass("confirmed");
    expect(screen.getByTestId("seg-cell-2")).toHaveClass("flashing");
    expect(screen.getByTestId("seg-cell-3")).toHaveClass("open");
    expect(screen.getByTestId("seg-cell-4")).toHaveClass("open");
  });

  it("marks gap cells with the gap class", () => {
    render(<SegmentGrid total={3} confirmed={[0, 2]} flashing={null} gaps={[1]} editable={false} />);
    expect(screen.getByTestId("seg-cell-1")).toHaveClass("gap");
  });

  it("flashing wins over confirmed for the same index", () => {
    render(<SegmentGrid total={2} confirmed={[0, 1]} flashing={1} gaps={[]} editable={false} />);
    expect(screen.getByTestId("seg-cell-1")).toHaveClass("flashing");
    expect(screen.getByTestId("seg-cell-1")).not.toHaveClass("confirmed");
  });

  it("calls onToggle(idx) when an editable cell is clicked", () => {
    const onToggle = vi.fn();
    render(<SegmentGrid total={3} confirmed={[0]} flashing={null} gaps={[1]} editable onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId("seg-cell-1"));
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it("does not toggle when the grid is not editable", () => {
    const onToggle = vi.fn();
    render(<SegmentGrid total={3} confirmed={[0]} flashing={null} gaps={[]} editable={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId("seg-cell-1"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders nothing for total=0", () => {
    render(<SegmentGrid total={0} confirmed={[]} flashing={null} gaps={[]} editable={false} />);
    expect(screen.queryAllByTestId(/^seg-cell-\d+$/)).toHaveLength(0);
  });
});
