import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { ConnectionPanel } from "./ConnectionPanel";

/**
 * jsonConfig `type: custom` mount for the connection card. Unlike the
 * action-only SegmentWizard mount, this one is **value-owning**: it lifts the
 * four credential attributes out of `props.data` and writes each back through
 * `ConfigGeneric.onChange(attr, value)` — the same path native fields use, so
 * `encryptedNative` (apiKey/goveePassword/mqttVerificationCode) round-trips and
 * the admin Save button activates. Keeps no state of its own; the controlled
 * inputs live in the plain, jsdom-testable {@link ConnectionPanel}.
 */
export default class ConnectionConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    const namespace = `${ctx.adapterName}.${ctx.instance}`;
    const str = (attr: string): string => {
      const v = ConfigGeneric.getValue(this.props.data, attr);
      return typeof v === "string" ? v : "";
    };
    return (
      <ConnectionPanel
        socket={ctx.socket}
        namespace={namespace}
        values={{
          apiKey: str("apiKey"),
          email: str("goveeEmail"),
          password: str("goveePassword"),
          code: str("mqttVerificationCode"),
        }}
        onChange={(attr, value) => void this.onChange(attr, value)}
      />
    );
  }
}
