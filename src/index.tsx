/* @refresh reload */
import { render } from "solid-js/web";

import "./styles.css";
import App from "./App";
import { initLocale } from "./i18n";

// Initialize language preference from localStorage
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

render(() => <App />, root);
