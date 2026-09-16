import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        brand: {
          DEFAULT: "#2563eb",
          dark: "#1d4ed8",
          light: "#3b82f6",
        },
      },
      keyframes: {
        fadeSlideUp: {
          "0%": { opacity: "0", transform: "translate(-50%, 8px)" },
          "100%": { opacity: "1", transform: "translate(-50%, 0)" },
        },
      },
      animation: {
        fadeSlideUp: "fadeSlideUp 0.35s ease-out",
      },
    },
  },
  plugins: [],
};
export default config;
