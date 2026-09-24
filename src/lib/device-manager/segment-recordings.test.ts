import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { parseMqttSegmentData, resolveSegmentCountWithSource, segmentCountFromSnapshotFrames } from "./lookups";
import { DeviceManager } from "../device-manager";
import { DeviceRegistry } from "../device-registry";
import { mockLog, mockTimers } from "../test-helpers";
import type { CloudCapability, GoveeDevice } from "../types";

// Audit 2026-09-24 (H3/H5): the AA-A5 parser was written for five packets of
// four slots. The recordings below — every AA-A5 push in the user exports —
// show packets of three slots (H61A8, H7020, H6072), pushes of ten packets
// (H7020, H6062) and a trailing `(x,B,B,B)` filler slot (H6076, H6072). The
// app's own snapshot masks are the independent reference where they exist.
// Transactions and frames only — no device ids, names or topics.

/** AA-A5 pushes as recorded in user exports (Ressourcen/govee-smart/github-exports/), op.command verbatim. */
const AA_A5_RECORDINGS = [
  {
    source: "issue-13-diag-v2.9.1.json",
    sku: "H61A8",
    transaction: "v_1778661904232695",
    command: [
      "qgUVAAAAAAAAAAAAAAAAAAAAALo=",
      "qqUBZP9/AGT/fwBk/38AAAAAAOo=",
      "qqUCZP9/AGT/fwBk/38AAAAAAOk=",
      "qqUDZP9/AGT/fwBk/38AAAAAAOg=",
      "qqUEZP9/AGT/fwBk/38AAAAAAO8=",
      "qqUFZP9/AGT/fwBk/38AAAAAAO4=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhL/ZAAAgAoAAAAAAAAAAAAAAKk=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    ],
  },
  {
    source: "issue-43-h7020-diag.json.txt",
    sku: "H7020",
    transaction: "x_1786451934004",
    command: [
      "qgUVAAAAAAAAAAAAAAAAAAAAALo=",
      "qqUBZP9/AGT/AABk/9AAAAAAADo=",
      "qqUCZP9/AGT/aABk/wAAAAAAAIE=",
      "qqUDZP/QAGT/fwBk/2gAAAAAAFA=",
      "qqUEZP8AAGT/0ABk/38AAAAAAD8=",
      "qqUFZP9oAGT/AABk/9AAAAAAACk=",
      "qqUGZP8AAGT/AABk/wAAAAAAAJI=",
      "qqUHZP8AAGT/AABk/wAAAAAAAJM=",
      "qqUIZP8AAGT/AABk/wAAAAAAAJw=",
      "qqUJZP8AAGT/AABk/wAAAAAAAJ0=",
      "qqUKZP8AAGT/AABk/wAAAAAAAJ4=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhL/ZAAAgAoAAAAAAAAAAAAAAKk=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
      "qkEBAAAAAAAAAAAAAAAAAAAAAOo=",
      "qg8BAAAAAAAAAAAAAAAAAAAAAKQ=",
    ],
  },
  {
    source: "issue-21-H6072.txt",
    sku: "H6072",
    transaction: "x_1780949980931211",
    command: [
      "qgUVAQAAAAAAAAAAAAAAAAAAALs=",
      "qqUBMv//ADL//wAy//8AAAAAADw=",
      "qqUCMv//ADL//wAy//8AAAAAAD8=",
      "qqUDMv//ADL//wAAMjIyAAAAAD4=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhIAZAAAgAoAAAAAAAAAAAAAAFY=",
      "qiP/ARMtAAAXOwAAAACAAAAAgGU=",
      "qroBAWRkLgAAAAAAAAAAAAAAAD4=",
    ],
  },
  {
    source: "issue-44-h6076-diag.json.txt",
    sku: "H6076",
    transaction: "x_1786468651637049",
    command: [
      "qgUVAA50AAAAAAAAAAAAAAAAAMA=",
      "qqUBZP/OkmT/zpJk/86SZP/Okg4=",
      "qqUCZP/OkmT/zpJk/86SkmRkZDw=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhIAZAAAgAoAAAAAAAAAAAAAAFY=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    ],
  },
  {
    source: "issue-44-h6076-diag.json.txt",
    sku: "H6076",
    transaction: "a_1786476084066",
    command: [
      "qgUVAAwcAAAAAAAAAAAAAAAAAKo=",
      "qqUBZP+9b2T/vW9k/71vZP+9bw4=",
      "qqUCZP+9b2T/vW9k/71vAmRkZCI=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhIAZAAAgAoAAAAAAAAAAAAAAFY=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    ],
  },
  {
    source: "issue-24-H6076.txt",
    sku: "H6076",
    transaction: "a_1781021438855",
    command: [
      "qgUVAQAAAAAAAAAAAAAAAAAAALs=",
      "qqUBMv//ADL//wAy//8AMv//AA4=",
      "qqUCMv//ADL//wAy//8AADIyMg0=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhIAZAAAgAoAAAAAAAAAAAAAAFY=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    ],
  },
  {
    source: "issue-40-h1310-diag.json.txt",
    sku: "H1310",
    transaction: "x_1786451634001",
    command: [
      "qgUVAAAAAAAAAAAAAAAAAAAAALo=",
      "qqUBIP+yW2T/AABk/38AZP8AANw=",
      "qqUCZP9/AGT/AABk/38AZP8AAA0=",
      "qqUDZP9/AAAAAAAAAAAAAAAAAOg=",
      "qhEAAB4PDwD/MgAAAAAADw8DAGs=",
      "qhL/AGQAAIAKAP+uVAAAAAEDAK4=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
      "qkECAgAAAAAAAAAAAAAAAAAAAOs=",
      "qjYAAAAAAAAAAAAAAAAAAAAAAJw=",
      "qkIAAAAAAAAAAAAAAAAAAAAAAOg=",
      "qjEBAgEAAAAAAAAAAAAAAAAAAJk=",
    ],
  },
  {
    source: "issue-41-h61e5-diag.json.txt",
    sku: "H61E5",
    transaction: "a_1786451835656",
    command: [
      "qgUVAAAAAAAAAAAAAAAAAAAAALo=",
      "qqUBZP4VAGT+FQBk/hUAZP4VAA4=",
      "qqUCZP4VAGT+FQBk/hUAZP4VAA0=",
      "qqUDZP4VAAAAAAAAAAAAAAAAAIM=",
      "qhEAHg8PAP8yAAAAAAAAAAAAAGg=",
      "qhL/ZAAAgAoA/65UAAAAAAAAAKw=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
      "qkECAgAAAAAAAAAAAAAAAAAAAOs=",
    ],
  },
  {
    source: "issue-42-h6062-diag.json.txt",
    sku: "H6062",
    transaction: "x_1786451934003",
    command: [
      "qgUVAQAAAAAAAAAAAAAAAAAAALs=",
      "qqUBOv/hvDr/4bw6/+G8Ov/hvA4=",
      "qqUCOv/hvDr/4bw6/+G8Ov/hvA0=",
      "qqUDOv/hvDr/4bw6/+G8Ov/hvAw=",
      "qqUEOv/hvDr/4bw6/+G8Ov/hvAs=",
      "qqUFOv/hvDr/4bw6/+G8Ov/hvAo=",
      "qqUGOv/hvDr/4bw6/+G8Ov/hvAk=",
      "qqUHOv/hvDr/4bw6/+G8Ov/hvAg=",
      "qqUIZNnh/wAAAAAAAAAAAAAAAKQ=",
      "qqUJAAAAAAAAAAAAAAAAAAAAAAY=",
      "qqUKAAAAAAAAAAAAAAAAAAAAAAU=",
      "qkEAVBwAAAAAAAAAAAAAAAAAAKM=",
      "qhEAHg8PAAAAAAAAAAAAAAAAAKU=",
      "qhL/ZAAAgAoAAAAAAAAAAAAAAKk=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
    ],
  },
  {
    source: "issue-49-h1771-v2.21.0-2026-09-19.json",
    sku: "H1771",
    transaction: "x_1789813081071207",
    command: [
      "qgUVAAAAAAAAAAAAAAAAAAAAALo=",
      "qqUBZP///2SbIMxksxISRP///+o=",
      "qhEAHg8PAP8yAAAAAAAAAAAAAGg=",
      "qhL/ZAAAgAoA/65UAAAAAAAAAKw=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
      "qkECAAAAAAAAAAAAAAAAAAAAAOk=",
      "qjYBAQAAAAAAAAAAAAAAAAAAAJw=",
      "qvEAAAAAAAAAAAAAAAAAAAAAAFs=",
    ],
  },
  {
    source: "issue-49-h1771-v2.21.0-2026-09-19.json",
    sku: "H1771",
    transaction: "u_1789813084796227",
    command: ["qqUBZP///2SbIMxksxISRP///+o="],
  },
  {
    source: "issue-50-h1741-v2.39.2-2026-09-23.json",
    sku: "H1741",
    transaction: "y_1790140393852857",
    command: [
      "qgUVAAqMAAAAAAAAAAAAAAAAADw=",
      "qqUBZP+NC2T/jQtk/40LZP+NCw4=",
      "qqUCZP+NC2T/jQtk/40LZP+NCw0=",
      "qhEAHg8PAP8yAAAAAAAAAAAAAGg=",
      "qhL/ZAAAgAoA/65UAAAAAAAAAKw=",
      "qiP/AAAAgAAAAIAAAACAAAAAgHY=",
      "qkECAAAAAAAAAAAAAAAAAAAAAOk=",
      "qkIwAAAAAAAAAAAAAAAAAAAAANg=",
      "qvEAAAAAAAAAAAAAAAAAAAAAAFs=",
    ],
  },
] as const;
/** Snapshot BLE packets (`/bff-app/v1/devices/snapshots`) as recorded — names left out. */
const SNAPSHOT_RECORDINGS = {
  "issue-40-h1310-diag.json.txt": [
    [
      ["MwQGAAAAAAAAAAAAAAAAAAAAADE="],
      [
        "MwUVBAH/slv/AAD/fwD/AAAAALA=",
        "MwUVBAL/fwD/AAD/fwD/AAAAACU=",
        "MwUVBAP/fwAAAAAAAAAAAAAAAKQ=",
        "MwUVAwEgZGRkZGRkZGQAAAAAAAE=",
      ],
      [
        "MzYAAAAAAAAAAAAAAAAAAAAAAAU=",
        "MzYBAQAAAAAAAAAAAAAAAAAAAAU=",
        "MzEAAQAAAAAAAAAAAAAAAAAAAAM=",
        "MzECAQAAAAAAAAAAAAAAAAAAAAE=",
        "MzEBAgAAAAAAAAAAAAAAAAAAAAE=",
      ],
    ],
    [
      ["MwQnAAAAAAAAAAAAAAAAAAAAABA="],
      [
        "MwUVBAH/w3z/AAD/fwD/AAAAAOY=",
        "MwUVBAL/fwD/AAD/fwD/AAAAACU=",
        "MwUVBAP/fwAAAAAAAAAAAAAAAKQ=",
        "MwUVAwEgZGRkZGRkZGQAAAAAAAE=",
      ],
      [
        "MzYAAQAAAAAAAAAAAAAAAAAAAAQ=",
        "MzYBAQAAAAAAAAAAAAAAAAAAAAU=",
        "MzEAAQAAAAAAAAAAAAAAAAAAAAM=",
        "MzECAQAAAAAAAAAAAAAAAAAAAAE=",
        "MzEBAgAAAAAAAAAAAAAAAAAAAAE=",
      ],
    ],
  ],
  "issue-41-h61e5-diag.json.txt": [
    [["MwRkAAAAAAAAAAAAAAAAAAAAAFM="], ["MwUVAf///wwc/71v/wEAAAAAAB4=", "MwUVA2RkZGRkZGRkZAAAAAAAAEQ="]],
    [["MwQwAAAAAAAAAAAAAAAAAAAAAAc="], ["MwUVAf///wwc/71v/wEAAAAAAB4=", "MwUVA2RkZGRkZGRkZAAAAAAAAEQ="]],
    [["MwQSAAAAAAAAAAAAAAAAAAAAACU="], ["MwUVAf4VAAAAAAAA/wEAAAAAADc=", "MwUVA2RkZGRkZGRkZAAAAAAAAEQ="]],
    [
      ["MwQBAAAAAAAAAAAAAAAAAAAAADY="],
      ["MwUVAQEBAQAAAAAA/gEAAAAAANw=", "MwUVAf9GAAAAAAAAAQAAAAAAAJo=", "MwUVA2RkZGRkZGRkZAAAAAAAAEQ="],
    ],
    [
      ["MwQBAAAAAAAAAAAAAAAAAAAAADY="],
      ["MwUVAQEBAQAAAAAA/wAAAAAAANw=", "MwUVAf4yAAAAAAAAAAEAAAAAAO8=", "MwUVA2RkZGRkZGRkZAAAAAAAAEQ="],
    ],
    [
      ["MwQqAAAAAAAAAAAAAAAAAAAAAB0="],
      ["MwUVAf8qAAAAAAAAAQEAAAAAAPc=", "MwUVAf8BAAAAAAAA/gAAAAAAACI=", "MwUVAz0BAQEBAQEBPQAAAAAAACE="],
    ],
    [
      ["MwQqAAAAAAAAAAAAAAAAAAAAAB0="],
      [
        "MwUVAf8A+gAAAAAAOAAAAAAAAB8=",
        "MwUVAf8BeQAAAAAARAAAAAAAAOE=",
        "MwUVAf4IAAAAAAAAAQEAAAAAANQ=",
        "MwUVAf8AAAAAAAAAggAAAAAAAF8=",
        "MwUVAy0tAQEBAQEtLQAAAAAAACE=",
      ],
    ],
    [
      ["MwQqAAAAAAAAAAAAAAAAAAAAAB0="],
      [
        "MwUVAQD+FAAAAAAAAQEAAAAAAMg=",
        "MwUVAQD/SQAAAAAAggAAAAAAABY=",
        "MwUVAQH/zAAAAAAAfAAAAAAAAGw=",
        "MwUVA2RkZGRkZGRkZAAAAAAAAEQ=",
      ],
    ],
    [["MwQBAAAAAAAAAAAAAAAAAAAAADY="], ["MwUVAQEBAQAAAAAA/wEAAAAAAN0=", "MwUVAwEBAQEBAQEBAQAAAAAAACE="]],
    [["MwQMAAAAAAAAAAAAAAAAAAAAADs="], ["MwUVAf0nAAAAAAAA/wEAAAAAAAY=", "MwUVAwEBAQEBAQEBAQAAAAAAACE="]],
  ],
  "issue-44-h6076-diag.json.txt": [
    [["MwRkAAAAAAAAAAAAAAAAAAAAAFM="], ["M6MAAAAAAAAAAAAAAAAAAAAAAJA="], ["MwUVAf/XpgAAAAAAfwAAAAAAANM="]],
    [["MwQmAAAAAAAAAAAAAAAAAAAAABE="], ["M6MAAAAAAAAAAAAAAAAAAAAAAJA="], ["MwUVAf/TnAAAAAAAfwAAAAAAAO0="]],
    [["MwQDAAAAAAAAAAAAAAAAAAAAADQ="], ["M6MAAAAAAAAAAAAAAAAAAAAAAJA="], ["MwUVAf/fuAAAAAAAfwAAAAAAAMU="]],
    [["MwQmAAAAAAAAAAAAAAAAAAAAABE="], ["M6MAAAAAAAAAAAAAAAAAAAAAAJA="], ["MwUVAf/TnAAAAAAAfwAAAAAAAO0="]],
  ],
  "issue-50-h1741-v2.39.2-2026-09-23.json": [[["MwQmAAAAAAAAAAAAAAAAAAAAABE="], ["MwUVAQAAAAu4/7lp/wAAAAAAAEE="]]],
} as const;

function recording(source: string, transaction: string): string[] {
  const r = AA_A5_RECORDINGS.find(x => x.source === source && x.transaction.startsWith(transaction));
  if (!r) {
    throw new Error(`no recording ${source} ${transaction}`);
  }
  return [...r.command];
}

describe("parseMqttSegmentData — every AA-A5 recording", () => {
  // count = expected physical length; `ref` names the independent reference.
  const cases: Array<{ source: string; tx: string; sku: string; count: number; trailGuess: boolean; ref: string }> = [
    {
      source: "issue-13-diag-v2.9.1.json",
      tx: "v_",
      sku: "H61A8",
      count: 15,
      trailGuess: false,
      ref: "cloud 15; three slots × 5 packets",
    },
    {
      source: "issue-43-h7020-diag.json.txt",
      tx: "x_",
      sku: "H7020",
      count: 30,
      trailGuess: false,
      ref: "cloud elementRange 0-29",
    },
    {
      source: "issue-44-h6076-diag.json.txt",
      tx: "x_",
      sku: "H6076",
      count: 7,
      trailGuess: false,
      ref: "snapshot mask 7f",
    },
    {
      source: "issue-44-h6076-diag.json.txt",
      tx: "a_",
      sku: "H6076",
      count: 7,
      trailGuess: true,
      ref: "snapshot mask 7f",
    },
    { source: "issue-24-H6076.txt", tx: "a_", sku: "H6076", count: 7, trailGuess: true, ref: "same model as #44" },
    {
      source: "issue-40-h1310-diag.json.txt",
      tx: "x_",
      sku: "H1310",
      count: 9,
      trailGuess: false,
      ref: "four slots, last packet 1+empty",
    },
    {
      source: "issue-41-h61e5-diag.json.txt",
      tx: "a_",
      sku: "H61E5",
      count: 9,
      trailGuess: false,
      ref: "snapshot mask ff 01",
    },
    {
      source: "issue-50-h1741-v2.39.2-2026-09-23.json",
      tx: "y_",
      sku: "H1741",
      count: 8,
      trailGuess: false,
      ref: "snapshot mask ff 00",
    },
    {
      source: "issue-49-h1771-v2.21.0-2026-09-19.json",
      tx: "x_",
      sku: "H1771",
      count: 4,
      trailGuess: false,
      ref: "cloud 4",
    },
    // Not checked against an independent reference (no snapshot, cloud says 15):
    {
      source: "issue-42-h6062-diag.json.txt",
      tx: "x_",
      sku: "H6062",
      count: 29,
      trailGuess: false,
      ref: "none — parser reading",
    },
    { source: "issue-21-H6072.txt", tx: "x_", sku: "H6072", count: 8, trailGuess: true, ref: "none — parser reading" },
  ];
  for (const c of cases) {
    it(`${c.sku} ${c.tx} (${c.source}) → ${c.count} segments [${c.ref}]`, () => {
      const parsed = parseMqttSegmentData(recording(c.source, c.tx));
      const count = parsed.segments.reduce((m, s) => Math.max(m, s.index), -1) + 1;
      expect(count).toBe(c.count);
      expect(parsed.complete).toBe(true); // every one of these is a full status report
      expect(parsed.trailGuess).toBe(c.trailGuess);
    });
  }

  it("the three-slot layout indexes without holes — no black segment at every fourth index (H7020)", () => {
    const parsed = parseMqttSegmentData(recording("issue-43-h7020-diag.json.txt", "x_"));
    expect(parsed.segments.map(s => s.index)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(parsed.segments.every(s => s.brightness === 100)).toBe(true);
  });

  it("a lone A5 frame outside a status report is not complete (H1771 u_)", () => {
    const parsed = parseMqttSegmentData(recording("issue-49-h1771-v2.21.0-2026-09-19.json", "u_"));
    expect(parsed.segments).toHaveLength(4);
    expect(parsed.complete).toBe(false);
  });

  it("a report missing an A5 packet is not complete (gap in the numbering)", () => {
    const cmds = recording("issue-43-h7020-diag.json.txt", "x_");
    const withoutFourth = cmds.filter(
      c =>
        !Buffer.from(c, "base64")
          .subarray(0, 3)
          .equals(Buffer.from([0xaa, 0xa5, 4])),
    );
    expect(parseMqttSegmentData(withoutFourth).complete).toBe(false);
  });
});

describe("segmentCountFromSnapshotFrames — the app's snapshot masks", () => {
  it("reads the highest addressed segment of the 33 05 15 01 frames", () => {
    expect(segmentCountFromSnapshotFrames(SNAPSHOT_RECORDINGS["issue-44-h6076-diag.json.txt"])).toBe(7);
    expect(segmentCountFromSnapshotFrames(SNAPSHOT_RECORDINGS["issue-41-h61e5-diag.json.txt"])).toBe(9);
    expect(segmentCountFromSnapshotFrames(SNAPSHOT_RECORDINGS["issue-50-h1741-v2.39.2-2026-09-23.json"])).toBe(8);
  });

  it("answers null where no snapshot carries such a frame (the H1310 uses 03/04 frames of unknown layout)", () => {
    expect(segmentCountFromSnapshotFrames(SNAPSHOT_RECORDINGS["issue-40-h1310-diag.json.txt"])).toBeNull();
    expect(segmentCountFromSnapshotFrames(undefined)).toBeNull();
    expect(segmentCountFromSnapshotFrames([[["not base64 of 20 bytes"]]])).toBeNull();
  });
});

describe("DeviceManager — adopting the count of a recorded push (deleting needs knowledge)", () => {
  function segmentCaps(max: number): CloudCapability[] {
    return [
      {
        type: "devices.capabilities.segment_color_setting",
        instance: "segmentedColorRgb",
        parameters: {
          dataType: "STRUCT",
          fields: [{ fieldName: "segment", dataType: "Array", elementRange: { min: 0, max }, elementType: "INTEGER" }],
        },
      } as unknown as CloudCapability,
    ];
  }

  function setup(
    sku: string,
    opts: { learned?: number; caps?: number; snapshots?: string[][][] },
  ): { dm: DeviceManager; device: GoveeDevice; rebuilds: number[] } {
    const dm = new DeviceManager(mockLog, mockTimers, new DeviceRegistry({ data: { devices: {} } }));
    dm.handleLanDiscovery({ ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku });
    const device = dm.getDevices()[0];
    device.segmentCount = opts.learned;
    device.capabilities = opts.caps ? segmentCaps(opts.caps - 1) : [];
    device.snapshotBleCmds = opts.snapshots?.map((cmds, i) => ({ name: `snapshot ${i + 1}`, cmds }));
    const rebuilds: number[] = [];
    dm.onSegmentCountChanged = d => rebuilds.push(d.segmentCount ?? -1);
    dm.onMqttSegmentUpdate = () => {};
    return { dm, device, rebuilds };
  }

  const push = (dm: DeviceManager, sku: string, command: string[]): void =>
    dm.handleMqttStatus({ sku, device: "AABBCCDDEEFF0011", op: { command } });

  it("H7020 on a fresh installation: the push confirms the cloud's 30 — learned, nothing deleted", () => {
    // Until 2.39.2 the four-slot reading made this 19, and the "growth" from
    // the learned 0 rebuilt the tree without segments 19-29.
    const { dm, device, rebuilds } = setup("H7020", { caps: 30 });
    push(dm, "H7020", recording("issue-43-h7020-diag.json.txt", "x_"));
    expect(rebuilds).toEqual([]);
    expect(device.segmentCount).toBe(30);
  });

  it("H61A8 with the 19 an older version learned: a complete push corrects it to 15", () => {
    const { dm, rebuilds } = setup("H61A8", { learned: 19, caps: 15 });
    push(dm, "H61A8", recording("issue-13-diag-v2.9.1.json", "v_"));
    expect(rebuilds).toEqual([15]);
  });

  it("H6076: a count that rests on the trailing-slot rule lowers only with the snapshot masks", () => {
    const withMasks = setup("H6076", {
      learned: 8,
      caps: 15,
      snapshots: [...SNAPSHOT_RECORDINGS["issue-44-h6076-diag.json.txt"]] as unknown as string[][][],
    });
    push(withMasks.dm, "H6076", recording("issue-44-h6076-diag.json.txt", "a_"));
    expect(withMasks.rebuilds).toEqual([7]);

    const withoutMasks = setup("H6076", { learned: 8, caps: 15 });
    push(withoutMasks.dm, "H6076", recording("issue-44-h6076-diag.json.txt", "a_"));
    expect(withoutMasks.rebuilds).toEqual([]); // parked, not deleted
    // …and judged once the masks have loaded with the libraries.
    withoutMasks.device.snapshotBleCmds = (
      SNAPSHOT_RECORDINGS["issue-44-h6076-diag.json.txt"] as unknown as string[][][]
    ).map((cmds, i) => ({
      name: `snapshot ${i + 1}`,
      cmds,
    }));
    (withoutMasks.dm as unknown as { reviewDeferredSegmentShrink(d: GoveeDevice): void }).reviewDeferredSegmentShrink(
      withoutMasks.device,
    );
    expect(withoutMasks.rebuilds).toEqual([7]);
  });

  it("H6076: the x_ and the a_ push agree — no 7 ↔ 8 pendulum (#44)", () => {
    const { dm, device, rebuilds } = setup("H6076", { learned: 7, caps: 15 });
    push(dm, "H6076", recording("issue-44-h6076-diag.json.txt", "a_"));
    push(dm, "H6076", recording("issue-44-h6076-diag.json.txt", "x_"));
    push(dm, "H6076", recording("issue-24-H6076.txt", "a_"));
    expect(rebuilds).toEqual([]);
    expect(device.segmentCount).toBe(7);
  });

  it("H6072: a lower count on the trailing-slot rule without a reference stays where it is", () => {
    const { dm, device, rebuilds } = setup("H6072", { learned: 11, caps: 15 });
    push(dm, "H6072", recording("issue-21-H6072.txt", "x_"));
    expect(rebuilds).toEqual([]);
    expect(device.segmentCount).toBe(11);
  });

  it("a lone A5 frame never lowers a count (H1771 u_)", () => {
    const { dm, rebuilds } = setup("H1771", { learned: 6, caps: 6 });
    push(dm, "H1771", recording("issue-49-h1771-v2.21.0-2026-09-19.json", "u_"));
    expect(rebuilds).toEqual([]);
  });

  it("a push beyond what the cloud declared grows the tree (H6062: 29 > 15)", () => {
    const { dm, rebuilds } = setup("H6062", { caps: 15 });
    push(dm, "H6062", recording("issue-42-h6062-diag.json.txt", "x_"));
    expect(rebuilds).toEqual([29]);
  });
});

describe("resolveSegmentCountWithSource — the report names the source of THIS count (audit 2026-09-24 E7)", () => {
  const registryWith = (segmentCount: unknown): DeviceRegistry =>
    new DeviceRegistry({
      data: {
        devices: {
          H6076: { name: "x", type: "light", status: "verified", since: "2.0.0", quirks: { segmentCount } },
        },
      } as never,
      experimental: true,
    });
  const device = (over: Partial<GoveeDevice>): GoveeDevice =>
    ({ sku: "H6076", deviceId: "AA:BB", capabilities: [], ...over }) as GoveeDevice;

  it("an implausible quirk, an implausible learned value and a capability without range are not sources", () => {
    expect(resolveSegmentCountWithSource(device({}), registryWith(99))).toEqual({ count: 0, source: "none" });
    expect(resolveSegmentCountWithSource(device({ segmentCount: 80 }), registryWith(undefined))).toEqual({
      count: 0,
      source: "none",
    });
    const noRange = {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedColorRgb",
      parameters: { fields: [{ fieldName: "segment" }] },
    } as unknown as CloudCapability;
    expect(resolveSegmentCountWithSource(device({ capabilities: [noRange] }), registryWith(undefined))).toEqual({
      count: 0,
      source: "none",
    });
  });

  it("names quirk, learned value and capability in that order", () => {
    const cap = {
      type: "devices.capabilities.segment_color_setting",
      instance: "segmentedColorRgb",
      parameters: { fields: [{ fieldName: "segment", elementRange: { min: 0, max: 14 } }] },
    } as unknown as CloudCapability;
    expect(resolveSegmentCountWithSource(device({ capabilities: [cap] }), registryWith(undefined))).toEqual({
      count: 15,
      source: "cloudCapability",
    });
    expect(
      resolveSegmentCountWithSource(device({ capabilities: [cap], segmentCount: 7 }), registryWith(undefined)),
    ).toEqual({ count: 7, source: "learned" });
    expect(resolveSegmentCountWithSource(device({ capabilities: [cap], segmentCount: 7 }), registryWith(5))).toEqual({
      count: 5,
      source: "quirk",
    });
  });
});

describe("parseMqttSegmentData — edges of the rules", () => {
  function frame(bytes: number[]): string {
    const b = Buffer.alloc(20);
    bytes.forEach((v, i) => (b[i] = v));
    let xor = 0;
    for (let i = 0; i < 19; i++) {
      xor ^= b[i];
    }
    b[19] = xor;
    return b.toString("base64");
  }
  const seg = (br: number, r: number, g: number, b: number): number[] => [br, r, g, b];

  it("a real grey last segment (same brightness as its neighbour) is kept — only a filler with another brightness goes", () => {
    const a5 = frame([0xaa, 0xa5, 1, ...seg(100, 255, 0, 0), ...seg(100, 0, 255, 0), ...seg(100, 100, 100, 100)]);
    const parsed = parseMqttSegmentData([frame([0xaa, 0x05]), a5, frame([0xaa, 0x11])]);
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.trailGuess).toBe(false);
  });

  it("an `aa 41` frame closes a status report like `aa 11`", () => {
    const a5 = frame([
      0xaa,
      0xa5,
      1,
      ...seg(100, 1, 1, 1),
      ...seg(100, 2, 2, 2),
      ...seg(100, 3, 3, 3),
      ...seg(100, 4, 4, 4),
    ]);
    expect(parseMqttSegmentData([frame([0xaa, 0x05]), a5, frame([0xaa, 0x41])]).complete).toBe(true);
    expect(parseMqttSegmentData([frame([0xaa, 0x05]), a5]).complete).toBe(false);
    expect(parseMqttSegmentData([a5, frame([0xaa, 0x11])]).complete).toBe(false);
  });

  it("a repeated packet number is read once (SEC-GC1)", () => {
    const one = frame([
      0xaa,
      0xa5,
      1,
      ...seg(100, 1, 1, 1),
      ...seg(100, 2, 2, 2),
      ...seg(100, 3, 3, 3),
      ...seg(100, 4, 4, 4),
    ]);
    const other = frame([
      0xaa,
      0xa5,
      1,
      ...seg(50, 9, 9, 9),
      ...seg(50, 9, 9, 9),
      ...seg(50, 9, 9, 9),
      ...seg(50, 9, 9, 9),
    ]);
    const parsed = parseMqttSegmentData([one, other]);
    expect(parsed.segments).toHaveLength(4);
    expect(parsed.segments[0].r).toBe(1);
  });
});

describe("DeviceManager — a parked shrink whose masks disagree", () => {
  it("masks that name another count leave the tree alone", () => {
    const dm = new DeviceManager(mockLog, mockTimers, new DeviceRegistry({ data: { devices: {} } }));
    dm.handleLanDiscovery({ ip: "192.168.1.100", device: "AABBCCDDEEFF0011", sku: "H6076" });
    const device = dm.getDevices()[0];
    device.segmentCount = 8;
    const rebuilds: number[] = [];
    dm.onSegmentCountChanged = d => rebuilds.push(d.segmentCount ?? -1);
    dm.onMqttSegmentUpdate = () => {};
    dm.handleMqttStatus({
      sku: "H6076",
      device: "AABBCCDDEEFF0011",
      op: { command: recording("issue-44-h6076-diag.json.txt", "a_") },
    });
    // masks of an 8-segment light arrive
    device.snapshotBleCmds = (
      SNAPSHOT_RECORDINGS["issue-50-h1741-v2.39.2-2026-09-23.json"] as unknown as string[][][]
    ).map((cmds, i) => ({
      name: `snapshot ${i + 1}`,
      cmds,
    }));
    (dm as unknown as { reviewDeferredSegmentShrink(d: GoveeDevice): void }).reviewDeferredSegmentShrink(device);
    expect(rebuilds).toEqual([]);
    expect(device.segmentCount).toBe(8);
  });
});
