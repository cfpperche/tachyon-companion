/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{html,ts,tsx}",
    "../../packages/browser-ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--tc-font)"],
        mono: ["var(--tc-font-mono)"],
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: true,
  },
};
