import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0b1220', soft: '#131c2e' },
        surface: { DEFAULT: '#ffffff', muted: '#f6f7f9', sunk: '#eef0f4' },
        line: '#e2e5ea',
        brand: { DEFAULT: '#1f6feb', deep: '#0b4fc4' },
        inflow: '#0f8a5f',
        outflow: '#c02f43',
        warn: '#b45309',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
