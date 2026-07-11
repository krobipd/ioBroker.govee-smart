import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { SegmentWizard } from "./SegmentWizard";

describe("SegmentWizard shell", () => {
  it("renders the wizard shell", () => {
    render(<SegmentWizard socket={{} as never} namespace="govee-smart.0" />);
    expect(screen.getByText(/segment/i)).toBeInTheDocument();
  });
});
