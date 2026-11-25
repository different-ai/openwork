import type { ExampleService } from "../example-parts";
import { LINEAR } from "./connectors-example-data";

export const addExampleService: ExampleService = LINEAR;

export const addExampleChecks: ReadonlyArray<{ title: string; done: string }> = [
  { title: "Finds Linear", done: "Linear answered." },
  { title: "Knows how you sign in", done: "Each person signs in with Linear." },
  { title: "Signed in to Linear", done: "As ada@acme.com." },
  { title: "Has things your AI can do", done: "24 things, like search issues and create issue." },
];
