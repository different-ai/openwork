/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
        nunito: ["var(--font-nunito)", "Nunito", "sans-serif"],
      },
      colors: {
        ink: "#111111",
        cream: {
          50: "#FDFBF9",
          100: "#F7F5F2",
          200: "#EAE5DC",
        },
        aika: {
          teal: "#00C8B4",
          "teal-hover": "#00B0A0",
          dark: "#0F0F14",
        },
      },
      animation: {
        "fade-in": "fadeIn 1s ease-out forwards",
        "slide-up": "slideUp 1s ease-out forwards",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
