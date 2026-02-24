/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        aika: {
          teal: "#00C8B4",
          "teal-hover": "#00B0A0",
          dark: "#0F0F14",
        },
      },
    },
  },
  plugins: [],
};
