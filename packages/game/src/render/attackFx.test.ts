import { describe, expect, it } from 'vitest'

import { firedThisTick, towerVictimOf } from './attackFx.ts'
import { makeBuildingDef, makeUnitDef } from '../sim/testFixtures.ts'
import type { WorldDefs } from '../sim/types.ts'
import { UNITS_PER_TILE } from '../sim/types.ts'
import type { FxUnit } from './attackFx.ts'
import type { PlayerId } from '../sim/types.ts'

/**
 * 攻擊特效偵測測試（Prompt 10.24）：
 * - 開火判據：attackAcc 只在開火 tick 下降（持續交戰逐發可偵測）
 * - 塔的受害者：射程內最近敵方單位、平手取 id 小者（快照版 acquireBuildingTarget）
 */

const TOWER_DEF = makeBuildingDef({
  id: 'tower',
  size: [2, 2],
  defense: { dmg: 10, range: 4.0, attackSpeed: 0.5 },
})
const UNIT_DEF = makeUnitDef({ id: 'u' })
const DEFS: WorldDefs = {
  units: { u: UNIT_DEF },
  buildings: { tower: TOWER_DEF },
}

function unit(id: number, player: PlayerId, tileX: number, tileY: number, hp = 100): FxUnit {
  return {
    id,
    player,
    defId: 'u',
    hp,
    x: tileX * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    y: tileY * UNITS_PER_TILE + UNITS_PER_TILE / 2,
    attackAcc: 0,
    targetId: null,
    path: null,
    lastCombatTick: 0,
  }
}

describe('開火判據 firedThisTick（Prompt 10.24 修：持續交戰逐發偵測）', () => {
  it('開火 tick：attackAcc 下降 → true（0.95 → 0.0）', () => {
    expect(firedThisTick(0.95, 0)).toBe(true)
  })

  it('蓄力 tick：attackAcc 上升 → false（0.9 → 0.95）——舊判據 before ≥ 1 恆假', () => {
    expect(firedThisTick(0.9, 0.95)).toBe(false)
    expect(firedThisTick(0.05, 0.1)).toBe(false)
  })

  it('閒置封頂後首發（1.0 → 0.0）仍偵測得到', () => {
    expect(firedThisTick(1, 0)).toBe(true)
  })

  it('同值不誤報', () => {
    expect(firedThisTick(0.5, 0.5)).toBe(false)
    expect(firedThisTick(0, 0)).toBe(false)
  })
})

describe('塔的受害者 towerVictimOf（Prompt 10.24：快照版 acquireBuildingTarget）', () => {
  const tower = { defId: 'tower', player: 'enemy' as PlayerId, x: 10, y: 10, hp: 700 }

  it('射程內最近敵方單位；射程外不選', () => {
    // 塔佔地 (10..11, 10..11)，射程 4 格：外框 x ≥ 2000；(13,11) 距 300px ✓、(16,11) 距 900px ✗
    const near = unit(1, 'player', 13, 11)
    const far = unit(2, 'player', 16, 11)
    expect(towerVictimOf(DEFS, tower, [far, near])?.id).toBe(1)
    expect(towerVictimOf(DEFS, tower, [far])).toBeNull()
  })

  it('平手取先出現者（快照單位 id 升冪 ⟺ id 較小者）', () => {
    const left = unit(1, 'player', 8, 10)
    const right = unit(2, 'player', 13, 10) // 與 left 距塔外框等距（各 300px）
    expect(towerVictimOf(DEFS, tower, [left, right])?.id).toBe(1)
    // 同距但反序輸入 → 仍是 id 較小者（先出現者）
    expect(towerVictimOf(DEFS, tower, [right, left])?.id).toBe(1)
  })

  it('友軍與陣亡單位不選；hp 0 的塔沒有受害者', () => {
    const ally = unit(1, 'enemy', 13, 11)
    const dead = unit(2, 'player', 13, 11, 0)
    expect(towerVictimOf(DEFS, tower, [ally, dead])).toBeNull()
    expect(towerVictimOf(DEFS, { ...tower, hp: 0 }, [unit(3, 'player', 13, 11)])).toBeNull()
  })

  it('無 defense 的建築沒有受害者', () => {
    const defs: WorldDefs = {
      units: DEFS.units,
      buildings: { keep: makeBuildingDef({ id: 'keep', size: [3, 3] }) },
    }
    const keep = { defId: 'keep', player: 'enemy' as PlayerId, x: 10, y: 10, hp: 1000 }
    expect(towerVictimOf(defs, keep, [unit(1, 'player', 13, 11)])).toBeNull()
  })
})
