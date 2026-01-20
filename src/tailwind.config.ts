import { radixColors, tailwindSafelist } from './app/styles/tailwind-colors';
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
darkMode: 'class',
safelist: [
    tailwindSafelist
  ],
  theme: {
    // OVERRIDE the base theme completely instead of extending it
    colors: {
      ...radixColors,
    }
  }
};
