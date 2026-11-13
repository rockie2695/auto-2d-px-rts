import { useEffect, useRef } from 'react'
import uPlot from 'uplot'

import type {
  ReplayDeathEvent,
  ReplayDecision,
  ReplayPolicyEvent,
  ReplayRecord,
  ReplaySample,
  ReplayTierSample,
} from '../replay.ts'
import { chartDomain, chartPoints, formatClock, uplotTripleData } from './collector.ts'
import {
  drawEndDot,
  drawSeriesLine,
  drawXAxis,
  drawYAxis,
  EMERALD_LINE_COLOR,
  ENEMY_LINE_COLOR,
  PLAYER_LINE_COLOR,
  RUBY_LINE_COLOR,
} from './chartDraw.ts'
import type { PlotGeometry } from './chartDraw.ts'

/**
 * 戰後復盤頁（Prompt 10.5 完整版）：對局結束後的靜態資訊頁。
 * 輸入只有一份 `ReplayRecord`（props 純渲染）——**不依賴即時 sim、不 import session/pixi**，
 * 可離線分析（parseReplay 的 JSON 檔即完整輸入）。
 *
 * 區塊（MVP 基礎＋10.5 完整版擴充）：
 * - 勝負結果、時長、最終資源、投降橫幅（Prompt 8.6/10.6）。
 * - 資源曲線：**uPlot 三線**（我方三資源全程，Prompt 5 起紅/綠可缺 → 缺則雙線 canvas）。
 * - 單位數量雙線＋**tier 堆疊圖**（10.5 完整版；tierCountSeries 缺 → 隱藏）。
 * - 戰力曲線。
 * - **戰鬥事件時間軸**（10.5 完整版；deathEvents 缺 → 隱藏；hover 顯示詳情）。
 * - Policy 調整時間軸＋**節奏預設切換時間軸**（10.5 完整版；tempoEvents 缺 → 隱藏）。
 * - **決策歸因表**（10.5 完整版；decisions 缺 → 隱藏）：前 10 筆依影響力
 *   （資源成本為主、效用分為輔）排序，顯示時間／動作／當時分數／實際後果。
 * - **裝甲效益區塊**（10.5 完整版；armorStats 缺 → 隱藏）：累計減傷、
 *   「若無裝甲傷亡會增加多少 %」、敵方原始 vs 減傷後傷害總量。
 * - 反事實建議：**佔位**（待 Prompt 10.5b）。
 */

/** 結果顯示：文字與顏色（我方視角）。 */
function resultDisplay(result: ReplayRecord['result']): { text: string; color: string } {
  if (result === 'player') return { text: '勝利', color: '#7ce38b' }
  if (result === 'enemy') return { text: '戰敗', color: '#ff7a7a' }
  return { text: '平手', color: '#ffd866' }
}

/** 投降標記（Prompt 8.6 AI／Prompt 10.6 玩家手動）：誰投了、投降時間點與戰力／收入比；
 *  AI 投降附絕望指數，玩家手動投降顯示「手動」。 */
function SurrenderBanner({ surrender }: { surrender: ReplayRecord['surrender'] }) {
  if (surrender === undefined) return null
  const side = surrender.player === 'player' ? '我方' : '敵方'
  const kind = surrender.type === 'player_surrender' ? '玩家投降（手動）' : 'AI 投降'
  return (
    <div className="post-game-surrender" data-testid="post-game-surrender">
      {formatClock(surrender.tick)} {side}
      {kind}（
      {surrender.type === 'ai_surrender' ? `絕望 ${surrender.despairAtSurrender.toFixed(2)}、` : ''}
      戰力比 {surrender.powerRatio.toFixed(2)}、收入比 {surrender.incomeRatio.toFixed(2)}）
    </div>
  )
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

/** uPlot 選項（全程資源三線；無互動、mono、常規線色——與遊戲內 ResourceChart 同款；
 *  x 值是「秒」——顯式關閉時間軸並格式化為 m:ss，避免 uPlot 預設把它當 1970 時間戳）。 */
function resourceUplotOptions(width: number, height: number): uPlot.Options {
  return {
    width,
    height,
    class: 'uplot-pixel',
    cursor: { show: false },
    legend: { show: false },
    axes: [
      {
        stroke: '#5a6472',
        grid: { show: true, width: 1, stroke: '#242a33' },
        ticks: { show: false },
        font: '9px monospace',
        values: (_self, ticks) => ticks.map((seconds) => formatClock(seconds * 20)),
      },
      { stroke: '#5a6472', grid: { show: true, width: 1, stroke: '#242a33' }, ticks: { show: false }, font: '9px monospace' },
    ],
    series: [
      {},
      { stroke: PLAYER_LINE_COLOR, width: 2 },
      { stroke: RUBY_LINE_COLOR, width: 2 },
      { stroke: EMERALD_LINE_COLOR, width: 2 },
    ],
  }
}

/** 我方三資源全程曲線（uPlot 三線；Prompt 10.5 完整版）。 */
function ResourceTripleChart({
  crystal,
  ruby,
  emerald,
  width = 560,
  height = 160,
}: {
  crystal: readonly ReplaySample[]
  ruby: readonly ReplaySample[]
  emerald: readonly ReplaySample[]
  width?: number
  height?: number
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const data = uplotTripleData(crystal, ruby, emerald)
    if (data[0].length === 0) return
    if (plotRef.current === null) {
      plotRef.current = new uPlot(resourceUplotOptions(width, height), data, host)
    } else {
      plotRef.current.setData(data)
    }
  }, [crystal, ruby, emerald, width, height])
  useEffect(
    () => () => {
      plotRef.current?.destroy()
      plotRef.current = null
    },
    [],
  )
  return <div ref={hostRef} data-testid="post-game-resource-uplot" className="post-chart-host" />
}

/** tier 堆疊圖顏色（我方藍系三階、敵方紅系三階）。 */
const TIER_STACK_COLORS: ReadonlyArray<{ key: string; color: string }> = [
  { key: 'enemy.large', color: 'rgba(224, 92, 92, 0.30)' },
  { key: 'enemy.medium', color: 'rgba(224, 92, 92, 0.55)' },
  { key: 'enemy.small', color: '#e05c5c' },
  { key: 'player.large', color: 'rgba(111, 142, 207, 0.30)' },
  { key: 'player.medium', color: 'rgba(111, 142, 207, 0.55)' },
  { key: 'player.small', color: '#6f8ecf' },
]

/**
 * 單位數量堆疊圖（Prompt 10.5 完整版）：canvas 自繪 6 層 stacked area——
 * 底層敵方三 tier（紅系）、上層我方三 tier（藍系）；tierCountSeries 缺 → null。
 */
function TierStackChart({
  samples,
  durationTicks,
  width = 560,
  height = 160,
}: {
  samples: readonly ReplayTierSample[]
  durationTicks: number
  width?: number
  height?: number
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
    if (samples.length === 0) {
      ctx.fillStyle = '#808a96'
      ctx.textAlign = 'left'
      ctx.fillText('無取樣資料', 8, height / 2)
      return
    }
    const plot: PlotGeometry = { left: 40, right: width - 8, top: 8, bottom: height - 18 }
    let maxTotal = 0
    for (const sample of samples) {
      const total =
        sample.player.small +
        sample.player.medium +
        sample.player.large +
        sample.enemy.small +
        sample.enemy.medium +
        sample.enemy.large
      if (total > maxTotal) maxTotal = total
    }
    if (maxTotal <= 0) maxTotal = 1
    const xOf = (tick: number): number =>
      plot.left + ((durationTicks <= 0 ? 0 : tick / durationTicks) * (plot.right - plot.left))
    const yOf = (value: number): number =>
      plot.bottom - (value / maxTotal) * (plot.bottom - plot.top)
    // y 軸刻度（3 格線）。
    ctx.strokeStyle = '#3a4048'
    ctx.fillStyle = '#808a96'
    ctx.font = '9px monospace'
    ctx.textAlign = 'right'
    for (let index = 0; index <= 3; index++) {
      const value = Math.round((maxTotal * index) / 3)
      const y = yOf(value)
      ctx.beginPath()
      ctx.moveTo(plot.left, y)
      ctx.lineTo(plot.right, y)
      ctx.stroke()
      ctx.fillText(String(value), plot.left - 4, y + 3)
    }
    // x 軸（0:00 ～ 總時長）。
    ctx.textAlign = 'left'
    ctx.fillText('0:00', plot.left, height - 4)
    ctx.textAlign = 'right'
    ctx.fillText(formatClock(durationTicks), plot.right, height - 4)
    // 6 層堆疊（由底往上累加）。
    const seriesOf = (sample: ReplayTierSample, key: string): number => {
      const sides = key.startsWith('player') ? sample.player : sample.enemy
      const tier = key.split('.')[1] ?? 'small'
      if (tier === 'small') return sides.small
      if (tier === 'medium') return sides.medium
      return sides.large
    }
    let baseline = new Array<number>(samples.length).fill(0)
    for (const { key, color } of TIER_STACK_COLORS) {
      ctx.fillStyle = color
      ctx.beginPath()
      samples.forEach((sample, index) => {
        const x = xOf(sample.tick)
        const top = (baseline[index] ?? 0) + seriesOf(sample, key)
        if (index === 0) ctx.moveTo(x, yOf(top))
        else ctx.lineTo(x, yOf(top))
      })
      for (let index = samples.length - 1; index >= 0; index--) {
        ctx.lineTo(xOf(samples[index]?.tick ?? 0), yOf(baseline[index] ?? 0))
      }
      ctx.closePath()
      ctx.fill()
      baseline = samples.map((sample, index) => (baseline[index] ?? 0) + seriesOf(sample, key))
    }
    // 圖例。
    ctx.font = '9px monospace'
    ctx.textAlign = 'left'
    const legendLabels: Record<string, string> = {
      'enemy.small': '敵小',
      'enemy.medium': '敵中',
      'enemy.large': '敵大',
      'player.small': '我小',
      'player.medium': '我中',
      'player.large': '我大',
    }
    TIER_STACK_COLORS.forEach((entry, index) => {
      ctx.fillStyle = entry.color
      ctx.fillRect(plot.left + index * 46, plot.top + 2, 8, 8)
      ctx.fillStyle = '#9aa5b1'
      ctx.fillText(legendLabels[entry.key] ?? entry.key, plot.left + index * 46 + 10, plot.top + 9)
    })
  }, [samples, durationTicks, width, height])

  return <canvas ref={canvasRef} width={width} height={height} data-testid="post-game-tierstack-chart" className="post-game-chart" />
}

/** 事件時間軸（戰鬥死亡／節奏切換共用）：水平軸 marker（title = hover 詳情）＋明細列表。 */
function EventTimeline({
  events,
  durationTicks,
  markerColorOf,
  testId,
  listTestId,
  emptyText,
  maxList = 30,
}: {
  events: ReadonlyArray<{ tick: number; title: string }>
  durationTicks: number
  markerColorOf: (index: number) => string
  testId: string
  listTestId: string
  emptyText: string
  maxList?: number
}) {
  if (events.length === 0) {
    return <div className="policy-timeline-empty">{emptyText}</div>
  }
  const positionPct = (tick: number): number =>
    durationTicks <= 0 ? 0 : Math.min(100, Math.max(0, (tick / durationTicks) * 100))
  return (
    <div data-testid={testId}>
      <div className="policy-timeline-axis">
        {events.map((event, index) => (
          <span
            key={`${event.tick}-${index}`}
            className="policy-timeline-marker"
            style={{ left: `${positionPct(event.tick)}%`, color: markerColorOf(index) }}
            title={event.title}
          >
            ▼
          </span>
        ))}
      </div>
      <ol className="policy-timeline-list" data-testid={listTestId}>
        {events.slice(0, maxList).map((event, index) => (
          <li key={`${event.tick}-${index}`} title={event.title}>
            <span className="decision-log-time">{formatClock(event.tick)}</span>
            <span>{event.title}</span>
          </li>
        ))}
      </ol>
      {events.length > maxList ? (
        <div className="policy-timeline-empty">…其餘 {events.length - maxList} 筆詳見時間軸標記</div>
      ) : null}
    </div>
  )
}

/** 戰鬥死亡事件 → 時間軸條目（hover 詳情：時鐘＋受害方＋單位＋tier）。 */
function deathTimeline(events: readonly ReplayDeathEvent[]): Array<{ tick: number; title: string }> {
  return events.map((event) => ({
    tick: event.tick,
    title: `${event.player === 'player' ? '我方' : '敵方'} ${event.defId}（${event.tier}/${event.role}）陣亡`,
  }))
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

/**
 * 決策歸因表（Prompt 10.5 完整版）：前 10 筆關鍵決策——
 * 影響力排序＝**資源成本（藍水晶）為主、效用分為輔**；顯示時間／動作／
 * 當時分數／實際後果（該決策後出生的同單位現存量）／一行解釋。
 */
function DecisionTable({ decisions }: { decisions: readonly ReplayDecision[] }) {
  if (decisions.length === 0) {
    return <div className="policy-timeline-empty">無決策記錄</div>
  }
  const top = [...decisions]
    .sort((a, b) => (b.cost !== a.cost ? b.cost - a.cost : b.score - a.score))
    .slice(0, 10)
  return (
    <div data-testid="decision-attribution">
      <ol className="policy-timeline-list" data-testid="decision-attribution-list">
        {top.map((decision, index) => (
          <li key={`${decision.tick}-${decision.actor}-${decision.action}-${decision.target}-${index}`}>
            <span className="decision-log-time">{formatClock(decision.tick)}</span>
            <span>
              {decision.actor === 'player' ? '我方' : '敵方'}
              {decision.action === 'build' ? ' 蓋 ' : ' 生 '}
              {decision.target}｜分數 {decision.score.toFixed(2)}｜成本 {decision.cost}
              ｜後果{' '}
              {decision.outcomeAlive === undefined ? '--' : `現存 ${decision.outcomeAlive}`}
              ｜{decision.explanation}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 裝甲效益區塊（Prompt 10.5 完整版）：三項量化——累計減傷／若無裝甲傷亡增幅／敵方原始 vs 減傷後。 */
function ArmorBlock({ armor }: { armor: NonNullable<ReplayRecord['armorStats']> }) {
  const mitigated = {
    player: armor.takenRaw.player - armor.takenActual.player,
    enemy: armor.takenRaw.enemy - armor.takenActual.enemy,
  }
  // 若無裝甲：我方單位承受的傷害會從 actual 增加到 raw（地板使 raw ≥ actual）。
  const casualtyIncreasePct =
    armor.takenActual.player <= 0
      ? 0
      : ((armor.takenRaw.player - armor.takenActual.player) / armor.takenActual.player) * 100
  return (
    <div className="post-game-armor" data-testid="post-game-armor">
      <div>
        我方累計減傷 <strong data-testid="armor-mitigated-player">{mitigated.player}</strong>
        （原始 {armor.takenRaw.player} → 實際 {armor.takenActual.player}）
      </div>
      <div>
        若無裝甲，我方承受傷害會增加{' '}
        <strong data-testid="armor-casualty-increase">{casualtyIncreasePct.toFixed(1)}%</strong>
      </div>
      <div>
        敵方對我方有效傷害：原始 <strong data-testid="armor-raw-player">{armor.takenRaw.player}</strong>
        {' '}→ 減傷後 <strong data-testid="armor-actual-player">{armor.takenActual.player}</strong>
        {' '}（敵方承受減傷 {mitigated.enemy}）
      </div>
      <div className="pre-game-note">單位受害才計（建築無裝甲）；地板 1 點保證任何攻勢都能磨死高防目標</div>
    </div>
  )
}

export function PostGamePanel({
  replay,
  onRestart,
}: {
  replay: ReplayRecord
  /** 「再來一場」：回到 /pre-game 開新對局。 */
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
      <SurrenderBanner surrender={replay.surrender} />

      <section className="post-game-section">
        <h2>資源曲線（全程，我方三資源）</h2>
        {replay.rubySeries !== undefined && replay.emeraldSeries !== undefined ? (
          <ResourceTripleChart
            crystal={replay.resourceSeries}
            ruby={replay.rubySeries}
            emerald={replay.emeraldSeries}
          />
        ) : (
          <TwoLineChart
            samples={replay.resourceSeries}
            durationTicks={replay.durationTicks}
            width={560}
            height={160}
            testId="post-game-resource-chart"
          />
        )}
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

      {replay.tierCountSeries !== undefined ? (
        <section className="post-game-section">
          <h2>單位數量堆疊（按 tier）</h2>
          <TierStackChart samples={replay.tierCountSeries} durationTicks={replay.durationTicks} />
        </section>
      ) : null}

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

      {replay.deathEvents !== undefined ? (
        <section className="post-game-section">
          <h2>戰鬥事件時間軸（單位陣亡）</h2>
          <EventTimeline
            events={deathTimeline(replay.deathEvents)}
            durationTicks={replay.durationTicks}
            markerColorOf={(index) =>
              replay.deathEvents?.[index]?.player === 'player' ? '#e05c5c' : '#6f8ecf'
            }
            testId="combat-timeline"
            listTestId="combat-timeline-list"
            emptyText="對局中無陣亡"
          />
        </section>
      ) : null}

      {replay.tempoEvents !== undefined ? (
        <section className="post-game-section">
          <h2>節奏預設切換時間軸</h2>
          <EventTimeline
            events={replay.tempoEvents.map((event) => ({
              tick: event.tick,
              title: `節奏 ${event.from} → ${event.to}`,
            }))}
            durationTicks={replay.durationTicks}
            markerColorOf={() => '#ffd866'}
            testId="tempo-timeline"
            listTestId="tempo-timeline-list"
            emptyText="對局中未切換節奏"
          />
        </section>
      ) : null}

      <section className="post-game-section">
        <h2>Policy 調整時間軸</h2>
        <PolicyTimeline events={replay.policyEvents} durationTicks={replay.durationTicks} />
      </section>

      {replay.decisions !== undefined ? (
        <section className="post-game-section">
          <h2>決策歸因（前 10 關鍵決策，依成本排序）</h2>
          <DecisionTable decisions={replay.decisions} />
        </section>
      ) : null}

      {replay.armorStats !== undefined ? (
        <section className="post-game-section">
          <h2>裝甲效益</h2>
          <ArmorBlock armor={replay.armorStats} />
        </section>
      ) : null}

      <section className="post-game-section">
        <h2>反事實建議</h2>
        <div className="policy-timeline-empty" data-testid="counterfactual-placeholder">
          反事實建議待 Prompt 10.5b（此區為佔位）
        </div>
      </section>

      <button type="button" className="post-game-restart" data-testid="post-game-restart" onClick={onRestart}>
        再來一場
      </button>
    </div>
  )
}
