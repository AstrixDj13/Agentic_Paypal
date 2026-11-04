import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import "./tokens.css";
import "./app.css";
import PocketApp from "./pages/PocketApp";
import Console from "./pages/Console";
import Store from "./pages/Store";

/** Desktop pages get a top nav; the phone app is full-screen. */
function Shell() {
  const { pathname } = useLocation();
  const desktop = pathname.startsWith("/console") || pathname.startsWith("/store");
  return (
    <>
      {desktop && (
        <nav className="topnav">
          <span className="brand"><img src="/icon.svg" width={22} height={22} alt="" /> Agent Pocket + Black Box</span>
          <NavLink to="/">Pocket app</NavLink>
          <NavLink to="/console">Black Box console</NavLink>
          <NavLink to="/store">Stride Supply (demo store)</NavLink>
          <span className="spacer" />
          <span className="pill">PayPal sandbox</span>
        </nav>
      )}
      <Routes>
        <Route path="/" element={<PocketApp />} />
        <Route path="/console" element={<Console />} />
        <Route path="/store" element={<Store />} />
      </Routes>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </React.StrictMode>,
);
