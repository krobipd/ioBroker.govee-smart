import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => `${key}_resolved`),
  },
}));

import { resolveLabel, tDesc, tName } from "./i18n";

describe("tName", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tName("power");
    expect(result).toEqual({ en: "power", de: "power_de" });
  });
});

describe("tDesc", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tDesc("cloudSnapshotDesc");
    expect(result).toEqual({ en: "cloudSnapshotDesc", de: "cloudSnapshotDesc_de" });
  });
});

describe("resolveLabel", () => {
  it("delegates to I18n.translate", () => {
    const result = resolveLabel("deviceTierVerified");
    expect(result).toBe("deviceTierVerified_resolved");
  });
});

describe("i18n completeness", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const files = readdirSync(i18nDir).filter(f => f.endsWith(".json"));
  const keysets = files.map(f => ({
    lang: f.replace(".json", ""),
    keys: Object.keys(JSON.parse(readFileSync(join(i18nDir, f), "utf8"))),
  }));
  const enKeys = keysets.find(k => k.lang === "en")!.keys;

  it("all 11 languages have identical keysets", () => {
    expect(files).toHaveLength(11);
    const enKeysSorted = [...enKeys].sort();
    for (const { lang, keys } of keysets) {
      expect([...keys].sort(), `${lang} keyset mismatch`).toEqual(enKeysSorted);
    }
  });

  it("no empty values", () => {
    for (const f of files) {
      const lang = f.replace(".json", "");
      const data = JSON.parse(readFileSync(join(i18nDir, f), "utf8")) as Record<string, string>;
      for (const [key, val] of Object.entries(data)) {
        expect(val, `${lang}.${key} is empty`).not.toBe("");
      }
    }
  });

  // Placeholders ({name}, {idx}, %s, …) must be byte-identical across every
  // language: the wizard's format() / I18n positional substitution keys off the
  // English token, so a translated brace name (Google Translate turns {name} →
  // {nombre}) silently breaks interpolation. Guards against a future `npm run
  // translate` re-mangling them. See message-router.ts + segment-wizard.ts.
  it("placeholder tokens match en across all languages", () => {
    const tokens = (s: string): string[] => [...(s.match(/\{[^}]+\}|%s/g) ?? [])].sort();
    const en = JSON.parse(readFileSync(join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
    for (const f of files) {
      const lang = f.replace(".json", "");
      if (lang === "en") {
        continue;
      }
      const data = JSON.parse(readFileSync(join(i18nDir, f), "utf8")) as Record<string, string>;
      for (const key of Object.keys(en)) {
        expect(tokens(data[key] ?? ""), `${lang}.${key} placeholder drift`).toEqual(tokens(en[key]));
      }
    }
  });
});
