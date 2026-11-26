// Tailwind runs through Next.js's built-in PostCSS pipeline. A custom Turbopack CSS loader left
// stale CSS in the build cache, so production shipped an old globals.css.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
