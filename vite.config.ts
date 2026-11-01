import { defineConfig } from 'vitest/config';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
