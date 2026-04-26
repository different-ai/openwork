import { ReactNode, createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
};

export const ThemeProvider = ({ children, defaultTheme = "light" }: { children: ReactNode; defaultTheme?: Theme }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return defaultTheme;

    const saved = localStorage.getItem("theme") as Theme | null;
    return saved ?? defaultTheme;
  });
  const [mounted, setMounted] = useState(false);

  // Use useEffect with a timer to avoid synchronous setState in effect
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    // Save to localStorage whenever theme changes
    localStorage.setItem("theme", theme);

    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme, mounted]);

  const toggleTheme = () => {
    setTheme(prev => (prev === "light" ? "dark" : "light"));
  };

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, mounted }}>{children}</ThemeContext.Provider>;
};
