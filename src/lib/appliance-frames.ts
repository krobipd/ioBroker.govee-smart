import { GOVEE_CAP_TYPE } from "./govee-constants";
import type { CapabilityOption, CloudStateCapability, GoveeDevice } from "./types";

/**
 * A 20-byte status frame from an appliance's own status push: `aa <fn> <sub>
 * <payload…> <xor>` — Govee's BLE notification format, relayed verbatim in
 * the account broker's `op.command`. The XOR over bytes 0–18 sits in byte 19;
 * measured on 794 of 794 `aa` frames of two H7127 exports (issue #47).
 */
interface Frame {
  fn: number;
  sub: number;
  bytes: Buffer;
}

function parseFrame(raw: unknown): Frame | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 20 || bytes[0] !== 0xaa) {
    return null;
  }
  let xor = 0;
  for (let i = 0; i < 19; i++) {
    xor ^= bytes[i];
  }
  if (xor !== bytes[19]) {
    return null;
  }
  return { fn: bytes[1], sub: bytes[2], bytes };
}

type FrameDecoder = (frames: Frame[], device: GoveeDevice) => CloudStateCapability[];

/**
 * The `workMode` STRUCT capability the device declared, if any.
 *
 * @param device The device whose declared capabilities are searched
 */
function declaredWorkMode(device: GoveeDevice): { modes: CapabilityOption[]; levels: CapabilityOption[] } | null {
  const cap = device.capabilities.find(c => c.type === GOVEE_CAP_TYPE.WORK_MODE && c.instance === "workMode");
  const fields = cap?.parameters?.fields ?? [];
  const modes = fields.find(f => f && f.fieldName === "workMode")?.options;
  const levels = fields.find(f => f && f.fieldName === "modeValue")?.options;
  return Array.isArray(modes) && Array.isArray(levels) ? { modes, levels } : null;
}

/**
 * H7127 air purifier (issue #47; spec §11). Measured frames:
 *   aa 05 00 <mode>                 work mode (declared option value)
 *   aa 05 01 <level>                last manual level (declared gearMode option value)
 *   aa 19 00 ff ff <aq> 00 <filter> filter life in % (byte 7 — two values against
 *                                   two references); byte 5 is probably air quality
 *                                   but was measured once and never seen changing,
 *                                   so it is NOT decoded — the cloud seed carries it.
 * The level is reported only for a mode that declares levels — the same shape
 * the cloud state read returns (`{workMode: 2, modeValue: 0}` for Custom).
 *
 * @param frames The checksum-valid frames of one status packet
 * @param device The device the packet belongs to (declared capabilities)
 */
const purifierH7127: FrameDecoder = (frames, device) => {
  const out: CloudStateCapability[] = [];
  const declared = declaredWorkMode(device);
  const modeFrame = frames.find(f => f.fn === 0x05 && f.sub === 0x00);
  const levelFrame = frames.find(f => f.fn === 0x05 && f.sub === 0x01);
  if (declared && modeFrame) {
    const mode = modeFrame.bytes[3];
    const modeOpt = declared.modes.find(o => o && o.value === mode);
    if (modeOpt) {
      const group = declared.levels.find(o => o && o.name === modeOpt.name && Array.isArray(o.options));
      let modeValue = 0;
      if (group && levelFrame) {
        const level = levelFrame.bytes[3];
        if (group.options!.some(o => o && o.value === level)) {
          modeValue = level;
        }
      }
      out.push({
        type: GOVEE_CAP_TYPE.WORK_MODE,
        instance: "workMode",
        state: { value: { workMode: mode, modeValue } },
      });
    }
  }
  const sensors = frames.find(f => f.fn === 0x19 && f.sub === 0x00);
  if (sensors) {
    const filter = sensors.bytes[7];
    if (filter <= 100 && device.capabilities.some(c => c.instance === "filterLifeTime")) {
      out.push({ type: GOVEE_CAP_TYPE.PROPERTY, instance: "filterLifeTime", state: { value: filter } });
    }
  }
  return out;
};

/** One decoder per measured device family. A SKU not listed here gets nothing from its push. */
const DECODERS: Readonly<Record<string, FrameDecoder>> = {
  H7127: purifierH7127,
};

/**
 * Decode an appliance's own status push into the capability shape the cloud
 * pipeline already understands (`applyCloudCapabilities`). Local first: the
 * device says what it does; the cloud read is only the seed at start.
 *
 * @param device    The device the packet belongs to
 * @param opCommand `op.command` of the status packet (base64 frames), unchecked
 */
export function decodeApplianceFrames(device: GoveeDevice, opCommand: unknown): CloudStateCapability[] {
  const decoder = DECODERS[device.sku];
  if (!decoder || !Array.isArray(opCommand)) {
    return [];
  }
  const frames = opCommand.map(parseFrame).filter((f): f is Frame => f !== null);
  return frames.length > 0 ? decoder(frames, device) : [];
}
