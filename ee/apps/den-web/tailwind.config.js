/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brandInk: "#161019",
        brandOrange: "#ef7b35",
        brandBlue: "#00a6fb"
      }
    }
  },
  plugins: []
};
