import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { SegmentWizard } from "./SegmentWizard";

/**
 * jsonConfig `type: custom` mount point. Must extend {@link ConfigGeneric} — the
 * admin instantiates the exposed class and drives it through `renderItem` /
 * `props.data` / `onChange`. `renderItem` hosts the plain {@link SegmentWizard}
 * state machine, wired to the admin socket and this instance's namespace.
 */
export default class SegmentWizardConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    const namespace = `${ctx.adapterName}.${ctx.instance}`;
    return (
      <SegmentWizard
        socket={ctx.socket}
        namespace={namespace}
      />
    );
  }
}
