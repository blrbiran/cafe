import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { start } from "./store.ts";
import { applyTheme, readTheme } from "./theme.ts";
import { ConnectorStatusProvider } from "./ui/ConnectorStatusPanel.tsx";

applyTheme(readTheme());
start();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectorStatusProvider>
      <App />
    </ConnectorStatusProvider>
  </StrictMode>,
);
