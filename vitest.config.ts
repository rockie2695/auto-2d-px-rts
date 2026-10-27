import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 各 package 的測試都放在自己的 src 旁，由根層統一執行
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
