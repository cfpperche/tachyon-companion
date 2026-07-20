/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{html,ts,tsx}",
    "../../packages/browser-ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Shell maps both sans + mono UI to Tachyon Mono; reading is separate.
        sans: ["var(--tc-font)"],
        mono: ["var(--tc-font-mono)"],
        reading: ["var(--tc-font-reading)"],
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: true,
  },
};
