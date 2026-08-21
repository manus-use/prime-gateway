import { defineConfig } from 'vitest/config';

// Two projects, deliberately separate. A global `fileParallelism: false` added for a
// subprocess-heavy suite silently leaks onto every unit file and costs an order of
// magnitude in wall-clock. See docs/specs/2026-08-21-lark-channel-design.md §10.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          fileParallelism: true,
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/**/*.e2e.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
