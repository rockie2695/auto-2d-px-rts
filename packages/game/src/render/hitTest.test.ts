import { describe, expect, it } from 'vitest'

import { UNITS_PER_TILE } from '../sim/types.ts'
import type { WorldSnapshot } from '../sim/world.ts'

import { pickBuilding, pickTarget, pickUnit, screenToWorld } from './hitTest.ts'
import { UNIT_RENDER_SIZE } from './constants.ts'

/**
 * 點擊拾取測試（Prompt 9 驗收：點單位看到資訊）。
 * 拾取與座標轉換是純計算，附合成的最小快照即可在 node 環境鎖定。
 */

/** 極小快照：只有單位陣列參與拾取。 */
function snapshotWith(units: Array<{ id: number; x: number; y: number }>): WorldSnapshot {
  return {
    tick: 0,
    rngState: 42,
    nextUnitId: 1,
    nextBuildingId: 1,
    players: [],
    units: units.map((unit) => ({
      ...unit,
      player: 'player',
      defId: 'legionnaire',
      hp: 100,
      attackAcc: 0,
      targetId: null,
      path: null,
    })),
    buildings: [],
    resourceNodes: [],
  }
}

describe('screenToWorld', () => {
  it('螢幕座標 − offset ÷ scale = 世界座標（縮放 2 倍）', () => {
    const world = screenToWorld(100, 60, { scale: 2, offsetX: 40, offsetY: 20, worldPx: 1024 })
    expect(world.x).toBe((100 - 40) / 2)
    expect(world.y).toBe((60 - 20) / 2)
  })

  it('偏移與縮放 1 倍時是恆等（減 0）', () => {
    const world = screenToWorld(123, 456, { scale: 1, offsetX: 0, offsetY: 0, worldPx: 1024 })
    expect(world.x).toBe(123)
    expect(world.y).toBe(456)
  })
})

describe('pickUnit（Prompt 9）', () => {
  const HALF = UNIT_RENDER_SIZE / 2
  /** 格 (8, 8) 中心：8×200 + 200/2 → px = 8×32 + 16 = 272。 */
  const PX = Math.round((8 * UNITS_PER_TILE + UNITS_PER_TILE / 2) / UNITS_PER_TILE * 32)

  it('點在單位顯示框內 → 命中該 id', () => {
    const snapshot = snapshotWith([{ id: 1, x: 8 * UNITS_PER_TILE + 100, y: 8 * UNITS_PER_TILE + 100 }])
    expect(pickUnit(snapshot, PX, PX)).toBe(1)
  })

  it('點在框外（半邊長 ±1px）→ 未命中', () => {
    const snapshot = snapshotWith([{ id: 1, x: 8 * UNITS_PER_TILE + 100, y: 8 * UNITS_PER_TILE + 100 }])
    expect(pickUnit(snapshot, PX + HALF + 1, PX)).toBeNull()
    expect(pickUnit(snapshot, PX, PX - HALF - 1)).toBeNull()
  })

  it('邊界正好在框上 → 命中（閉區間）', () => {
    const snapshot = snapshotWith([{ id: 1, x: 8 * UNITS_PER_TILE + 100, y: 8 * UNITS_PER_TILE + 100 }])
    expect(pickUnit(snapshot, PX + HALF, PX + HALF)).toBe(1)
  })

  it('多單位命中 → 取 id 最小者（確定性）', () => {
    const snapshot = snapshotWith([
      { id: 5, x: 8 * UNITS_PER_TILE + 100, y: 8 * UNITS_PER_TILE + 100 },
      { id: 2, x: 8 * UNITS_PER_TILE + 104, y: 8 * UNITS_PER_TILE + 104 },
    ])
    // 兩框重疊，點正中取較小 id。
    expect(pickUnit(snapshot, PX, PX)).toBe(2)
  })

  it('空白處點擊 → null', () => {
    const snapshot = snapshotWith([{ id: 1, x: 8 * UNITS_PER_TILE + 100, y: 8 * UNITS_PER_TILE + 100 }])
    expect(pickUnit(snapshot, 900, 900)).toBeNull()
  })
})

/* ---- Prompt 9.1：建築拾取 ---- */

/** 極小快照：建築陣列參與拾取（w/h 由 sizeOf 查表供給）。 */
function snapshotWithBuildings(
  buildings: Array<{ id: number; defId: string; x: number; y: number }>,
): WorldSnapshot {
  return {
    tick: 0,
    rngState: 42,
    nextUnitId: 1,
    nextBuildingId: 1,
    players: [],
    units: [],
    buildings: buildings.map((building) => ({
      ...building,
      player: 'player',
      hp: 500,
      builtTicks: 0,
      totalTicks: 0,
      damageTaken: 0,
      queue: [],
      nodeId: null,
      incomeAccMilli: 0,
    })),
    resourceNodes: [],
  }
}

/** keep 佔 2×2、barracks 佔 1×1（與真實內容尺寸一致）。 */
const SIZE_OF = (defId: string): { w: number; h: number } | null => {
  if (defId === 'keep') return { w: 2, h: 2 }
  if (defId === 'barracks') return { w: 1, h: 1 }
  return null
}

describe('pickBuilding（Prompt 9.1）', () => {
  /** keep 在格 (10,10)～(11,11)，世界 px = 320..384。 */
  const snapshot = snapshotWithBuildings([{ id: 1, defId: 'keep', x: 10, y: 10 }])

  it('點在佔地內 → 命中該建築 id', () => {
    expect(pickBuilding(snapshot, 336, 336, SIZE_OF)).toBe(1)
    expect(pickBuilding(snapshot, 383, 383, SIZE_OF)).toBe(1) // 右上格內
  })

  it('點在佔地外 → 未命中', () => {
    expect(pickBuilding(snapshot, 320 - 1, 336, SIZE_OF)).toBeNull()
    expect(pickBuilding(snapshot, 384, 336, SIZE_OF)).toBeNull() // 右緣開區間
    expect(pickBuilding(snapshot, 336, 384, SIZE_OF)).toBeNull() // 下緣開區間
  })

  it('點與建築框邊界：左上角閉區間命中', () => {
    expect(pickBuilding(snapshot, 320, 320, SIZE_OF)).toBe(1)
  })

  it('定義查不到（sizeOf 回 null）→ 跳過、不誤判', () => {
    const unknown = snapshotWithBuildings([{ id: 2, defId: 'mystery', x: 10, y: 10 }])
    expect(pickBuilding(unknown, 336, 336, SIZE_OF)).toBeNull()
  })

  it('重疊命中 → 取 id 最小者（確定性）', () => {
    const overlap = snapshotWithBuildings([
      { id: 9, defId: 'keep', x: 10, y: 10 },
      { id: 4, defId: 'barracks', x: 11, y: 11 }, // 落在 keep 的佔地一角
    ])
    // (360,360) 同時在 keep（320..384）與 barracks（352..384) 佔地內 → id 小者。
    expect(pickBuilding(overlap, 360, 360, SIZE_OF)).toBe(4)
    expect(pickBuilding(overlap, 330, 330, SIZE_OF)).toBe(9)
  })
})

describe('pickTarget（Prompt 9.1）', () => {
  it('單位與建築都被命中時 → 單位優先', () => {
    const snapshot = snapshotWithBuildings([{ id: 1, defId: 'keep', x: 10, y: 10 }])
    snapshot.units.push({
      id: 2,
      player: 'player',
      defId: 'legionnaire',
      hp: 100,
      // 站在 keep 佔地內（固定點 2100,2300 → px 336,368）。
      x: 10 * UNITS_PER_TILE + 100,
      y: 10 * UNITS_PER_TILE + 300,
      attackAcc: 0,
      targetId: null,
      path: null,
    })
    expect(pickTarget(snapshot, 336, 368, SIZE_OF)).toEqual({ kind: 'unit', id: 2 })
  })

  it('只命中建築 → building', () => {
    const snapshot = snapshotWithBuildings([{ id: 1, defId: 'keep', x: 10, y: 10 }])
    expect(pickTarget(snapshot, 336, 336, SIZE_OF)).toEqual({ kind: 'building', id: 1 })
  })

  it('空白處 → null（點空地取消選取）', () => {
    const snapshot = snapshotWithBuildings([{ id: 1, defId: 'keep', x: 10, y: 10 }])
    expect(pickTarget(snapshot, 900, 900, SIZE_OF)).toBeNull()
  })
})

