import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { getActiveSession } from '../session.ts'
import type { BattleStats } from '../session.ts'
import { ResourceSeries } from './collector.ts'
import type { SamplePoint } from './collector.ts'
import { DecisionLogPanel } from './DecisionLogPanel.tsx'
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
  // 取樣器只活在 effect 內（ref 僅在 effect 存取，避免渲染期讀 ref）；
  // 曲線樣本與收入在 refresh 內由同一實例一次算好存進 state。
  const seriesRef = useRef<ResourceSeries | null>(null)
  const [curve, setCurve] = useState<{ samples: readonly SamplePoint[]; income: number | null }>({
    samples: [],
    income: null,
  })

  useEffect(() => {
    if (seriesRef.current === null) seriesRef.current = new ResourceSeries()
    const series = seriesRef.current
    const refresh = (): void => {
      const active = getActiveSession()
      if (active === null) return
      const next = active.getBattleStats()
      setStats(next)
      series.push(next.tick, next.playerCrystal)
      setCurve({ samples: series.chart(), income: series.incomePerSec() })
    }
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const ratio = powerRatio(stats?.playerPower ?? 0, stats?.enemyPower ?? 0)

  return (
    <>
      <ResourceChart samples={curve.samples} />
      <div className="hud-top-right">
        <ResourcePanel
          playerCrystal={stats?.playerCrystal ?? 0}
          enemyCrystal={stats?.enemyCrystal ?? 0}
          playerIncome={curve.income}
          enemyIncome={curve.income}
          ratio={ratio}
        />
        {children}
      </div>
      <DecisionLogPanel entries={stats?.log ?? []} />
      <SquadPanel squads={stats?.squads ?? []} />
    </>
  )
}
