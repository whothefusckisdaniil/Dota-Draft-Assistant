import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
    exclude: [...configDefaults.exclude, 'archive/**'],
  },
});
