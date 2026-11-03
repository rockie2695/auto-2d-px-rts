import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { PolicyValues } from '../ai/policy.ts'
import { getActiveSession } from '../session.ts'
import type { BattleStats, PolicySnapshot } from '../session.ts'
import { ResourceSeries } from './collector.ts'
import type { SamplePoint } from './collector.ts'
import { DecisionLogPanel } from './DecisionLogPanel.tsx'
import { PolicyPanel } from './PolicyPanel.tsx'
import { ResourceChart } from './ResourceChart.tsx'
import { ResourcePanel } from './ResourcePanel.tsx'
import { SquadPanel } from './SquadPanel.tsx'

/** 面板輪詢間隔：四角面板是文字/曲線，250ms（~4Hz）夠流暢又不吃效能。 */
const POLL_MS = 250

/** 戰力比：我方/敵方；敵方為 0 時回傳無限大（綠燈優勢）。 */
function powerRatio(playerPower: number, enemyPower: number): number {
  if (enemyPower <= 0) return playerPower > 0 ? Number.POSITIVE_INFINITY : 1
  return playerPower / enemyPower
}

/**
 * 四角 HUD（Prompt 9.5）：唯一的輪詢元件——每 250ms 取一次 `getBattleStats`，
 * 把樣本餵給 `ResourceSeries`（60 秒水晶曲線）並轉發給四個展示面板。
 * 本身不做任何遊戲計算；`children` 是疊在右上資源面板下方的資訊面板。
 */
export function BattleDashboard({ children }: { children?: ReactNode }) {
  const [stats, setStats] = useState<BattleStats | null>(null)
  const [policy, setPolicy] = useState<PolicySnapshot | null>(null)
  // 取樣器只活在 effect 內（ref 僅在 effect 存取，避免渲染期讀 ref）；
  // 三種指標各自一個取樣環，同一輪詢一次推齊，曲線樣本存進 state。
  const seriesRef = useRef<{
    crystal: ResourceSeries
    units: ResourceSeries
    power: ResourceSeries
  } | null>(null)
  const [curve, setCurve] = useState<{
    crystal: readonly SamplePoint[]
    units: readonly SamplePoint[]
    power: readonly SamplePoint[]
    playerIncome: number | null
    enemyIncome: number | null
  }>({ crystal: [], units: [], power: [], playerIncome: null, enemyIncome: null })

  useEffect(() => {
    if (seriesRef.current === null) {
      seriesRef.current = {
        crystal: new ResourceSeries(),
        units: new ResourceSeries(),
        power: new ResourceSeries(),
      }
    }
    const { crystal, units, power } = seriesRef.current
    const refresh = (): void => {
      const active = getActiveSession()
      if (active === null) return
      const next = active.getBattleStats()
      setStats(next)
      setPolicy(active.getPolicies('player'))
      crystal.push(next.tick, next.playerCrystal, next.enemyCrystal)
      units.push(next.tick, next.playerUnits, next.enemyUnits)
      power.push(next.tick, next.playerPower, next.enemyPower)
      setCurve({
        crystal: crystal.chart(),
        units: units.chart(),
        power: power.chart(),
        playerIncome: crystal.playerIncome(),
        enemyIncome: crystal.enemyIncome(),
      })
    }
    const timer = window.setInterval(refresh, POLL_MS)
    refresh() // 掛載即取一次樣本：曲線第一格就有雙方資料（不等 250ms）
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const applyPolicy = (values: PolicyValues): void => {
    const active = getActiveSession()
    if (active === null) return
    active.applyPolicies('player', values)
    // 立即反映冷卻與新值（不等下一次 250ms 輪詢）。
    setPolicy(active.getPolicies('player'))
  }

  const endMatch = (): void => {
    const active = getActiveSession()
    if (active === null) return
    active.endMatch() // App 的輪詢偵測 ended → 切換復盤頁
  }

  const ratio = powerRatio(stats?.playerPower ?? 0, stats?.enemyPower ?? 0)

  return (
    <>
      <ResourceChart
        crystalSamples={curve.crystal}
        unitSamples={curve.units}
        powerSamples={curve.power}
      />
      <div className="hud-top-right">
        <ResourcePanel
          playerCrystal={stats?.playerCrystal ?? 0}
          enemyCrystal={stats?.enemyCrystal ?? 0}
          playerIncome={curve.playerIncome}
          enemyIncome={curve.enemyIncome}
          ratio={ratio}
        />
        {children}
      </div>
      <DecisionLogPanel entries={stats?.log ?? []} />
      <SquadPanel squads={stats?.squads ?? []} />
      <PolicyPanel policy={policy} onApply={applyPolicy} onEndMatch={endMatch} />
    </>
  )
}
