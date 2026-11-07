import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./tokens.css";
import "./app.css";
import PocketApp from "./pages/PocketApp";
import Store from "./pages/Store";

/**
 * Mobile-first everywhere.
 *  /store       Stride Supply, the demo merchant (separate, unbranded site)
 *  everything   PayPal Pocket app: / (Home), /rules, /activity, /console (Black Box)
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
