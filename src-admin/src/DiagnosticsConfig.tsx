import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { DiagnosticsPanel } from "./DiagnosticsPanel";

/**
 * jsonConfig `type: custom` mount point for the diagnostics card. Same shape as
 * {@link SegmentWizardConfig}: the admin instantiates the exposed class and
 * drives it through `renderItem`, which hosts the plain panel wired to the
 * admin socket and this instance's namespace.
 */
export default class DiagnosticsConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    const namespace = `${ctx.adapterName}.${ctx.instance}`;
    return (
      <DiagnosticsPanel
        socket={ctx.socket}
        namespace={namespace}
      />
    );
  }
}
