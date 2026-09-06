import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeDocumentLocale } from "./locale";
import "./App.css";

initializeDocumentLocale();

// The widget is rendered in a transparent native window. Set an explicit
// route class before React mounts so older WebKit versions do not depend on
// the `:has()` selector to remove the main page's beige body background.
const route =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search);
const crownRoute = Boolean(route && route.get("crown") === "1");
const widgetRoute = Boolean(route && route.get("widget") === "1");
if ((widgetRoute || crownRoute) && typeof document !== "undefined") {
  document.documentElement.classList.add("widget-route");
  document.body.classList.add("widget-route");
  if (crownRoute) {
    document.documentElement.classList.add("crown-route");
    document.body.classList.add("crown-route");
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
