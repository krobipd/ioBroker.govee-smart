// GV-27 — The segment wizard is a React component of its own (variant B), not built on dm-utils.
// krobi 2026-07-11 (note, no wording kept): "B (custom React, like public-holidays)"; approved 2026-10-08 09:39
/// <reference types="node" />
import type * as DeviceListModule from "../useDeviceList";
import * as fs from "node:fs";
import * as path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { I18n } from "@iobroker/gui-components";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enJson from "../i18n/en.json";

vi.mock("../useDeviceList", async importOriginal => ({
  ...(await importOriginal<typeof DeviceListModule>()),
  makeDeviceListApi: () => ({
    listDevices: () =>
      Promise.resolve([{ value: "H6160:AABB", label: "Strip Living", model: "H6160", online: true, segments: 10 }]),
  }),
}));

import ExpertConfig from "../ExpertConfig";

beforeEach(() => {
  I18n.extendTranslations(enJson, "en");
  I18n.setLanguage("en");
});

function readJson(...parts: string[]): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", ...parts), "utf-8")) as Record<string, unknown>;
}

describe("GV-27 the segment wizard is the adapter's own React component", () => {
  it("the Expert tab of the settings page mounts the adapter's own component, which opens on the segment wizard", async () => {
    const config = JSON.stringify(readJson("admin", "jsonConfig.json"));
    expect(config).toContain("ConfigCustomGoveeSegmentSet/Components/ExpertConfig");
    const props = {
      oContext: { adapterName: "govee-smart", instance: 0, socket: {}, themeType: "light", forceUpdate: () => {} },
      data: {},
      originalData: {},
      schema: { type: "custom" },
      attr: "_expert",
      onChange: () => {},
      onError: () => {},
      themeType: "light",
      alive: true,
    };
    render(<ExpertConfig {...(props as unknown as React.ComponentProps<typeof ExpertConfig>)} />);
    await waitFor(() => expect(screen.getByTestId("wiz-start")).toBeTruthy());
  });

  it("the adapter neither depends on dm-utils nor declares the device-manager message", () => {
    const pkg = readJson("package.json") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(packages.filter(n => n.includes("dm-utils"))).toEqual([]);
    // the same lookup sees what the adapter does depend on (positive control)
    expect(packages).toContain("@iobroker/adapter-core");
    const io = readJson("io-package.json") as {
      common?: { name?: string; supportedMessages?: Record<string, unknown> | null };
    };
    expect(io.common?.name).toBe("govee-smart");
    expect(io.common?.supportedMessages?.deviceManager).toBeUndefined();
  });
});
