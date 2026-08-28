import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // worker_threads instead of child_process forks: the DSH file sandbox
    // denies process spawn, while thread workers run fine.
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
  },
});
