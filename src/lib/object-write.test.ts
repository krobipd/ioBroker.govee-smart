import { describe, expect, it, vi } from "vitest";
import { extendIfChanged, patchChangesNothing } from "./object-write";

describe("patchChangesNothing — what extendObject would merge vs. what is stored", () => {
  const stored = {
    type: "state",
    common: { name: { en: "Power", de: "Ein" }, role: "switch", write: true, states: { 0: "off", 1: "on" } },
    native: { capabilityInstance: "powerSwitch" },
  };

  it("a patch naming only values the object already holds changes nothing — key order does not matter", () => {
    expect(patchChangesNothing({ common: { name: { de: "Ein", en: "Power" }, role: "switch" } }, stored)).toBe(true);
    expect(patchChangesNothing({ type: "state", native: { capabilityInstance: "powerSwitch" } }, stored)).toBe(true);
  });

  it("a key the patch leaves undefined sets nothing", () => {
    expect(
      patchChangesNothing({ native: { capabilityInstance: "powerSwitch", capabilityType: undefined } }, stored),
    ).toBe(true);
  });

  it("a different value, a new key or another translation is a change", () => {
    expect(patchChangesNothing({ common: { role: "button" } }, stored)).toBe(false);
    expect(patchChangesNothing({ common: { unit: "%" } }, stored)).toBe(false);
    expect(patchChangesNothing({ common: { name: { en: "Power", de: "An" } } }, stored)).toBe(false);
  });

  it("a map compares key by key, and a null clears — a stored null takes it", () => {
    expect(patchChangesNothing({ common: { states: { 0: "off" } } }, stored)).toBe(true);
    expect(patchChangesNothing({ common: { states: { 2: "auto" } } }, stored)).toBe(false);
    expect(patchChangesNothing({ common: { desc: null } }, stored)).toBe(true);
    expect(patchChangesNothing({ common: { desc: null } }, { common: { desc: "x" } })).toBe(false);
  });

  it("an array compares whole — the key order of the objects in it does not matter", () => {
    expect(patchChangesNothing({ common: { list: [1, 2] } }, { common: { list: [1, 2] } })).toBe(true);
    expect(patchChangesNothing({ common: { list: [{ a: 1, b: 2 }] } }, { common: { list: [{ b: 2, a: 1 }] } })).toBe(
      true,
    );
    expect(patchChangesNothing({ common: { list: [1] } }, { common: { list: [1, 2] } })).toBe(false);
  });
});

describe("extendIfChanged", () => {
  it("writes a missing object, skips an unchanged one, writes a changed one", async () => {
    const store = new Map<string, unknown>();
    const adapter = {
      getObjectAsync: vi.fn((id: string) =>
        Promise.resolve(structuredClone((store.get(id) as ioBroker.Object) ?? null)),
      ),
      extendObject: vi.fn((id: string, patch: ioBroker.PartialObject) => {
        store.set(id, { ...(store.get(id) as object), ...patch });
        return Promise.resolve();
      }),
    };
    expect(await extendIfChanged(adapter, "a", { type: "channel", common: { name: "A" } })).toBe(true);
    expect(await extendIfChanged(adapter, "a", { type: "channel", common: { name: "A" } })).toBe(false);
    expect(await extendIfChanged(adapter, "a", { type: "channel", common: { name: "B" } })).toBe(true);
    expect(adapter.extendObject).toHaveBeenCalledTimes(2);
  });
});
