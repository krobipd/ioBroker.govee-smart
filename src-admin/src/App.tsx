// this file used only for simulation and not used in end build
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

import { SegmentWizard } from "./SegmentWizard";

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
            <div style={styles.item}>
              <SegmentWizard
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
