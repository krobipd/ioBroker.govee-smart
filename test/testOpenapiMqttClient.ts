import { expect } from "chai";
import { GoveeOpenapiMqttClient } from "../src/lib/govee-openapi-mqtt-client";

/**
 * Lifecycle tests for the OpenAPI-MQTT client (constructor + disconnect).
 *
 * Event-handling tests (`handleOpenApiEvent` on DeviceManager) follow in
 * session 6 once the device-manager learns to consume the event payload
 * and route it through the new events/ channel.
 */

const mockLog: ioBroker.Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
    level: "debug",
};

const mockTimers = {
    setInterval: () => undefined,
    clearInterval: () => {},
    setTimeout: () => undefined,
    clearTimeout: () => {},
};

describe("GoveeOpenapiMqttClient", () => {
    describe("constructor", () => {
        it("creates a client with the given API key", () => {
            const client = new GoveeOpenapiMqttClient(
                "test-api-key",
                mockLog,
                mockTimers as never,
            );
            expect(client).to.exist;
            expect(client.connected).to.be.false;
        });
    });

    describe("disconnect", () => {
        it("handles disconnect when not connected", () => {
            const client = new GoveeOpenapiMqttClient(
                "test-api-key",
                mockLog,
                mockTimers as never,
            );
            expect(() => client.disconnect()).to.not.throw();
        });

        it("leaves the connected flag false after disconnect", () => {
            const client = new GoveeOpenapiMqttClient(
                "test-api-key",
                mockLog,
                mockTimers as never,
            );
            client.disconnect();
            expect(client.connected).to.be.false;
        });
    });

    describe("session ID stability", () => {
        const UUID_RE =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

        it("generates a UUID-shaped session id once per instance", () => {
            const client = new GoveeOpenapiMqttClient(
                "test-api-key",
                mockLog,
                mockTimers as never,
            );
            const sid = (client as unknown as { sessionUuid: string })
                .sessionUuid;
            expect(sid).to.match(UUID_RE);
        });

        it("keeps the same session id for the lifetime of the instance", () => {
            const client = new GoveeOpenapiMqttClient(
                "test-api-key",
                mockLog,
                mockTimers as never,
            );
            const before = (client as unknown as { sessionUuid: string })
                .sessionUuid;
            // Simulate adapter activity that previously rotated the id
            client.disconnect();
            const after = (client as unknown as { sessionUuid: string })
                .sessionUuid;
            expect(after).to.equal(before);
        });

        it("uses a different session id per client instance", () => {
            const a = new GoveeOpenapiMqttClient(
                "k",
                mockLog,
                mockTimers as never,
            );
            const b = new GoveeOpenapiMqttClient(
                "k",
                mockLog,
                mockTimers as never,
            );
            const sa = (a as unknown as { sessionUuid: string }).sessionUuid;
            const sb = (b as unknown as { sessionUuid: string }).sessionUuid;
            expect(sa).to.not.equal(sb);
        });
    });
});
