import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./tokens.css";
import "./app.css";
import PocketApp from "./pages/PocketApp";
import Store from "./pages/Store";
import { registerServiceWorker } from "./push";

registerServiceWorker();

/**
 * Mobile-first everywhere.
 *  /store       Stride Supply, the demo merchant (separate, unbranded site)
 *  everything   PayPal Pocket app: / (Home), /agents, /activity, /console (Black Box), /knows, /share
 */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/store" element={<Store />} />
        <Route path="/*" element={<PocketApp />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
