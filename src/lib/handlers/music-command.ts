// The music command: one STRUCT from the three music datapoints, over LAN where the light has a local API (mode
// only — the local packet carries no sensitivity or auto colour), otherwise over the Cloud. Its own module so the
// group fan-out and the state router share it without importing each other.
import { getMusicModeOptions, musicModeNameUsesRgb } from "../capability-mapper";
import type { DeviceManager } from "../device-manager";
import { GOVEE_CAP_TYPE } from "../govee-constants";
import type { GoveeLanClient } from "../govee-lan-client";
import { deviceLabel, hexToRgb, type GoveeDevice } from "../types";

/** The adapter surface the music command needs. */
export interface MusicCommandAdapter {
  readonly log: ioBroker.Logger;
  readonly namespace: string;
  readonly deviceManager: DeviceManager | null;
  readonly lanClient: GoveeLanClient | null;
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
}

/**
 * Build and send the music command from the written datapoint and its two siblings.
 *
 * @param adapter Adapter surface
 * @param device Target device
 * @param prefix The device's state-tree prefix
 * @param changedSuffix Which music datapoint the user wrote
 * @param newValue The written value
 * @returns true when a command went out (the caller acks the state)
 */
export async function sendMusicCommand(
  adapter: MusicCommandAdapter,
  device: GoveeDevice,
  prefix: string,
  changedSuffix: string,
  newValue: ioBroker.StateValue,
): Promise<boolean> {
  const musicBase = `${adapter.namespace}.${prefix}.music`;

  const modeState = await adapter.getStateAsync(`${musicBase}.music_mode`);
  const sensState = await adapter.getStateAsync(`${musicBase}.music_sensitivity`);
  const autoState = await adapter.getStateAsync(`${musicBase}.music_auto_color`);

  const selectedIndex =
    changedSuffix === "music.music_mode" ? parseInt(String(newValue), 10) : parseInt(String(modeState?.val ?? 0), 10);
  const sensitivity =
    changedSuffix === "music.music_sensitivity" ? (newValue as number) : ((sensState?.val as number) ?? 100);
  const autoColor = changedSuffix === "music.music_auto_color" ? (newValue ? 1 : 0) : autoState?.val ? 1 : 0;

  // Index 0 = the "---" sentinel = nothing selected. Gate the skip on the
  // INDEX, not the resolved device value: on a 0-based SKU index 1 resolves to
  // device value 0 (a real mode) which must NOT be swallowed here (A1).
  // The `<= 0` half has no test of its own on purpose: index 0 would resolve to
  // `options[-1]` → undefined → NaN and fall through the guard below anyway, so
  // dropping it only changes which debug line appears (equivalent mutant,
  // 2026-08-22 test audit). It stays because it names the intent.
  if (!Number.isFinite(selectedIndex) || selectedIndex <= 0) {
    adapter.log.debug("Music mode not selected, skipping command");
    return false;
  }

  // Resolve the dropdown index to the device's actual mode value through the
  // SAME option list the dropdown was built from (getMusicModeOptions), so the
  // index→value mapping can't drift: index N → options[N-1].value.
  const musicCap = device.capabilities.find(c => c.type === GOVEE_CAP_TYPE.MUSIC_SETTING && c.instance === "musicMode");
  const chosen = musicCap ? getMusicModeOptions(musicCap)[selectedIndex - 1] : undefined;
  const musicMode = chosen ? Number(chosen.value) : NaN;
  if (!Number.isFinite(musicMode)) {
    adapter.log.debug(`Music mode index ${selectedIndex} has no matching numeric option, skipping command`);
    return false;
  }

  if (device.lanIp && adapter.lanClient) {
    // The local music packet (33 05 01 <mode> [rgb]) carries no sensitivity /
    // auto-color fields, so those changes can't be applied over LAN. Warn
    // instead of silently re-sending just the mode and acking "ok" (A3) — the
    // music mode itself still works over LAN.
    if (changedSuffix === "music.music_sensitivity" || changedSuffix === "music.music_auto_color") {
      adapter.log.warn(
        `${deviceLabel(device)}: music sensitivity / auto-color can't be set over the local API — ` +
          `only the music mode applies for LAN-controlled lights.`,
      );
      return false;
    }
    let r = 0,
      g = 0,
      b = 0;
    // A2: which modes carry a custom RGB colour is keyed on the mode NAME
    // (Spectrum/Rolling), not the numeric value — Govee's music-mode values are
    // SKU-specific (A1: 0-based vs 1-based SKUs), so a value gate appended RGB
    // on the wrong mode for a non-standard-value SKU.
    const includeRgb = musicModeNameUsesRgb(chosen?.name);
    if (includeRgb) {
      const colorState = await adapter.getStateAsync(`${adapter.namespace}.${prefix}.control.color_rgb`);
      if (colorState?.val && typeof colorState.val === "string") {
        ({ r, g, b } = hexToRgb(colorState.val));
      }
    }
    // NOTE (A2 residual): the sub-mode BYTE is the raw capability value, which
    // equals the ptReal sub-mode on every SKU seen so far (0-3). A SKU that
    // reports music-mode values outside that range is untested — the byte may
    // then be wrong and needs hardware validation. The RGB gate above is
    // already name-correct regardless of the numbering.
    adapter.lanClient.setMusicMode(device.lanIp, musicMode, includeRgb, r, g, b);
    return true;
  }

  const structValue: Record<string, unknown> = {
    musicMode,
    sensitivity,
    autoColor,
  };

  await adapter.deviceManager!.sendCapabilityCommand(device, GOVEE_CAP_TYPE.MUSIC_SETTING, "musicMode", structValue);
  return true;
}
