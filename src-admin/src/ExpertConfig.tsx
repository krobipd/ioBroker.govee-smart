import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { ExpertPanel } from "./ExpertPanel";

/**
 * jsonConfig `type: custom` mount point for the Expert tab. Must extend
 * {@link ConfigGeneric} — the admin instantiates the exposed class and drives
 * it through `renderItem` / `props.data` / `onChange`. `renderItem` hosts the
 * plain {@link ExpertPanel}, wired to the admin socket and this instance's
 * namespace.
 *
 * Replaces the separate segment-wizard and diagnostics mounts, which were
 * identical but for the component they rendered.
 */
export default class ExpertConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    const namespace = `${ctx.adapterName}.${ctx.instance}`;
    return (
      <ExpertPanel
        socket={ctx.socket}
        namespace={namespace}
      />
    );
  }
}
