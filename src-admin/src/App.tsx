// Simulation shell (`npm --prefix src-admin run dev`). It is NOT the Module-
// Federation entry — that is Components.tsx — but it IS built: vite's default
// index.html entry pulls index.tsx -> App.tsx, and the whole build/ directory is
// copied into admin/custom/. Both files carried the line "not used in end build"
// for as long as they existed; editing App.tsx changes admin/custom/customComponents.js
// and the asset hashes next to it. ~10 KB of the shipped component is this shell.
import React from "react";
import { ThemeProvider, StyledEngineProvider } from "@mui/material/styles";

import { Box } from "@mui/material";

import {
  GenericApp,
  I18n,
  type IobTheme,
  Loader,
  type GenericAppProps,
  type GenericAppState,
} from "@iobroker/gui-components";

import { ConnectionPanel } from "./ConnectionPanel";
import { ExpertPanel } from "./ExpertPanel";

import enLocal from "./i18n/en.json";
import deLocal from "./i18n/de.json";

const styles: Record<string, any> = {
  app: (theme: IobTheme): React.CSSProperties => ({
    backgroundColor: theme.palette.background.default,
    color: theme.palette.text.primary,
    height: "100%",
  }),
  item: {
    padding: 50,
    width: 600,
  },
};

interface AppState extends GenericAppState {
  data: Record<string, any>;
  originalData: Record<string, any>;
}

class App extends GenericApp<GenericAppProps, AppState> {
  constructor(props: GenericAppProps) {
    const extendedProps = { ...props };
    super(props, extendedProps);

    this.state = {
      ...this.state,
      data: {},
      originalData: {},
      theme: this.createTheme(),
    };

    I18n.extendTranslations(enLocal, "en");
    I18n.extendTranslations(deLocal, "de");
    // @ts-expect-error userLanguage could exist
    const browserLang = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    I18n.setLanguage(browserLang.substring(0, 2));
  }

  render(): React.JSX.Element {
    if (!this.state.loaded) {
      return (
        <StyledEngineProvider injectFirst>
          <ThemeProvider theme={this.state.theme}>
            <Loader themeType={this.state.themeType} />
          </ThemeProvider>
        </StyledEngineProvider>
      );
    }

    return (
      <StyledEngineProvider injectFirst>
        <ThemeProvider theme={this.state.theme}>
          <Box sx={styles.app}>
            {/*
              Both mounts, because the adapter has two tabs. This shell used to
              render the segment wizard alone — the tab merge in 2.31.0 moved
              the wizard under the Expert panel next to the diagnostics card,
              and the Connection tab was never here at all, so the simulation
              could not reach the two cards a developer most needs to click.
            */}
            <div style={styles.item}>
              <ConnectionPanel
                socket={this.socket}
                namespace={`${this.adapterName}.${this.instance}`}
                values={{
                  apiKey: String(this.state.data.apiKey ?? ""),
                  email: String(this.state.data.goveeEmail ?? ""),
                  password: String(this.state.data.goveePassword ?? ""),
                  code: String(this.state.data.mqttVerificationCode ?? ""),
                }}
                onChange={(attr, value) => this.setState({ data: { ...this.state.data, [attr]: value } })}
              />
            </div>
            <div style={styles.item}>
              <ExpertPanel
                socket={this.socket}
                namespace={`${this.adapterName}.${this.instance}`}
              />
            </div>
          </Box>
        </ThemeProvider>
      </StyledEngineProvider>
    );
  }
}

export default App;
