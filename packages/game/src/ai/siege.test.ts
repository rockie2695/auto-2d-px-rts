import { describe, expect, it } from 'vitest'

import { addBuilding } from '../sim/economy.ts'
import { createTestWorld, makeBuildingDef, makeUnitDef, putUnit } from '../sim/testFixtures.ts'
import { stepWorld } from '../sim/world.ts'
import { UNITS_PER_TILE } from '../sim/types.ts'
import type { PlayerId, World } from '../sim/types.ts'
import { MICRO_INTERVAL_TICKS, runMicroCycle } from './micro.ts'
import { resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { computeTacticalPlan, siegeApproachTile, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import type { TacticalPlan } from './tactics.ts'

/**
 * 攻城收尾（Prompt 10.18）回歸：
 * - **接近格必須在射程內**：舊版取「建築中心最近可走格」常是對角那格
 *   （距外框 ≈ 0.99 格 > 近戰 0.8 格）→ 部隊站定後 sim 打不到、微操也不再靠近
 *   → **攻城卡死**：即使敵方 0 單位也啃不掉主堡，戰局拖成平手。
 * - **無守軍的敵堡會被實際攻破**：全 AI（戰術＋微操）驅動下必須真的拆掉它。
 */

const MELEE = makeUnitDef({ id: 'u' }) // range 0.8、dmg 10、hp 100、moveSpeed 1.0
const KEEP = makeBuildingDef({ id: 'keep', size: [3, 3], hp: 400, ai: { value: 1000 } })

/** 逐步跑全 AI（戰術＋微操）直到 `keepId` 被毀或達 tick 上限；回傳實際 tick 數。 */
function runUntilKeepDown(
  world: World,
  policies: PolicyValues,
  keepId: number,
  maxTicks: number,
): number {
  const plans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  for (const player of world.players) plans[player.id] = computeTacticalPlan(world, player.id, policies)
  const keepHp = (): number => world.buildings.find((building) => building.id === keepId)?.hp ?? 0
  let tick = 0
  while (tick < maxTicks && keepHp() > 0) {
    stepWorld(world)
    tick += 1
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        plans[player.id] = computeTacticalPlan(world, player.id, policies, plans[player.id])
      }
    }
    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of world.players) runMicroCycle(world, player.id, plans[player.id])
    }
  }
  return tick
}

describe('攻城收尾（Prompt 10.18）', () => {
  it('接近格與建築佔地正交相鄰，且在近戰射程內（0.5 格 ≤ 0.8 格）', () => {
    const world = createTestWorld({ size: 24, units: [MELEE], buildings: [KEEP] })
    const keep = addBuilding(world, 'enemy', 'keep', { x: 10, y: 10 }, { built: true, nodeId: null })

    const tile = siegeApproachTile(world, 'player', keep, { x: 2, y: 2 })
    expect(tile).not.toBeNull()
    if (tile === null) return
    // 正交相鄰（恰在佔地外框外一格）。
    const onRing =
      tile.x === 9 || tile.x === 13 || tile.y === 9 || tile.y === 13
    expect(onRing).toBe(true)
    // 格心到外框最遠 0.71 格（對角）→ 近戰射程 0.8 格可及。
    const u = UNITS_PER_TILE
    const cx = tile.x * u + u / 2
    const cy = tile.y * u + u / 2
    const clampX = Math.min(Math.max(cx, 10 * u), (10 + 3) * u)
    const clampY = Math.min(Math.max(cy, 10 * u), (10 + 3) * u)
    const distTiles = Math.hypot(cx - clampX, cy - clampY) / u
    expect(distTiles).toBeLessThanOrEqual(0.8)
  })

  it('接近格鏡射對稱：紅方查詢結果＝藍方查詢結果的鏡像', () => {
    const world = createTestWorld({
      size: 24,
      units: [MELEE],
      buildings: [KEEP],
    })
    const blueKeep = addBuilding(world, 'enemy', 'keep', { x: 10, y: 10 }, { built: true, nodeId: null })
    const redKeep = addBuilding(world, 'player', 'keep', { x: 11, y: 11 }, { built: true, nodeId: null })
    const last = world.map.size - 1
    const blue = siegeApproachTile(world, 'player', blueKeep, { x: 4, y: 4 })
    const red = siegeApproachTile(world, 'enemy', redKeep, { x: last - 4, y: last - 4 })
    expect(blue).not.toBeNull()
    expect(red).toEqual({ x: last - (blue?.x ?? 0), y: last - (blue?.y ?? 0) })
  })

  it('敵方 0 單位 → 全軍出擊（不再半數守家看戲）', () => {
    const world = createTestWorld({ size: 24, units: [MELEE], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 1, y: 1 }, { built: true, nodeId: null })
    addBuilding(world, 'enemy', 'keep', { x: 19, y: 19 }, { built: true, nodeId: null })
    for (const tile of [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }]) {
      putUnit(world, 'player', 'u', tile)
    }
    // 即使 aggression 0（極度保守）——敵方無兵即無守可言 → 全部攻擊。
    const plan = computeTacticalPlan(world, 'player', resolvePolicies({ aggression: 0 }))
    expect(plan.squads.length).toBeGreaterThan(0)
    expect(plan.squads.every((squad) => squad.mission === 'attack' || squad.mission === 'harass')).toBe(
      true,
    )
    for (const squad of plan.squads) {
      expect(squad.targetBuildingId).not.toBeNull()
    }
  })

  it('無守軍的敵堡會被全 AI 實際攻破（不再停在射程外卡死拖平手）', () => {
    const world = createTestWorld({ size: 24, units: [MELEE], buildings: [KEEP] })
    addBuilding(world, 'player', 'keep', { x: 1, y: 1 }, { built: true, nodeId: null })
    const enemyKeep = addBuilding(world, 'enemy', 'keep', { x: 18, y: 18 }, { built: true, nodeId: null })
    for (const tile of [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }]) {
      putUnit(world, 'player', 'u', tile)
    }

    const ticks = runUntilKeepDown(world, resolvePolicies({ aggression: 0 }), enemyKeep.id, 3000)

    const keep = world.buildings.find((building) => building.id === enemyKeep.id)
    expect(keep?.hp ?? 0).toBeLessThanOrEqual(0) // 真的拆掉了
    expect(ticks).toBeLessThan(3000)
  })
})
