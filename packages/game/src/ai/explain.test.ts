import { describe, expect, it } from 'vitest'

import { explainBuild, explainTrain } from './explain.ts'
import type { ExplainState } from './explain.ts'
import { DEFAULT_POLICIES, resolvePolicies } from './policy.ts'

/**
 * 解釋模板測試（Prompt 6.5）：
 * 規則式、無 LLM；輸出必須是含「理由：」的一行中文，
 * 且 topFactor 與文字出自同一條規則鏈。
 */

const baseState: ExplainState = {
  mineCount: 1,
  mineCap: 3,
  barracksCount: 1,
  barracksCap: 3,
  enemyMeleeCount: 0,
  enemyRangedCount: 0,
}

describe('explainBuild 模板', () => {
  it('零礦 → 強制確保基本收入', () => {
    const result = explainBuild(
      { defId: 'crystal_mine', kind: 'node' },
      DEFAULT_POLICIES,
      { ...baseState, mineCount: 0 },
    )
    expect(result.topFactor).toBe('forcedMine')
    expect(result.text).toBe('蓋 crystal_mine。理由：完全沒有礦場，強制確保基本收入')
  })

  it('econMilitary=1 → 偏經濟', () => {
    const result = explainBuild(
      { defId: 'crystal_mine', kind: 'node' },
      resolvePolicies({ econMilitary: 1 }),
      baseState,
    )
    expect(result.topFactor).toBe('econWeight')
    expect(result.text).toContain('econMilitary 偏經濟')
  })

  it('econMilitary=0 → 軍事建築偏軍事', () => {
    const result = explainBuild(
      { defId: 'barracks', kind: 'military' },
      resolvePolicies({ econMilitary: 0 }),
      baseState,
    )
    expect(result.topFactor).toBe('militaryWeight')
    expect(result.text).toContain('econMilitary 偏軍事')
  })

  it('預設值（雙權重相等）→ 飽和度因素', () => {
    const mine = explainBuild({ defId: 'crystal_mine', kind: 'node' }, DEFAULT_POLICIES, baseState)
    expect(mine.topFactor).toBe('saturation')
    expect(mine.text).toBe('蓋 crystal_mine。理由：礦場尚未飽和')

    const rax = explainBuild({ defId: 'barracks', kind: 'military' }, DEFAULT_POLICIES, baseState)
    expect(rax.topFactor).toBe('saturation')
    expect(rax.text).toBe('蓋 barracks。理由：軍事建築不足')
  })
})

describe('explainTrain 模板', () => {
  it('unitRange=1 + 敵方全近戰 + 遠程單位 → 疊加兩子句（範例句）', () => {
    const result = explainTrain('archer', resolvePolicies({ unitRange: 1 }), {
      ...baseState,
      unitRole: 'ranged',
      enemyMeleeCount: 4,
      enemyRangedCount: 0,
    })
    expect(result.text).toBe('生 archer。理由：unitRange 偏遠程且敵方近戰多')
    expect(result.topFactor).toBe('range')
  })

  it('unitRange=0 + 近戰單位 → 偏近戰', () => {
    const result = explainTrain('legionnaire', resolvePolicies({ unitRange: 0 }), {
      ...baseState,
      unitRole: 'melee',
    })
    expect(result.text).toBe('生 legionnaire。理由：unitRange 偏近戰')
    expect(result.topFactor).toBe('range')
  })

  it('unitSize=1 → 偏小型', () => {
    const result = explainTrain('legionnaire', resolvePolicies({ unitSize: 1 }), {
      ...baseState,
      unitRole: 'melee',
    })
    expect(result.text).toBe('生 legionnaire。理由：unitSize 偏小型')
    expect(result.topFactor).toBe('tier')
  })

  it('敵方遠程多 + 近戰單位 → 敵方遠程多', () => {
    const result = explainTrain('legionnaire', DEFAULT_POLICIES, {
      ...baseState,
      unitRole: 'melee',
      enemyMeleeCount: 1,
      enemyRangedCount: 3,
    })
    expect(result.text).toBe('生 legionnaire。理由：敵方遠程多')
    expect(result.topFactor).toBe('counter')
  })

  it('全中性（預設滑桿、無敵方單位）→ 稀缺性輪替句', () => {
    const result = explainTrain('legionnaire', DEFAULT_POLICIES, {
      ...baseState,
      unitRole: 'melee',
    })
    expect(result.topFactor).toBe('scarcity')
    expect(result.text).toBe('生 legionnaire。理由：候選分數接近，依稀缺性輪替生產')
  })

  it('僅 1 個可行候選 → 歸因可行性（而非分數接近）', () => {
    const result = explainTrain('legionnaire', DEFAULT_POLICIES, {
      ...baseState,
      unitRole: 'melee',
      candidateCount: 1,
    })
    expect(result.topFactor).toBe('feasibility')
    expect(result.text).toBe('生 legionnaire。理由：僅此單位可負擔且有產能，其他候選不可行')
  })

  it('所有輸出必含「理由：」且為單行非空字串', () => {
    const texts = [
      explainBuild({ defId: 'barracks', kind: 'military' }, DEFAULT_POLICIES, baseState).text,
      explainBuild({ defId: 'crystal_mine', kind: 'node' }, DEFAULT_POLICIES, baseState).text,
      explainTrain('archer', DEFAULT_POLICIES, { ...baseState, unitRole: 'ranged' }).text,
      explainTrain('legionnaire', resolvePolicies({ econMilitary: 1 }), {
        ...baseState,
        unitRole: 'melee',
      }).text,
    ]
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).toContain('理由：')
      expect(text).not.toContain('\n')
    }
  })
})
