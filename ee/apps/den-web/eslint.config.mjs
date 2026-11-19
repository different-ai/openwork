import parser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

// Keep this check focused on runtime hook order, not a broader style migration.
export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
