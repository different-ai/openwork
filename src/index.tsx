/* @refresh reload */
import { render } from "solid-js/web";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import App from "./app/app";

bootstrapTheme();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

render(() => <App />, root);
