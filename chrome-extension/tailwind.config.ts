import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}", "./public/**/*.html"],
  theme: {
    extend: {
      colors: {
        glass: {
          900: "rgba(10, 10, 10, 0.65)",
          700: "rgba(17, 17, 17, 0.45)",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
