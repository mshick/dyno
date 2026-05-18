import { defineConfig, loadEnv } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const dirname = import.meta.dirname;

export default defineConfig(() => {
  return {
    plugins: [tsconfigPaths()],
    test: {
      globalSetup: ['vitest.global-setup.ts'],
      testTimeout: 15000,
      include: ['src/**/*.test.ts'],
      coverage: {
        include: ['src/**/*.{ts,js}'],
        exclude: ['src/**/__tests__/*'],
        provider: 'istanbul',
        reporter: ['text-summary', 'json'],
      },
      env: loadEnv('test', dirname, ''),
    },
  };
});
