import { expect } from "chai";
import { getDefaultLanStates, mapCapabilities } from "../src/lib/capability-mapper";
import type { CloudCapability } from "../src/lib/types";

describe("CapabilityMapper", () => {
    describe("mapCapabilities", () => {
        it("should map on_off to boolean power state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.on_off",
                    instance: "powerSwitch",
                    parameters: { dataType: "ENUM", options: [{ name: "off", value: 0 }, { name: "on", value: 1 }] },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("power");
            expect(result[0].type).to.equal("boolean");
            expect(result[0].role).to.equal("switch");
            expect(result[0].write).to.be.true;
        });

        it("should map range brightness with min/max", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.range",
                    instance: "brightness",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 }, unit: "%" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("brightness");
            expect(result[0].type).to.equal("number");
            expect(result[0].role).to.equal("level.brightness");
            expect(result[0].min).to.equal(0);
            expect(result[0].max).to.equal(100);
        });

        it("should map colorRgb to string state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.color_setting",
                    instance: "colorRgb",
                    parameters: { dataType: "INTEGER", range: { min: 0, max: 16777215, precision: 1 } },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("colorRgb");
            expect(result[0].type).to.equal("string");
            expect(result[0].role).to.equal("level.color.rgb");
        });

        it("should map colorTemperatureK to number state", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.color_setting",
                    instance: "colorTemperatureK",
                    parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("colorTemperature");
            expect(result[0].min).to.equal(2000);
            expect(result[0].max).to.equal(9000);
            expect(result[0].unit).to.equal("K");
        });

        it("should map presetScene with dropdown states", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.mode",
                    instance: "presetScene",
                    parameters: {
                        dataType: "ENUM",
                        options: [
                            { name: "Sunset", value: 1 },
                            { name: "Rainbow", value: 2 },
                            { name: "Movie", value: 3 },
                        ],
                    },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal("scene");
            expect(result[0].states).to.deep.equal({ "1": "Sunset", "2": "Rainbow", "3": "Movie" });
            expect(result[0].write).to.be.true;
        });

        it("should map property as read-only", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.property",
                    instance: "sensorTemperature",
                    parameters: { dataType: "INTEGER", range: { min: -20, max: 60, precision: 1 }, unit: "°C" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].write).to.be.false;
            expect(result[0].role).to.equal("value.temperature");
        });

        it("should map toggle to boolean switch", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.toggle",
                    instance: "oscillationToggle",
                    parameters: { dataType: "ENUM", options: [{ name: "off", value: 0 }, { name: "on", value: 1 }] },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(1);
            expect(result[0].type).to.equal("boolean");
            expect(result[0].role).to.equal("switch");
        });

        it("should skip online capability", () => {
            const caps: CloudCapability[] = [
                {
                    type: "devices.capabilities.online",
                    instance: "online",
                    parameters: { dataType: "ENUM" },
                },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(0);
        });

        it("should handle multiple capabilities for a typical light", () => {
            const caps: CloudCapability[] = [
                { type: "devices.capabilities.on_off", instance: "powerSwitch", parameters: { dataType: "ENUM" } },
                { type: "devices.capabilities.range", instance: "brightness", parameters: { dataType: "INTEGER", range: { min: 0, max: 100, precision: 1 } } },
                { type: "devices.capabilities.color_setting", instance: "colorRgb", parameters: { dataType: "INTEGER" } },
                { type: "devices.capabilities.color_setting", instance: "colorTemperatureK", parameters: { dataType: "INTEGER", range: { min: 2000, max: 9000, precision: 1 } } },
                { type: "devices.capabilities.online", instance: "online", parameters: { dataType: "ENUM" } },
            ];

            const result = mapCapabilities(caps);
            expect(result).to.have.lengthOf(4);
            expect(result.map((r) => r.id)).to.deep.equal(["power", "brightness", "colorRgb", "colorTemperature"]);
        });
    });

    describe("getDefaultLanStates", () => {
        it("should return power, brightness, colorRgb, colorTemperature", () => {
            const defs = getDefaultLanStates();
            expect(defs).to.have.lengthOf(4);
            expect(defs.map((d) => d.id)).to.deep.equal(["power", "brightness", "colorRgb", "colorTemperature"]);
        });

        it("should have correct types and roles", () => {
            const defs = getDefaultLanStates();
            const power = defs.find((d) => d.id === "power")!;
            expect(power.type).to.equal("boolean");
            expect(power.role).to.equal("switch");
            expect(power.write).to.be.true;

            const brightness = defs.find((d) => d.id === "brightness")!;
            expect(brightness.type).to.equal("number");
            expect(brightness.role).to.equal("level.brightness");
            expect(brightness.min).to.equal(0);
            expect(brightness.max).to.equal(100);

            const color = defs.find((d) => d.id === "colorRgb")!;
            expect(color.type).to.equal("string");
            expect(color.role).to.equal("level.color.rgb");

            const temp = defs.find((d) => d.id === "colorTemperature")!;
            expect(temp.type).to.equal("number");
            expect(temp.min).to.equal(2000);
            expect(temp.max).to.equal(9000);
            expect(temp.unit).to.equal("K");
        });
    });
});
