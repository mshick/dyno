import { defineConfig, loadEnv } from 'vite';

export default defineConfig(() => {
  return {
    resolve: {
      tsconfigPaths: true,
    },
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
      env: loadEnv('test', import.meta.dirname, ''),
    },
  };
});
