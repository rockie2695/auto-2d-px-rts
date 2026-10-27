import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))

interface LayerRule {
  /** 分層目錄名稱 */
  readonly layer: string
  /** 禁止的執行期 import 模組（`import type` 不算） */
  readonly forbid: readonly string[]
  /** 違反時顯示的原因 */
  readonly reason: string
}

/**
 * 規則 5：sim / render / ai / data / ui 完全分離，
 * sim 層不得 import PixiJS 或 React。
 */
const LAYER_RULES: readonly LayerRule[] = [
  {
    layer: 'sim',
    forbid: ['pixi.js', 'react', 'react-dom', 'zustand'],
    reason: '規則 5：模擬層不得 import PixiJS 或 React',
  },
  {
    layer: 'ai',
    forbid: ['pixi.js', 'react', 'react-dom', 'zustand'],
    reason: '規則 5：AI 層不得 import PixiJS 或 React',
  },
  {
    layer: 'data',
    forbid: ['pixi.js', 'react', 'react-dom', 'zustand'],
    reason: '規則 5：資料層不得 import PixiJS 或 React',
  },
  {
    layer: 'render',
    forbid: ['react', 'react-dom', 'zustand'],
    reason: 'render 必須是純 PixiJS，不得依賴 React',
  },
  {
    layer: 'ui',
    forbid: ['pixi.js'],
    reason: 'ui 只能透過 render 層的 API 操作 PixiJS',
  },
]

/** 只收 .ts / .tsx，測試檔同樣受規範約束。 */
function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath))
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * 取得原始碼中的「執行期」import 模組說明符。
 *
 * `import type` / `export type` 只存在於型別層，編譯後會被完全移除，
 * 因此不構成對該模組的執行期依賴，予以排除。
 */
function extractValueImportSpecifiers(source: string): string[] {
  const withoutTypeOnlyStatements = source
    .replace(/^\s*import\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*export\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')

  const specifiers = new Set<string>()

  for (const match of withoutTypeOnlyStatements.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.add(specifier)
  }
  // side-effect import：`import './styles.css'`
  for (const match of withoutTypeOnlyStatements.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.add(specifier)
  }

  return [...specifiers]
}

function isForbidden(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`)
}

function scanLayer(rule: LayerRule): string[] {
  const layerDir = join(SRC_DIR, rule.layer)
  if (!existsSync(layerDir)) return [`src/${rule.layer} 目錄不存在`]

  const violations: string[] = []
  for (const file of listSourceFiles(layerDir)) {
    const relativePath = file.slice(SRC_DIR.length).replaceAll('\\', '/')
    const source = readFileSync(file, 'utf8')
    for (const specifier of extractValueImportSpecifiers(source)) {
      if (rule.forbid.some((forbidden) => isForbidden(specifier, forbidden))) {
        violations.push(`${relativePath} import '${specifier}' — ${rule.reason}`)
      }
    }
  }
  return violations
}

describe('分層架構（規則 5）', () => {
  it('五個分層目錄都存在', () => {
    for (const { layer } of LAYER_RULES) {
      expect(existsSync(join(SRC_DIR, layer)), `缺少 src/${layer}`).toBe(true)
    }
  })

  for (const rule of LAYER_RULES) {
    it(`src/${rule.layer} 不得 import ${rule.forbid.join(', ')}`, () => {
      expect(scanLayer(rule)).toEqual([])
    })
  }
})
