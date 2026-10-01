import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_OVERRIDE_COMMANDS,
  DEVICE_STATUSES,
  DEVICE_TYPES,
  TRANSPORT_TARGETS,
  type DeviceQuirks,
} from "./device-catalog";
import { SEGMENT_COUNT_MAX } from "./device-manager/lookups";

/** Every quirk field of the interface — the compiler rejects a missing or an extra key. */
const QUIRK_FIELDS: Record<keyof DeviceQuirks, true> = {
  colorTempRange: true,
  segmentCount: true,
  brokenPlatformApi: true,
  transportOverrides: true,
  statusCmdVersion: true,
  platformTempUnit: true,
  ignoredCloudCapabilities: true,
};

interface SchemaNode {
  enum?: unknown[];
  maximum?: number;
  properties?: Record<string, SchemaNode>;
}

const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "devices.schema.json"), "utf-8")) as {
  definitions: { deviceEntry: SchemaNode; quirks: SchemaNode };
};
const entry = schema.definitions.deviceEntry.properties!;
const quirks = schema.definitions.quirks.properties!;

describe("device-catalog — the schema carries the same words as the code (audit S9)", () => {
  it("device types: the schema enum IS DEVICE_TYPES, word for word and in order", () => {
    expect(entry.type.enum).toEqual([...DEVICE_TYPES]);
  });

  it("trust tiers: the schema enum IS DEVICE_STATUSES", () => {
    expect(entry.status.enum).toEqual([...DEVICE_STATUSES]);
  });

  it("quirk fields: the schema offers exactly the fields DeviceQuirks declares", () => {
    expect(Object.keys(quirks).sort()).toEqual(Object.keys(QUIRK_FIELDS).sort());
  });

  it("transport overrides: the schema keys ARE the configurable commands, each with the transport targets", () => {
    const overrides = quirks.transportOverrides.properties!;
    expect(Object.keys(overrides)).toEqual([...CONFIGURABLE_OVERRIDE_COMMANDS]);
    for (const [cmd, node] of Object.entries(overrides)) {
      expect(node.enum, cmd).toEqual([...TRANSPORT_TARGETS]);
    }
  });

  it("the segmentCount quirk ends where the bitmask ends", () => {
    expect(quirks.segmentCount.maximum).toBe(SEGMENT_COUNT_MAX);
  });
});
