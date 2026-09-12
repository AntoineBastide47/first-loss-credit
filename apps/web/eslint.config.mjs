// Flat config (ESLint 9+/10). Replaces the legacy .eslintrc.json, which ESLint 10
// no longer reads. eslint-config-next/core-web-vitals ships a flat-config array.
import next from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: [".next/**", "node_modules/**"] },
  ...next,
];

export default config;
