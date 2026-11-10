import { fileURLToPath } from 'node:url'

import type { PolicyId } from '@auto-2d-px-rts/shared'

import { loadContentPackFromDir } from '../data/loadFromDir.ts'
import { resolvePolicies } from './policy.ts'
import type { PolicyValues } from './policy.ts'
import { runStrategicCycle, STRATEGIC_INTERVAL_TICKS } from './strategy.ts'
import type { DecisionRecord } from './strategy.ts'
import { computeTacticalPlan, TACTICAL_INTERVAL_TICKS } from './tactics.ts'
import type { SquadMission, TacticalPlan, TacticalRecord } from './tactics.ts'
import { focusTargets, MICRO_INTERVAL_TICKS, microRecords, runMicroCycle } from './micro.ts'
import type { MicroRecord, MicroRecordState } from './micro.ts'
import { createWorld, describePlayer, snapshotWorld, stepWorld } from '../sim/world.ts'
import type { PlayerId, World } from '../sim/types.ts'

/**
 * 組合根 CLI（`pnpm sim`）：data + sim + ai 三層在此匯合
 * （sim 層本身不得 import ai —— 方向性由 architecture.test.ts 守衛）。
 *
 * - 種子固定 42；戰略層每 40 tick（2 秒）蓋房、生兵。
 * - 戰術層每 10 tick（500ms）重編小隊、指派任務（純計畫，不下單）；
 *   小隊任務變化時即時印一行（可目視集結／推進／撤退）。
 * - 微操層每 2 tick（100ms）依行為樹對每個單位下單：撤退／攻擊／風箏／編隊／待機；
 *   風箏與集火狀態變化時即時印一行（可目視風箏、集火），
 *   接戰由 sim 的自動接戰結算。
 * - 每次戰略動作即時印出（`t=40 player: built barracks@(x,y)`），
 *   每 250 tick 印一次狀態列（含小隊摘要與最近 5 條決策記錄）。
 * - 我方滑桿可用 CLI 覆寫：`pnpm sim --econMilitary=0 --aggression=1`；
 *   敵方固定預設值 0.5（SPEC §7）。兩次執行輸出逐字相同即確定性成立。
 */

/** 任務的中文標籤（CLI 顯示用）。 */
const MISSION_LABEL: Record<SquadMission, string> = {
  defend: '守備',
  attack: '進攻',
  harass: '騷擾',
  stage: '集結待戰',
  retreat: '撤退',
}

const SEED = 42
const TOTAL_TICKS = 1500
const PRINT_EVERY = 250

/** 解析 `--econMilitary=0` 形式的滑桿覆寫（僅接受已知 id 與 [0,1] 數值）。 */
function parsePolicyOverrides(argv: readonly string[]): Partial<Record<PolicyId, number>> {
  const overrides: Partial<Record<PolicyId, number>> = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) continue
    const id = arg.slice(2, eq)
    const value = Number(arg.slice(eq + 1))
    if (!isPolicyId(id) || !Number.isFinite(value)) {
      console.warn(`忽略無效的滑桿覆寫：${arg}`)
      continue
    }
    overrides[id] = value
  }
  return overrides
}

function isPolicyId(id: string): id is PolicyId {
  return (
    id === 'econMilitary' ||
    id === 'unitSize' ||
    id === 'unitRange' ||
    id === 'aggression' ||
    id === 'clusterSpread'
  )
}

function printStatus(
  world: World,
  records: readonly DecisionRecord[],
  plans: Record<PlayerId, TacticalPlan | null>,
  tacticalRecords: readonly TacticalRecord[] = [],
  microRecordsOut: readonly MicroRecord[] = [],
): void {
  console.log(`--- tick ${world.tick} ---`)
  for (const player of world.players) {
    console.log(`  ${describePlayer(world, player.id)}`)
    const plan = plans[player.id]
    if (plan === null || plan.squads.length === 0) {
      console.log(`    小隊: （無）`)
    } else {
      const focus = focusTargets(world, player.id, plan)
      const summary = plan.squads
        .map((squad) => {
          const target = focus.get(squad.index) ?? null
          const focusLabel = target === null ? '' : ` 集火u${target}`
          return (
            `#${squad.index} ${MISSION_LABEL[squad.mission]}(${squad.memberIds.length})` +
            `→(${squad.target.x},${squad.target.y})${focusLabel}`
          )
        })
        .join(' ')
      console.log(`    小隊: ${summary}`)
    }
  }
  const snapshot = snapshotWorld(world)
  const nodesLeft = world.resourceNodes.reduce((total, node) => total + node.amountRemaining, 0)
  console.log(
    `  units=${world.units.length} buildings=${world.buildings.length} ` +
      `nodesLeft=${nodesLeft} rng=${snapshot.rngState}`,
  )

  const recent = records.slice(-5)
  if (recent.length > 0) {
    console.log(`  最近決策（${recent.length}/${records.length} 條）:`)
    for (const record of recent) {
      console.log(
        `    t=${record.tick} ${record.actor}: ${record.action} ${record.target}` +
          ` — ${record.reason.explanation}`,
      )
    }
  }

  // 戰術層決策記錄（Prompt 7.5）：最近 5 條；目標記錄附 top-3 候選效用分數。
  const recentTactical = tacticalRecords.slice(-5)
  if (recentTactical.length > 0) {
    console.log(`  最近戰術決策（${recentTactical.length}/${tacticalRecords.length} 條）:`)
    for (const record of recentTactical) {
      const top = record.reason.candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.defId}:${candidate.score.toFixed(2)}`)
        .join(' > ')
      console.log(
        `    t=${record.tick} ${record.actor}: ${record.action} ${record.target}` +
          ` [${record.reason.topFactor}] — ${record.reason.explanation}` +
          (top.length > 0 ? `\n      候選：${top}` : ''),
      )
    }
  }

  // 微操層決策記錄（Prompt 8.5）：最近 5 條（僅戰鬥狀態切換，附觸發成因）。
  const recentMicro = microRecordsOut.slice(-5)
  if (recentMicro.length > 0) {
    console.log(`  最近微操決策（${recentMicro.length}/${microRecordsOut.length} 條）:`)
    for (const record of recentMicro) {
      console.log(
        `    t=${record.tick} ${record.actor}: ${record.target}` +
          ` [${record.reason.topFactor}] — ${record.reason.explanation}`,
      )
    }
  }
}

function main(): void {
  const dataDir = fileURLToPath(new URL('../../public/data/', import.meta.url))
  const content = loadContentPackFromDir(dataDir)
  const world = createWorld(content, SEED)

  const policies: Record<PlayerId, PolicyValues> = {
    player: resolvePolicies(parsePolicyOverrides(process.argv.slice(2))),
    enemy: resolvePolicies({}),
  }
  console.log(
    `policies: player=[${Object.values(policies.player).join(', ')}] ` +
      `enemy=[${Object.values(policies.enemy).join(', ')}]`,
  )

  const decisionLog: DecisionRecord[] = []
  /** 戰術層決策記錄（Prompt 7.5）：只保留最近 500 條（CLI 目視用）。 */
  const tacticalLog: TacticalRecord[] = []
  /** 微操層決策記錄（Prompt 8.5）：只保留最近 500 條（CLI 目視用）。 */
  const microLog: MicroRecord[] = []
  /** microRecords 的每單位狀態（上次動作＋上次記錄循環；呼叫端持有）。 */
  const microStates: Record<PlayerId, MicroRecordState> = {
    player: new Map(),
    enemy: new Map(),
  }
  let microCycleIndex = 0
  const lastPlans: Record<PlayerId, TacticalPlan | null> = { player: null, enemy: null }
  const prevMissions: Record<PlayerId, SquadMission[]> = { player: [], enemy: [] }
  const reportedDisengaged: Record<PlayerId, Set<number>> = { player: new Set(), enemy: new Set() }

  // tick 0 先算一次戰術計畫，讓微操層從第 1 tick 起就有小隊目標。
  for (const player of world.players) {
    lastPlans[player.id] = computeTacticalPlan(
      world,
      player.id,
      policies[player.id],
      lastPlans[player.id],
    )
  }

  printStatus(world, decisionLog, lastPlans, tacticalLog)
  while (world.tick < TOTAL_TICKS) {
    stepWorld(world)

    if (world.tick % STRATEGIC_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        const result = runStrategicCycle(world, player.id, policies[player.id])
        decisionLog.push(...result.records)
        for (const action of result.actions) {
          if (action.kind === 'build') {
            console.log(
              `t=${world.tick} ${player.id}: built ${action.defId}@(${action.tile.x},${action.tile.y})`,
            )
          } else {
            console.log(`t=${world.tick} ${player.id}: queued ${action.defId}`)
          }
        }
      }
    }

    if (world.tick % TACTICAL_INTERVAL_TICKS === 0) {
      for (const player of world.players) {
        const plan = computeTacticalPlan(world, player.id, policies[player.id], lastPlans[player.id])
        lastPlans[player.id] = plan
        tacticalLog.push(...plan.records)
        if (tacticalLog.length > 500) tacticalLog.splice(0, tacticalLog.length - 500)
        const before = prevMissions[player.id]
        for (const squad of plan.squads) {
          const previous = before[squad.index]
          if (previous === squad.mission) continue
          const from = previous === undefined ? '組成' : MISSION_LABEL[previous]
          // 任務記錄（Prompt 7.5）：附 topFactor 與解釋參數。
          const record = plan.records.find(
            (candidate) =>
              candidate.action === 'mission' &&
              candidate.target === `#${squad.index}:${squad.mission}`,
          )
          console.log(
            `t=${world.tick} ${player.id}: squad ${squad.index} ${from}→` +
              `${MISSION_LABEL[squad.mission]} 目標(${squad.target.x},${squad.target.y})` +
              ` 兵力${squad.memberIds.length} 戰力${squad.power}` +
              (record !== undefined ? ` [${record.reason.topFactor}] ${record.reason.explanation}` : ''),
          )
        }
        prevMissions[player.id] = plan.squads.map((squad) => squad.mission)

        // 個體撤退：首次跌破 retreatHpPct 時印一次（可目視「脫離戰鬥」）。
        const reported = reportedDisengaged[player.id]
        for (const id of plan.disengaged) {
          if (reported.has(id)) continue
          reported.add(id)
          const unit = world.units.find((candidate) => candidate.id === id)
          const maxHp = unit === undefined ? 0 : world.defs.units[unit.defId]?.stats.hp ?? 0
          console.log(
            `t=${world.tick} ${player.id}: unit ${id} 脫離戰鬥（hp ${unit?.hp ?? 0}/${maxHp}）` +
              `→集結(${plan.rally.x},${plan.rally.y})`,
          )
        }
      }
    }

    if (world.tick % MICRO_INTERVAL_TICKS === 0) {
      microCycleIndex += 1
      for (const player of world.players) {
        const decisions = runMicroCycle(world, player.id, lastPlans[player.id])
        // 微操層決策記錄（Prompt 8.5）：只在戰鬥狀態切換時產生（含 topFactor
        // ＋解釋），取代先前的「風箏首印」—手動集合；個體撤退首印仍保留
        //（`disengaged` 事件的狀態、不與本記錄重複）。
        const records = microRecords(
          player.id,
          world.tick,
          decisions,
          microStates[player.id],
          microCycleIndex,
        )
        microLog.push(...records)
        if (microLog.length > 500) microLog.splice(0, microLog.length - 500)
      }
    }

    if (world.tick % PRINT_EVERY === 0) {
      printStatus(world, decisionLog, lastPlans, tacticalLog, microLog)
    }
  }
}

main()
