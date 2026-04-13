import { httpsRequest } from "./http-client.js";

const APP_VERSION = "7.3.30";
const USER_AGENT =
  "GoveeHome/7.3.30 (com.ihoment.GoVeeSensor; build:3; iOS 26.3.1) Alamofire/5.11.1";
const CLIENT_ID = "d39f7b0732a24e58acf771103ebefc04";
const CLIENT_TYPE = "1";

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
      headers: { appVersion: APP_VERSION, "User-Agent": USER_AGENT },
    });

    const scenes: {
      name: string;
      sceneCode: number;
      scenceParam?: string;
      speedInfo?: { supSpeed: boolean; speedIndex: number; config: string };
    }[] = [];
    for (const cat of resp.data?.categories ?? []) {
      for (const s of cat.scenes ?? []) {
        if (!s.sceneName) {
          continue;
        }
        // Use effect-level sceneCode (more reliable than scene-level)
        const effect = s.lightEffects?.[0];
        const code = effect?.sceneCode ?? s.sceneCode ?? 0;
        if (code > 0) {
          const si = effect?.speedInfo;
          scenes.push({
            name: s.sceneName,
            sceneCode: code,
            scenceParam: effect?.scenceParam || undefined,
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
      appVersion: APP_VERSION,
      clientId: CLIENT_ID,
      clientType: CLIENT_TYPE,
      "User-Agent": USER_AGENT,
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
    for (const cat of resp.data?.categories ?? []) {
      for (const s of cat.scenes ?? []) {
        if (!s.sceneName) {
          continue;
        }
        const effect = s.lightEffects?.[0];
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
    for (const cat of resp.data?.categories ?? []) {
      for (const s of cat.scenes ?? []) {
        if (!s.sceneName) {
          continue;
        }
        const effect = s.lightEffects?.[0];
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
    for (const comp of resp.data?.components ?? []) {
      for (const g of comp.groups ?? []) {
        if (g.gId == null) {
          continue;
        }
        const devices: { sku: string; deviceId: string }[] = [];
        for (const d of g.devices ?? []) {
          if (d.sku && d.device) {
            devices.push({ sku: d.sku, deviceId: d.device });
          }
        }
        if (devices.length > 0) {
          groups.push({ groupId: g.gId, name: g.name || "", devices });
        }
      }
    }
    return groups;
  }
}
