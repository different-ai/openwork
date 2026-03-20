/* @refresh reload */
import { render } from "solid-js/web";

import "../../app/src/app/index.css";
import { bootstrapTheme } from "../../app/src/app/theme";
import { initLocale } from "../../app/src/i18n";
import StoryBookApp from "./story-book";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

render(() => <StoryBookApp />, root);
