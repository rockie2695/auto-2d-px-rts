import { describe, expect, it, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'

import { MICRO_INTERVAL_TICKS, runMicroCycle } from '../ai/micro.ts'
import { DEFAULT_POLICIES } from '../ai/policy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from '../ai/tactics.ts'
import type { TacticalPlan } from '../ai/tactics.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from '../ai/strategy.ts'
import { matchEnded, resolveMatchResult } from '../session.ts'
import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { createWorld, stepWorld } from '../sim/world.ts'
import type { ContentPack } from '@auto-2d-px-rts/shared'
import type { World } from '../sim/types.ts'
import type { MatchResult } from '../replay.ts'

/**
 * 公平性對戰序列測試（Prompt 10.14）。
 *
 * 「公平」= 沒有哪個陣營會**系統性**獲勝。單場對局（特別是固定種子）資訊量為零，
 * 必須用**多個種子的完整對局**做成統計檢驗：
 *
 * 1. **確定性**：同種子重跑兩次 → 逐字相同的結局摘要；
 * 2. **種子活化**：不同種子必須真的走出不同對局（結果簽名 ≥ 3 種）——
 *    若 hashFate／命運抽籤不再吃種子，這裡會明顯退化成少數幾種對局；
 * 3. **不一邊倒**：12 種子全戰任一方勝場 ≤ 9；
 * 4. **交戰健全性**：每場對局**雙方**都實際造成傷害（模擬層自動接戰的長期閘門）。
 *
 * 完整對局（最多 12000 tick）單場 < 1 秒，12 場總計約 10 秒。
 */

/** 單場完整對局的結局摘要（JSON 相容，用逐字比對驗證確定性）。 */
interface MatchSummary {
  seed: number
  result: MatchResult
  ticks: number
  blueUnits: number
  redUnits: number
  blueHp: number
  redHp: number
  crystal: number
  redCrystal: number
  blueBuildings: number
  redBuildings: number
  /** 雙方各自造成的總傷害（> 0 = 該方確實交戰過）。 */
  blueDealt: number
  redDealt: number
}

const FAIR_SEEDS = [42, 1, 7, 123, 999, 31337, 555, 2024, 777, 314159, 271828, 8675309] as const
/** 任一方不可超過的勝場上限（12 場；基準量測大致 5–7 勝，9 給統計波動留餘裕）。 */
const MAX_WINS_PER_SIDE = 9

let content: ContentPack

beforeAll(() => {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  content = loadContentPackFromDir(dataDir)
})

/** 跑一場完整對局（全 AI 三層、走到分出勝負或 12000 tick 上限）。 */
function runMatch(seed: number): MatchSummary {
  const world = createWorld(content, seed)
  const policies = { player: DEFAULT_POLICIES, enemy: DEFAULT_POLICIES }
  const plans: Record<'player' | 'enemy', TacticalPlan | null> = { player: null, enemy: null }
  // 交戰健全性量測：`blueDealt` = 藍方造成的總傷害、`redDealt` = 紅方造成的總傷害。
  const dealt = { blue: 0, red: 0 }
  const prevUnitHp: Record<'player' | 'enemy', Map<number, number>> = {
    player: new Map(),
    enemy: new Map(),
  }
  const prevBuildingDamage: Record<'player' | 'enemy', number> = { player: 0, enemy: 0 }

  while (world.tick < world.match.maxTicks && !matchEnded(world)) {
    stepWorld(world)
    dealt.blue += damageDealtAgainst(world, 'enemy', prevUnitHp.enemy, prevBuildingDamage, 'enemy')
    dealt.red += damageDealtAgainst(world, 'player', prevUnitHp.player, prevBuildingDamage, 'player')
    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) runStrategicCycle(world, player.id, policies[player.id])
    }
    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) plans[player.id] = computeTacticalPlan(world, player.id, policies[player.id])
    }
    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      for (const player of world.players) runMicroCycle(world, player.id, plans[player.id])
    }
  }
  const result = resolveMatchResult(world)
  const unitsOf = (id: 'player' | 'enemy') => world.units.filter((unit) => unit.player === id)
  const crystalsOf = (id: 'player' | 'enemy') =>
    world.players.find((player) => player.id === id)?.resources.blue_crystal ?? -1
  return {
    seed,
    result,
    ticks: world.tick,
    blueUnits: unitsOf('player').length,
    redUnits: unitsOf('enemy').length,
    blueHp: unitsOf('player').reduce((total, unit) => total + unit.hp, 0),
    redHp: unitsOf('enemy').reduce((total, unit) => total + unit.hp, 0),
    crystal: crystalsOf('player'),
    redCrystal: crystalsOf('enemy'),
    blueBuildings: world.buildings.filter((building) => building.player === 'player').length,
    redBuildings: world.buildings.filter((building) => building.player === 'enemy').length,
    blueDealt: dealt.blue,
    redDealt: dealt.red,
  }
}

/**
 * 計算本 tick `victimSide` 受到的傷害並累積在 `dealt` 命名空間：
 * - 單位：逐單位比對前 tick hp（本 tick 消失 = 扣到 0，也算傷害）；新生單位不計；
 * - 建築：`damageTaken` 是自開場以來的累計量 → 以兩次總量差累計。
 * 之後更新 `prevUnitHp`（以 victimSide 最新 hp 重建）與 `prevBuildingDamage`。
 */
function damageDealtAgainst(
  world: World,
  victimSide: 'player' | 'enemy',
  prevUnitHp: Map<number, number>,
  prevBuildingDamage: Record<'player' | 'enemy', number>,
  key: 'player' | 'enemy',
): number {
  let delta = 0
  const currentHp = new Map<number, number>()
  for (const unit of world.units) {
    if (unit.player !== victimSide) continue
    currentHp.set(unit.id, unit.hp)
    const prev = prevUnitHp.get(unit.id)
    if (prev !== undefined && unit.hp < prev) delta += prev - unit.hp
  }
  for (const [id, hp] of prevUnitHp) {
    if (!currentHp.has(id) && hp > 0) delta += hp // 上一 tick 存在、本 tick 陣亡
  }
  prevUnitHp.clear()
  for (const [id, hp] of currentHp) prevUnitHp.set(id, hp)

  let buildingDamage = 0
  for (const building of world.buildings) {
    if (building.player !== victimSide) continue
    buildingDamage += building.damageTaken
  }
  delta += buildingDamage - prevBuildingDamage[key]
  prevBuildingDamage[key] = buildingDamage
  return Math.max(0, delta)
}

describe('公平性對戰序列（12 種子、完整對局）', () => {
  const summaries: MatchSummary[] = []
  it('跑完全部種子的即時摘要', { timeout: 120_000 }, () => {
    for (const seed of FAIR_SEEDS) summaries.push(runMatch(seed))
    // 先決條件：每場都真的結束。
    expect(summaries.every((summary) => summary.ticks > 0)).toBe(true)
    // 基準紀錄（供故障時診斷）。
    console.log(
      summaries
        .map((summary) => `seed=${summary.seed} ${summary.result} t=${summary.ticks} dealt ${summary.blueDealt}/${summary.redDealt}`)
        .join('\n'),
    )
  })

  it('每場對局雙方都實際造成傷害（交戰健全性）', () => {
    expect(summaries.length).toBe(FAIR_SEEDS.length)
    for (const summary of summaries) {
      expect(summary.blueDealt).toBeGreaterThan(0)
      expect(summary.redDealt).toBeGreaterThan(0)
    }
  })

  it('同種子重跑兩次 → 逐字相同的結局摘要（確定性）', { timeout: 60_000 }, () => {
    const first = summaries[0]
    if (first === undefined) throw new Error('公平性摘要尚未建立（種子對局測試未先跑）')
    const again = runMatch(FAIR_SEEDS[0] ?? 42)
    const strip = (summary: MatchSummary): string =>
      JSON.stringify([summary.result, summary.ticks, summary.blueHp, summary.redHp, summary.blueUnits, summary.redUnits,
        summary.blueBuildings, summary.redBuildings, summary.blueDealt, summary.redDealt])
    expect(strip(again)).toBe(strip(first))
  })

  it('跨種子 → 對局多樣性：至少 3 種不同的結果簽名（種子活化）', () => {
    const signatures = new Set(
      summaries.map((summary) =>
        JSON.stringify([summary.result, summary.ticks, summary.blueHp, summary.redHp]),
      ),
    )
    expect(signatures.size).toBeGreaterThanOrEqual(3)
  })

  it('任一方勝場 ≤ 9（不一邊倒）', () => {
    const blueWins = summaries.filter((summary) => summary.result === 'player').length
    const redWins = summaries.filter((summary) => summary.result === 'enemy').length
    expect(blueWins).toBeLessThanOrEqual(MAX_WINS_PER_SIDE)
    expect(redWins).toBeLessThanOrEqual(MAX_WINS_PER_SIDE)
  })
})
