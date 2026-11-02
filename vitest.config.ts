import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 各 package 的測試都放在自己的 src 旁，由根層統一執行
    // （.tsx 是 React 元件測試，環境在檔內以 docblock 指定）
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
