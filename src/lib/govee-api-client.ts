import { httpsRequest } from "./http-client.js";
import {
  GOVEE_APP_VERSION,
  GOVEE_CLIENT_ID,
  GOVEE_CLIENT_TYPE,
  GOVEE_USER_AGENT,
} from "./govee-constants.js";

/**
 * Govee undocumented API client for scene/music/DIY libraries.
 * Uses the app2.govee.com endpoints that are separate from the official Cloud API.
 */
export class GoveeApiClient {
  private bearerToken: string | null = null;

  /**
   * Update the bearer token (obtained from MQTT login).
   *
   * @param token Bearer token string
   */
  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  /** Check if bearer token is available (set after MQTT login) */
  hasBearerToken(): boolean {
    return !!this.bearerToken;
  }

  /**
   * Fetch scene library for a specific SKU from undocumented API.
   * Public endpoint — no authentication required, only AppVersion header.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSceneLibrary(sku: string): Promise<
    {
      name: string;
      sceneCode: number;
      scenceParam?: string;
      speedInfo?: {
        supSpeed: boolean;
        speedIndex: number;
        config: string;
      };
    }[]
  > {
    const url = `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await httpsRequest<{
      data?: {
        categories?: Array<{
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceName?: string;
              scenceParam?: string;
              speedInfo?: {
                supSpeed?: boolean;
                speedIndex?: number;
                config?: string;
              };
            }>;
          }>;
        }>;
      };
    }>({
      method: "GET",
      url,
      headers: {
        appVersion: GOVEE_APP_VERSION,
        "User-Agent": GOVEE_USER_AGENT,
      },
    });

    const scenes: {
      name: string;
      sceneCode: number;
      scenceParam?: string;
      speedInfo?: { supSpeed: boolean; speedIndex: number; config: string };
    }[] = [];
    const categories = Array.isArray(resp?.data?.categories)
      ? resp.data.categories
      : [];
    for (const cat of categories) {
      const catScenes = Array.isArray(cat?.scenes) ? cat.scenes : [];
      for (const s of catScenes) {
        if (!s || typeof s.sceneName !== "string" || !s.sceneName) {
          continue;
        }
        const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
        if (effects.length === 0) {
          // No effects — use scene-level code
          const code = s.sceneCode ?? 0;
          if (code > 0) {
            scenes.push({ name: s.sceneName, sceneCode: code });
          }
          continue;
        }
        const multiVariant = effects.length > 1;
        for (const effect of effects) {
          const code = effect.sceneCode ?? s.sceneCode ?? 0;
          if (code <= 0) {
            continue;
          }
          const name =
            multiVariant && effect.scenceName
              ? `${s.sceneName}-${effect.scenceName}`
              : s.sceneName;
          const si = effect.speedInfo;
          scenes.push({
            name,
            sceneCode: code,
            scenceParam: effect.scenceParam || undefined,
            speedInfo: si?.supSpeed
              ? {
                  supSpeed: true,
                  speedIndex: si.speedIndex ?? 0,
                  config: si.config ?? "",
                }
              : undefined,
          });
        }
      }
    }

    return scenes;
  }

  /** Headers for authenticated undocumented API endpoints */
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      appVersion: GOVEE_APP_VERSION,
      clientId: GOVEE_CLIENT_ID,
      clientType: GOVEE_CLIENT_TYPE,
      "User-Agent": GOVEE_USER_AGENT,
    };
  }

  /**
   * Fetch music effect library for a specific SKU (requires auth).
   * Returns music modes with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchMusicLibrary(
    sku: string,
  ): Promise<
    { name: string; musicCode: number; scenceParam?: string; mode?: number }[]
  > {
    if (!this.bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/music-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await httpsRequest<{
      data?: {
        categories?: Array<{
          categoryName?: string;
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceParam?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });

    const modes: {
      name: string;
      musicCode: number;
      scenceParam?: string;
      mode?: number;
    }[] = [];
    let modeIdx = 0;
    const musicCats = Array.isArray(resp?.data?.categories)
      ? resp.data.categories
      : [];
    for (const cat of musicCats) {
      const catScenes = Array.isArray(cat?.scenes) ? cat.scenes : [];
      for (const s of catScenes) {
        if (!s || typeof s.sceneName !== "string" || !s.sceneName) {
          continue;
        }
        const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
        const effect = effects[0];
        const code = effect?.sceneCode ?? s.sceneCode ?? 0;
        if (code > 0) {
          modes.push({
            name: s.sceneName,
            musicCode: code,
            scenceParam: effect?.scenceParam || undefined,
            mode: modeIdx,
          });
        }
        modeIdx++;
      }
    }
    return modes;
  }

  /**
   * Fetch DIY light effect library for a specific SKU (requires auth).
   * Returns DIY scene definitions with BLE data for ptReal local control.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchDiyLibrary(
    sku: string,
  ): Promise<{ name: string; diyCode: number; scenceParam?: string }[]> {
    if (!this.bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/appsku/v1/diy-light-effect-libraries?sku=${encodeURIComponent(sku)}`;
    const resp = await httpsRequest<{
      data?: {
        categories?: Array<{
          scenes?: Array<{
            sceneName?: string;
            sceneCode?: number;
            lightEffects?: Array<{
              sceneCode?: number;
              scenceParam?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });

    const diys: { name: string; diyCode: number; scenceParam?: string }[] = [];
    const diyCats = Array.isArray(resp?.data?.categories)
      ? resp.data.categories
      : [];
    for (const cat of diyCats) {
      const catScenes = Array.isArray(cat?.scenes) ? cat.scenes : [];
      for (const s of catScenes) {
        if (!s || typeof s.sceneName !== "string" || !s.sceneName) {
          continue;
        }
        const effects = Array.isArray(s.lightEffects) ? s.lightEffects : [];
        const effect = effects[0];
        const code = effect?.sceneCode ?? s.sceneCode ?? 0;
        if (code > 0) {
          diys.push({
            name: s.sceneName,
            diyCode: code,
            scenceParam: effect?.scenceParam || undefined,
          });
        }
      }
    }
    return diys;
  }

  /**
   * Fetch supported features for a specific SKU (requires auth).
   * Returns feature flags indicating what the device supports.
   *
   * @param sku Product model (e.g. "H61BE")
   */
  async fetchSkuFeatures(sku: string): Promise<Record<string, unknown> | null> {
    if (!this.bearerToken) {
      return null;
    }
    const url = `https://app2.govee.com/appsku/v1/sku-supported-feature?sku=${encodeURIComponent(sku)}`;
    const resp = await httpsRequest<{
      data?: Record<string, unknown>;
    }>({ method: "GET", url, headers: this.authHeaders() });
    return resp.data ?? null;
  }

  /**
   * Fetch snapshot BLE commands for local activation via ptReal.
   * Each snapshot contains one or more cmds with Base64 BLE packets.
   *
   * @param sku Product model
   * @param deviceId Device identifier (colon-separated)
   */
  async fetchSnapshots(
    sku: string,
    deviceId: string,
  ): Promise<{ name: string; bleCmds: string[][] }[]> {
    if (!this.bearerToken) {
      return [];
    }
    const url = `https://app2.govee.com/bff-app/v1/devices/snapshots?sku=${encodeURIComponent(sku)}&device=${encodeURIComponent(deviceId)}&snapshotId=-1`;
    const resp = await httpsRequest<{
      data?: {
        snapshots?: Array<{
          name?: string;
          cmds?: Array<{
            bleCmds?: string;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });

    const results: { name: string; bleCmds: string[][] }[] = [];
    const snaps = Array.isArray(resp?.data?.snapshots)
      ? resp.data.snapshots
      : [];
    for (const snap of snaps) {
      if (!snap || typeof snap.name !== "string" || !snap.name) {
        continue;
      }
      const allCmdPackets: string[][] = [];
      const cmds = Array.isArray(snap.cmds) ? snap.cmds : [];
      for (const cmd of cmds) {
        if (!cmd || typeof cmd.bleCmds !== "string" || !cmd.bleCmds) {
          continue;
        }
        try {
          const parsed = JSON.parse(cmd.bleCmds) as { bleCmd?: string };
          if (typeof parsed?.bleCmd === "string" && parsed.bleCmd.length > 0) {
            allCmdPackets.push(parsed.bleCmd.split(","));
          }
        } catch {
          // skip malformed bleCmds JSON
        }
      }
      if (allCmdPackets.length > 0) {
        results.push({ name: snap.name, bleCmds: allCmdPackets });
      }
    }
    return results;
  }

  /**
   * Fetch group membership from undocumented exec-plat/home endpoint.
   * Returns groups with their member device references.
   */
  async fetchGroupMembers(): Promise<
    {
      groupId: number;
      name: string;
      devices: { sku: string; deviceId: string }[];
    }[]
  > {
    if (!this.bearerToken) {
      return [];
    }
    const url = "https://app2.govee.com/bff-app/v1/exec-plat/home";
    const resp = await httpsRequest<{
      data?: {
        components?: Array<{
          groups?: Array<{
            gId?: number;
            name?: string;
            devices?: Array<{
              sku?: string;
              device?: string;
            }>;
          }>;
        }>;
      };
    }>({ method: "GET", url, headers: this.authHeaders() });

    const groups: {
      groupId: number;
      name: string;
      devices: { sku: string; deviceId: string }[];
    }[] = [];
    const components = Array.isArray(resp?.data?.components)
      ? resp.data.components
      : [];
    for (const comp of components) {
      const compGroups = Array.isArray(comp?.groups) ? comp.groups : [];
      for (const g of compGroups) {
        if (!g || typeof g.gId !== "number") {
          continue;
        }
        const devices: { sku: string; deviceId: string }[] = [];
        const gDevices = Array.isArray(g.devices) ? g.devices : [];
        for (const d of gDevices) {
          if (
            d &&
            typeof d.sku === "string" &&
            typeof d.device === "string" &&
            d.sku &&
            d.device
          ) {
            devices.push({ sku: d.sku, deviceId: d.device });
          }
        }
        if (devices.length > 0) {
          groups.push({
            groupId: g.gId,
            name: typeof g.name === "string" ? g.name : "",
            devices,
          });
        }
      }
    }
    return groups;
  }
}
