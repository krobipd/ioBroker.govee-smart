import { httpsRequest } from "./http-client.js";

const APP_VERSION = "5.6.01";
const USER_AGENT =
  "GoveeHome/5.6.01 (com.ihoment.GoVeeSensor; build:2; iOS 16.5)";
const CLIENT_ID = "5a31302ebc5c4627b6fc3690c331c6f0";
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
}
