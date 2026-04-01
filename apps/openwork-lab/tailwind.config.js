/** @type {import('tailwindcss').Config} */
const config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brandInk: "#011627",
        brandBlue: "#4f7cff",
        brandGlow: "#eef4ff",
      },
      boxShadow: {
        shell: "0 24px 60px -40px rgba(15, 23, 42, 0.18)",
        card: "0 18px 40px -34px rgba(15, 23, 42, 0.14)",
      },
    },
  },
  plugins: [],
};

export default config;
