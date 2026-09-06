// Simulation shell (`npm --prefix src-admin run dev`). It is NOT the Module-
// Federation entry — that is Components.tsx — but it IS built: vite's default
// index.html entry pulls index.tsx -> App.tsx, and the whole build/ directory is
// copied into admin/custom/. Both files carried the line "not used in end build"
// for as long as they existed; editing App.tsx changes admin/custom/customComponents.js
// and the asset hashes next to it. ~10 KB of the shipped component is this shell.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

window.adapterName = "govee-smart";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App socket={{ port: 8081 }} />
    </React.StrictMode>,
  );
}
