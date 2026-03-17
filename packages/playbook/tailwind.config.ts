import { radixColors, tailwindSafelist } from "../app/src/styles/tailwind-colors";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  safelist: [tailwindSafelist],
  theme: {
    colors: {
      ...radixColors,
      white: "#ffffff",
      black: "#000000",
    },
  },
};
