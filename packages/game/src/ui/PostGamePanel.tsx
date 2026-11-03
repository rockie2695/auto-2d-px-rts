import { useEffect, useRef } from 'react'

import type { ReplayPolicyEvent, ReplayRecord, ReplaySample } from '../replay.ts'
import { chartDomain, chartPoints, formatClock } from './collector.ts'
import {
  drawEndDot,
  drawSeriesLine,
  drawXAxis,
  drawYAxis,
  ENEMY_LINE_COLOR,
  PLAYER_LINE_COLOR,
} from './chartDraw.ts'
import type { PlotGeometry } from './chartDraw.ts'

/**
 * 戰後復盤頁（Prompt 10.5，MVP）：對局結束後的靜態資訊頁。
 * 輸入只有一份 `ReplayRecord`（props 純渲染）——**不依賴即時 sim、不 import session/pixi**。
 * 內容：勝負結果、對局時長、雙方最終資源、完整資源曲線、單位數量曲線、
 * Policy 調整時間軸。不做：反事實建議、決策歸因、投降分析、戰鬥事件時間軸。
 */

/** 結果顯示：文字與顏色（我方視角）。 */
function resultDisplay(result: ReplayRecord['result']): { text: string; color: string } {
  if (result === 'player') return { text: '勝利', color: '#7ce38b' }
  if (result === 'enemy') return { text: '戰敗', color: '#ff7a7a' }
  return { text: '平手', color: '#ffd866' }
}

/**
 * 雙線圖（資源／單位數共用）：canvas 自繪、y 軸 3 格線＋整數標籤、
 * x 軸 0:00～總時長；敵方紅 3px 墊底、我方藍 2px 疊上、線尾色點。
 */
function TwoLineChart({
  samples,
  durationTicks,
  width,
  height,
  testId,
}: {
  samples: readonly ReplaySample[]
  durationTicks: number
  width: number
  height: number
  testId: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#2a2f38'
    ctx.fillRect(0, 0, width, height)
    const domain = chartDomain(samples)
    const plot: PlotGeometry = { left: 40, right: width - 8, top: 8, bottom: height - 18 }
    if (domain === null) {
      ctx.fillStyle = '#808a96'
      ctx.textAlign = 'left'
      ctx.fillText('無取樣資料', 8, height / 2)
      return
    }
    drawYAxis(ctx, domain, plot)
    drawXAxis(ctx, durationTicks, plot, height)
    const enemy = chartPoints(samples, (point) => point.enemy)
    const player = chartPoints(samples, (point) => point.player)
    drawSeriesLine(ctx, enemy, plot, ENEMY_LINE_COLOR, 3)
    drawSeriesLine(ctx, player, plot, PLAYER_LINE_COLOR, 2)
    drawEndDot(ctx, enemy, plot, ENEMY_LINE_COLOR)
    drawEndDot(ctx, player, plot, PLAYER_LINE_COLOR)
  }, [samples, durationTicks, width, height])

  return <canvas ref={canvasRef} width={width} height={height} data-testid={testId} className="post-game-chart" />
}

/** Policy 調整時間軸：水平軸 0→時長，每次變更一個 ▼ 標記＋下方明細列表。 */
function PolicyTimeline({
  events,
  durationTicks,
}: {
  events: readonly ReplayPolicyEvent[]
  durationTicks: number
}) {
  if (events.length === 0) {
    return <div className="policy-timeline-empty">對局中未調整政策</div>
  }
  const positionPct = (tick: number): number =>
    durationTicks <= 0 ? 0 : Math.min(100, Math.max(0, (tick / durationTicks) * 100))
  return (
    <div data-testid="policy-timeline">
      <div className="policy-timeline-axis">
        {events.map((event, index) => (
          <span
            key={`${event.tick}-${event.key}-${index}`}
            className="policy-timeline-marker"
            style={{ left: `${positionPct(event.tick)}%` }}
            title={`${formatClock(event.tick)} ${event.key} ${event.from.toFixed(2)}→${event.to.toFixed(2)}`}
          >
            ▼
          </span>
        ))}
      </div>
      <ol className="policy-timeline-list">
        {events.map((event, index) => (
          <li key={`${event.tick}-${event.key}-${index}`}>
            <span className="decision-log-time">{formatClock(event.tick)}</span>
            <span>
              {event.key} {event.from.toFixed(2)}→{event.to.toFixed(2)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function PostGamePanel({
  replay,
  onRestart,
}: {
  replay: ReplayRecord
  /** 「再來一場」：回到 /game 開新對局。 */
  onRestart: () => void
}) {
  const result = resultDisplay(replay.result)
  return (
    <div className="post-game" data-testid="post-game-panel">
      <h1 className="post-game-title">戰後復盤</h1>
      <div className="post-game-header">
        <span className="post-game-result" data-testid="post-game-result" style={{ color: result.color }}>
          {result.text}
        </span>
        <span data-testid="post-game-duration">時長 {formatClock(replay.durationTicks)}</span>
        <span data-testid="post-game-final-crystal">
          最終水晶 我方 {replay.finalCrystal.player} / 敵方 {replay.finalCrystal.enemy}
        </span>
      </div>

      <section className="post-game-section">
        <h2>資源曲線（全程）</h2>
        <TwoLineChart
          samples={replay.resourceSeries}
          durationTicks={replay.durationTicks}
          width={560}
          height={160}
          testId="post-game-resource-chart"
        />
      </section>

      <section className="post-game-section">
        <h2>單位數量隨時間變化</h2>
        <TwoLineChart
          samples={replay.unitCountSeries}
          durationTicks={replay.durationTicks}
          width={560}
          height={160}
          testId="post-game-unitcount-chart"
        />
      </section>

      <section className="post-game-section">
        <h2>戰力曲線（全程）</h2>
        <TwoLineChart
          samples={replay.powerSeries}
          durationTicks={replay.durationTicks}
          width={560}
          height={160}
          testId="post-game-power-chart"
        />
      </section>

      <section className="post-game-section">
        <h2>Policy 調整時間軸</h2>
        <PolicyTimeline events={replay.policyEvents} durationTicks={replay.durationTicks} />
      </section>

      <button type="button" className="post-game-restart" data-testid="post-game-restart" onClick={onRestart}>
        再來一場
      </button>
    </div>
  )
}
