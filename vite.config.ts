import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { RESEARCH_TESTS } from './vitest.research.config';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  test: {
    // Retired item/build research (ТЗ №77) is kept for reference only and is
    // never part of the active test suite.
    // Frozen STRATZ research suites (FIX9–FIX17) pin the hashes of the
    // FIX-era public/data snapshot and generator, so every scheduled data
    // refresh would fail them and never be published. They run separately:
    // `npm run test:research`.
    exclude: [...configDefaults.exclude, 'archive/**', ...RESEARCH_TESTS],
  },
});
