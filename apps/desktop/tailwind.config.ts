import { radixColors, tailwindSafelist } from './src/styles/tailwind-colors';
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
