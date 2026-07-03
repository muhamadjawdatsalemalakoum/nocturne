import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import { App } from "./App";
// Blue Hour type system — bundled fully offline
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource-variable/martian-mono/index.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </StrictMode>,
);
