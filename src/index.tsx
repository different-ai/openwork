/* @refresh reload */
import { render } from "solid-js/web";

import "./styles.css";
import App from "./App";

import { I18nProvider } from "./i18n";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

render(() => (
  <I18nProvider>
    <App />
  </I18nProvider>
), root);
