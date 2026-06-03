import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {},
  },
  // Stage colour classes are composed in lib/stages.ts. Safelist guarantees
  // Tailwind ships them even if the content scan misses a permutation.
  safelist: [
    {
      pattern:
        /^(bg|text|border)-(sky|amber|violet|orange|emerald|teal|rose|pink|zinc)-(300|400|500|600|700)(\/(20|30))?$/,
    },
  ],
  plugins: [],
};

export default config;
