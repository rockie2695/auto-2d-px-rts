import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'

import { buildPolicyTimeline, suggestCounterfactuals } from '../ai/counterfactual.ts'
import type { CounterfactualSuggestion } from '../ai/counterfactual.ts'
import type { PolicyValues } from '../ai/policy.ts'
import type { ContentPack } from '@auto-2d-px-rts/shared'
import { loadContentPackFromFetch } from '../data/loadFromFetch.ts'
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
import {
  counterfactualPoints,
  endTypeOf,
  headerCopyOf,
  lostMoments,
  replayPoliciesOf,
  sliceWindow,
} from './postGameView.ts'

/**
 * 戰後復盤頁（Prompt 10.5 完整版＋Prompt 10.5c 三視圖）：
 * 輸入只有一份 `ReplayRecord`（props 純渲染）＋可選內容包（反事實計算用）。
 *
 * **三視圖**（Prompt 10.5c，依 `endTypeOf` 分派——文案中性分析性、不羞辱玩家）：
 * - `player_surrender`：「你投降了」——局勢快照（紅系）／為什麼會輸（歸因＋
 *   前 5 個「如果當時改成 X」時刻）／反事實建議（3 快照點 × 3 維度真重放）／
 *   三按鈕（用建議參數重玩／調整 Policy 重玩／回到主選單）。
 * - `ai_surrender`：「對手投降了」（綠系）——勝利快照／Policy 為什麼贏
 *   （歸因佐證）／下次挑戰建議／再來一局。
 * - `normal_end`：勝利（綠）／失敗（紅，文案溫和）——維持 10.5 完整版設計，
 *   反事實建議同樣可用。
 *
 * 投降標記（10.5c）：投降 tick 以白色旗幟標記（hover 顯示詳情）；
 * 投降後的曲線與時間軸區域灰化（canvas 圖自繪＋時間軸 marker 變灰）。
 * uPlot 三線圖暫不灰化（官方無 axis 遮罩；後續可以 bands 補）。
 *
 * 既有區塊（10.5 完整版）：資源三線／單位數雙線／tier 堆疊／戰力曲線／
 * 戰鬥時間軸／節奏時間軸／Policy 時間軸／決策歸因表／裝甲效益。
 * 缺欄（舊 replay 檔）一律降級：隱藏區塊或顯示 --。
 */

/** 結果顯示：文字與顏色（我方視角；normal_end 標題色由 headerCopyOf 給）。 */
function resultDisplay(result: ReplayRecord['result']): { text: string; color: string } {
  if (result === 'player') return { text: '勝利', color: '#7ce38b' }
  if (result === 'enemy') return { text: '戰敗', color: '#ff7a7a' }
  return { text: '平手', color: '#ffd866' }
}

/** 投降詳情 hover 文案（時間軸旗幟與快照區塊共用）：despair 值、當時局勢。 */
function surrenderHoverTitle(surrender: NonNullable<ReplayRecord['surrender']>): string {
  const side = surrender.player === 'player' ? '我方' : '敵方'
  const kind = surrender.type === 'player_surrender' ? '玩家投降（手動）' : 'AI 投降'
  const despair =
    surrender.type === 'ai_surrender' ? `、絕望 ${surrender.despairAtSurrender.toFixed(2)}` : ''
  const buildings =
    surrender.buildingCount === undefined
      ? ''
      : `、建築 我${surrender.buildingCount.player}/敵${surrender.buildingCount.enemy}`
  return (
    `${formatClock(surrender.tick)} ${side}${kind}` +
    `（戰力比 ${surrender.powerRatio.toFixed(2)}、收入比 ${surrender.incomeRatio.toFixed(2)}${despair}${buildings}）`
  )
}

/** 投降橫幅（Prompt 8.6 AI／Prompt 10.6 玩家手動）。 */
function SurrenderBanner({ surrender }: { surrender: ReplayRecord['surrender'] }) {
  if (surrender === undefined) return null
  return (
    <div className="post-game-surrender" data-testid="post-game-surrender" title={surrenderHoverTitle(surrender)}>
      ⚑ {surrenderHoverTitle(surrender)}
    </div>
  )
}

/**
 * 投降灰化（Prompt 10.5c）：surrenderTick 之後畫半透明灰罩＋白色豎線旗幟；
 * 無投降（undefined）不畫。canvas 圖共用。
 */
function drawSurrenderVeil(
  ctx: CanvasRenderingContext2D,
  surrenderTick: number,
  durationTicks: number,
  plot: PlotGeometry,
): void {
  const x =
    plot.left +
    (durationTicks <= 0 ? 0 : Math.min(1, surrenderTick / durationTicks)) * (plot.right - plot.left)
  ctx.fillStyle = 'rgba(40, 44, 52, 0.55)'
  ctx.fillRect(x, plot.top, plot.right - x, plot.bottom - plot.top)
  ctx.strokeStyle = '#f5f7fa'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, plot.top)
  ctx.lineTo(x, plot.bottom)
  ctx.stroke()
  ctx.fillStyle = '#f5f7fa'
  ctx.font = '10px monospace'
  ctx.textAlign = 'left'
  ctx.fillText('⚑ 投降', Math.min(x + 3, plot.right - 30), plot.top + 10)
}

/**
 * 雙線圖（資源／單位數共用）：canvas 自繪、y 軸 3 格線＋整數標籤、
 * x 軸 0:00～總時長；敵方紅 3px 墊底、我方藍 2px 疊上、線尾色點；
 * surrenderTick 之後灰化＋白旗（10.5c）。
 */
function TwoLineChart({
  samples,
  durationTicks,
  width,
  height,
  testId,
  surrenderTick,
}: {
  samples: readonly ReplaySample[]
  durationTicks: number
  width: number
  height: number
  testId: string
  surrenderTick?: number
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
    if (surrenderTick !== undefined) drawSurrenderVeil(ctx, surrenderTick, durationTicks, plot)
  }, [samples, durationTicks, width, height, surrenderTick])

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
 * 底層敵方三 tier（紅系）、上層我方三 tier（藍系）；tierCountSeries 缺 → null；
 * surrenderTick 之後灰化＋白旗（10.5c）。
 */
function TierStackChart({
  samples,
  durationTicks,
  width = 560,
  height = 160,
  surrenderTick,
}: {
  samples: readonly ReplayTierSample[]
  durationTicks: number
  width?: number
  height?: number
  surrenderTick?: number
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
    if (surrenderTick !== undefined) drawSurrenderVeil(ctx, surrenderTick, durationTicks, plot)
  }, [samples, durationTicks, width, height, surrenderTick])

  return <canvas ref={canvasRef} width={width} height={height} data-testid="post-game-tierstack-chart" className="post-game-chart" />
}

/** 事件時間軸（戰鬥死亡／節奏切換共用）：水平軸 marker（title = hover 詳情）＋明細列表；
 *  surrenderTick 加白旗（10.5c），旗後的 marker／明細灰化。 */
function EventTimeline({
  events,
  durationTicks,
  markerColorOf,
  testId,
  listTestId,
  emptyText,
  maxList = 30,
  surrender,
}: {
  events: ReadonlyArray<{ tick: number; title: string }>
  durationTicks: number
  markerColorOf: (index: number) => string
  testId: string
  listTestId: string
  emptyText: string
  maxList?: number
  surrender?: NonNullable<ReplayRecord['surrender']>
}) {
  if (events.length === 0 && surrender === undefined) {
    return <div className="policy-timeline-empty">{emptyText}</div>
  }
  const surrenderTick = surrender?.tick
  const positionPct = (tick: number): number =>
    durationTicks <= 0 ? 0 : Math.min(100, Math.max(0, (tick / durationTicks) * 100))
  const muted = (tick: number): boolean => surrenderTick !== undefined && tick > surrenderTick
  return (
    <div data-testid={testId}>
      <div className="policy-timeline-axis">
        {surrender !== undefined ? (
          <span
            className="policy-timeline-marker post-game-surrender-flag"
            data-testid={`${testId}-surrender-flag`}
            style={{ left: `${positionPct(surrender.tick)}%`, color: '#f5f7fa' }}
            title={surrenderHoverTitle(surrender)}
          >
            ⚑
          </span>
        ) : null}
        {events.map((event, index) => (
          <span
            key={`${event.tick}-${index}`}
            className="policy-timeline-marker"
            style={{
              left: `${positionPct(event.tick)}%`,
              color: muted(event.tick) ? '#5a6472' : markerColorOf(index),
            }}
            title={event.title}
          >
            ▼
          </span>
        ))}
      </div>
      {surrender !== undefined && events.length === 0 ? (
        <div className="policy-timeline-empty">{emptyText}</div>
      ) : null}
      <ol className="policy-timeline-list" data-testid={listTestId}>
        {events.slice(0, maxList).map((event, index) => (
          <li
            key={`${event.tick}-${index}`}
            title={event.title}
            className={muted(event.tick) ? 'post-surrender-muted' : undefined}
          >
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

/** Policy 調整時間軸：水平軸 0→時長，每次變更一個 ▼ 標記＋下方明細列表；
 *  surrenderTick 加白旗（10.5c），旗後灰化。 */
function PolicyTimeline({
  events,
  durationTicks,
  surrender,
}: {
  events: readonly ReplayPolicyEvent[]
  durationTicks: number
  surrender?: NonNullable<ReplayRecord['surrender']>
}) {
  const surrenderTick = surrender?.tick
  const muted = (tick: number): boolean => surrenderTick !== undefined && tick > surrenderTick
  if (events.length === 0 && surrender === undefined) {
    return <div className="policy-timeline-empty">對局中未調整政策</div>
  }
  const positionPct = (tick: number): number =>
    durationTicks <= 0 ? 0 : Math.min(100, Math.max(0, (tick / durationTicks) * 100))
  return (
    <div data-testid="policy-timeline">
      <div className="policy-timeline-axis">
        {surrender !== undefined ? (
          <span
            className="policy-timeline-marker post-game-surrender-flag"
            data-testid="policy-timeline-surrender-flag"
            style={{ left: `${positionPct(surrender.tick)}%`, color: '#f5f7fa' }}
            title={surrenderHoverTitle(surrender)}
          >
            ⚑
          </span>
        ) : null}
        {events.map((event, index) => (
          <span
            key={`${event.tick}-${event.key}-${index}`}
            className="policy-timeline-marker"
            style={{ left: `${positionPct(event.tick)}%`, opacity: muted(event.tick) ? 0.4 : 1 }}
            title={`${formatClock(event.tick)} ${event.key} ${event.from.toFixed(2)}→${event.to.toFixed(2)}`}
          >
            ▼
          </span>
        ))}
      </div>
      {events.length === 0 && surrender !== undefined ? (
        <div className="policy-timeline-empty">對局中未調整政策</div>
      ) : null}
      <ol className="policy-timeline-list">
        {events.map((event, index) => (
          <li
            key={`${event.tick}-${event.key}-${index}`}
            className={muted(event.tick) ? 'post-surrender-muted' : undefined}
          >
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
 * 決策歸因表（Prompt 10.5 完整版）：影響力排序＝**資源成本（藍水晶）為主、
 * 效用分為輔**；`filter` 可限「投降前的我方決策」（10.5c 為什麼會輸／贏佐證）。
 */
function DecisionTable({
  decisions,
  filter,
}: {
  decisions: readonly ReplayDecision[]
  filter?: (decision: ReplayDecision) => boolean
}) {
  const filtered = filter === undefined ? decisions : decisions.filter(filter)
  if (filtered.length === 0) {
    return <div className="policy-timeline-empty">無決策記錄</div>
  }
  const top = [...filtered]
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

/**
 * 關鍵時刻列表（Prompt 10.5c 區塊二）：前 5 個「如果當時改成 X」——
 * 規則式陳述（當時第二候選＋分差）；重放驗證由反事實區塊承擔。
 */
function LostMomentsList({ moments }: { moments: ReturnType<typeof lostMoments> }) {
  if (moments.length === 0) {
    return (
      <div className="policy-timeline-empty" data-testid="lost-moments-list">
        投降前沒有勢均力敵的備選決策可對照
      </div>
    )
  }
  return (
    <ol className="policy-timeline-list" data-testid="lost-moments-list">
      {moments.map((moment, index) => (
        <li key={`${moment.tick}-${moment.target}-${index}`}>
          <span className="decision-log-time">{formatClock(moment.tick)}</span>
          <span>
            {moment.action === 'build' ? '蓋' : '生'} {moment.target}（當時選 {moment.chosen}
            ）→ 如果改成 <strong>{moment.alternative}</strong>｜當時分差{' '}
            {moment.gap.toFixed(2)}（越小越勢均力敵）｜反事實區塊可從此刻重放驗證
          </span>
        </li>
      ))}
    </ol>
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

/** 重放結局的一行文案（反事實建議列）。 */
function outcomeText(outcome: { result: string; durationTicks: number }): string {
  const verdict =
    outcome.result === 'player' ? '轉勝' : outcome.result === 'enemy' ? '仍敗' : '平手'
  return `重放：${verdict}（時長 ${formatClock(outcome.durationTicks)}）`
}

/**
 * 局勢快照區塊（Prompt 10.5c 區塊一）：投降時間點／戰力比／收入比／建築數
 * ＋投降前 30 秒（600 tick）戰力小圖。tint 依視圖紅／綠（不羞辱——中性措辭）。
 */
function SnapshotBlock({
  replay,
  tone,
}: {
  replay: ReplayRecord
  tone: 'bad' | 'good'
}) {
  const surrender = replay.surrender
  if (surrender === undefined) return null
  const windowSamples = sliceWindow(replay.powerSeries, surrender.tick)
  return (
    <section className={`post-game-section post-snapshot-${tone}`} data-testid="post-game-snapshot">
      <h2>{tone === 'bad' ? '投降時刻的局勢' : '勝利時刻的局勢'}</h2>
      <div className="post-game-armor" data-testid="snapshot-facts">
        <div>
          時間點 <strong>{formatClock(surrender.tick)}</strong>
          {surrender.type === 'ai_surrender' ? `｜絕望指數 ${surrender.despairAtSurrender.toFixed(2)}` : '｜手動觸發'}
        </div>
        <div>
          當時戰力比 <strong>{surrender.powerRatio.toFixed(2)}</strong>
          ｜收入比 <strong>{surrender.incomeRatio.toFixed(2)}</strong>
        </div>
        <div>
          當時建築數{' '}
          {surrender.buildingCount === undefined
            ? '--'
            : `我方 ${surrender.buildingCount.player}｜敵方 ${surrender.buildingCount.enemy}`}
        </div>
      </div>
      <div className="pre-game-note">投降前 30 秒戰力走勢（灰底之後為投降後時間）</div>
      <TwoLineChart
        samples={windowSamples}
        durationTicks={surrender.tick}
        width={560}
        height={96}
        testId="snapshot-power-chart"
      />
    </section>
  )
}

/**
 * 反事實區塊（Prompt 10.5c 區塊三＋四）：3 個快照點 × 3 維度建議，每條
 * **真實 headless 重放**（同 seed、自快照 tick 起改一個滑桿）——顯示重放
 * 結局；點「以此參數重玩」→ 以快照時刻政策＋覆寫從 tick 0 開新局。
 *
 * 計算策略：內容包載入後按快照點分批（每批一個 setTimeout 讓 UI 呼吸，
 * 整場重放實測 ~0.9s／場）；缺 initialPolicies（舊檔）→ 顯示不可用。
 */
function CounterfactualSection({
  replay,
  content,
  onReplayWithPolicies,
  onRestart,
}: {
  replay: ReplayRecord
  content: ContentPack | null
  onReplayWithPolicies: (values: PolicyValues) => void
  onRestart: () => void
}) {
  const timeline = useMemo(
    () =>
      replay.initialPolicies === undefined
        ? null
        : buildPolicyTimeline(replay.initialPolicies, replay.policyEvents, replay.tempoEvents ?? []),
    [replay],
  )
  const points = useMemo(() => counterfactualPoints(replay), [replay])
  // 計算結果與其對應的快照點集一起存——replay 換局時派生自動清空（無 reset effect）。
  const [results, setResults] = useState<{
    points: number[]
    data: Record<number, CounterfactualSuggestion[]>
  }>({ points: [], data: {} })
  const computed = results.points === points ? results.data : {}
  const progress = {
    done: points.filter((tick) => computed[tick] !== undefined).length,
    total: points.length,
  }

  useEffect(() => {
    if (content === null || timeline === null) return
    let cancelled = false
    const data: Record<number, CounterfactualSuggestion[]> = {}
    const runNext = (index: number): void => {
      if (cancelled || index >= points.length) return
      const tick = points[index]
      if (tick === undefined) return
      const suggestions = suggestCounterfactuals(content, replay, timeline, tick)
      if (cancelled) return
      data[tick] = suggestions
      setResults({ points, data: { ...data } })
      window.setTimeout(() => runNext(index + 1), 0)
    }
    const handle = window.setTimeout(() => runNext(0), 0)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [content, timeline, points, replay])

  const allSuggestions = points
    .map((tick) => ({ tick, suggestions: computed[tick] }))
    .filter((entry) => entry.suggestions !== undefined)
  // 最佳建議：先找「重放轉勝」的條目（含其快照 tick）；否則第一條（帶其 tick）。
  const allFlat = allSuggestions.flatMap((entry) =>
    (entry.suggestions ?? []).map((suggestion) => ({ tick: entry.tick, suggestion })),
  )
  const best =
    allFlat.find((entry) => entry.suggestion.outcome.result === 'player') ?? allFlat[0]

  const replayWith = (tick: number, key: string, to: number): void => {
    const values = replayPoliciesOf(replay, tick, key, to)
    if (values !== null) onReplayWithPolicies(values)
  }

  if (replay.initialPolicies === undefined) {
    return (
      <section className="post-game-section">
        <h2>反事實建議</h2>
        <div className="policy-timeline-empty" data-testid="counterfactual-unavailable">
          此 replay 缺開局政策快照（舊檔格式）——反事實重放不可用
        </div>
      </section>
    )
  }
  return (
    <section className="post-game-section" data-testid="counterfactual-block">
      <h2>反事實建議（如果當時改成 X——真實重放驗證）</h2>
      {content === null ? (
        <div className="policy-timeline-empty" data-testid="counterfactual-loading">
          載入內容包中…
        </div>
      ) : (
        <>
          {progress.done < progress.total ? (
            <div className="policy-timeline-empty" data-testid="counterfactual-progress">
              計算中…（{progress.done}/{progress.total} 個快照點；每場重放約 1 秒）
            </div>
          ) : null}
          <div data-testid="counterfactual-points">
            {allSuggestions.map(({ tick, suggestions }) => (
              <div key={tick} className="post-cf-point" data-testid={`counterfactual-point-${tick}`}>
                <div className="post-cf-point-title">快照 {formatClock(tick)}（當時政策重放起點）</div>
                <ol className="policy-timeline-list" data-testid="counterfactual-suggestion-list">
                  {(suggestions ?? []).map((suggestion) => (
                    <li key={suggestion.key}>
                      <span className="decision-log-time">{suggestion.label}</span>
                      <span>
                        {suggestion.from.toFixed(2)} → <strong>{suggestion.to.toFixed(2)}</strong>
                        ｜{outcomeText(suggestion.outcome)}
                        {'　'}
                        <button
                          type="button"
                          className="post-cf-replay"
                          data-testid="counterfactual-replay-button"
                          onClick={() => replayWith(tick, suggestion.key, suggestion.to)}
                        >
                          以此參數重玩
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div className="post-cf-actions" data-testid="post-game-actions">
            <button
              type="button"
              className="post-game-restart"
              data-testid="replay-with-suggestion"
              disabled={best === undefined}
              onClick={() => {
                if (best === undefined) return
                replayWith(best.tick, best.suggestion.key, best.suggestion.to)
              }}
            >
              用建議參數重玩
            </button>
            <button type="button" className="post-game-restart" data-testid="replay-adjust-policy" onClick={onRestart}>
              調整 Policy 重玩
            </button>
            <button type="button" className="post-game-restart" data-testid="back-to-menu" onClick={onRestart}>
              回到主選單
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export function PostGamePanel({
  replay,
  onRestart,
  onReplayWithPolicies,
  content: contentProp,
}: {
  replay: ReplayRecord
  /** 「調整 Policy 重玩／回到主選單／再來一場」：回 /pre-game。 */
  onRestart: () => void
  /** 「用建議參數重玩」：寫入初始政策（快照時刻＋覆寫）並開新局（App 接線）。 */
  onReplayWithPolicies: (values: PolicyValues) => void
  /** 內容包（App 載入；測試可直接注入）——反事實重放計算用；null = 載入中。 */
  content?: ContentPack | null
}) {
  // 內容包：props 注入（App 載入／測試）優先；未注入才自行 fetch（舊用法）。
  // 派生而非同步 setState——避免 effect 內 cascading render（oxlint react 規則）。
  const [fetchedContent, setFetchedContent] = useState<ContentPack | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    if (contentProp !== undefined) return
    let alive = true
    loadContentPackFromFetch('/data')
      .then((pack) => {
        if (alive) setFetchedContent(pack)
      })
      .catch(() => {
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [contentProp])
  const content = contentProp !== undefined ? contentProp : fetchedContent

  const endType = endTypeOf(replay)
  const copy = headerCopyOf(endType, replay.result)
  const result = resultDisplay(replay.result)
  const surrenderTick = replay.surrender?.tick
  const isSurrenderGame = replay.surrender !== undefined
  const preSurrenderFilter = (decision: ReplayDecision): boolean =>
    surrenderTick === undefined || decision.tick <= surrenderTick
  const lostMomentsList = useMemo(
    () =>
      replay.decisions !== undefined && endType === 'player_surrender' && surrenderTick !== undefined
        ? lostMoments(replay.decisions, surrenderTick)
        : [],
    [replay.decisions, endType, surrenderTick],
  )

  return (
    <div className={`post-game post-game-${endType}`} data-testid="post-game-panel">
      <h1 className="post-game-title" data-testid="post-game-title" style={{ color: copy.accent }}>
        {copy.title}
      </h1>
      <div className="post-game-subtitle" data-testid="post-game-subtitle">
        {copy.subtitle}
      </div>
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

      {endType !== 'normal_end' ? (
        <SnapshotBlock replay={replay} tone={endType === 'player_surrender' ? 'bad' : 'good'} />
      ) : null}

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
            surrenderTick={surrenderTick}
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
          surrenderTick={surrenderTick}
        />
      </section>

      {replay.tierCountSeries !== undefined ? (
        <section className="post-game-section">
          <h2>單位數量堆疊（按 tier）</h2>
          <TierStackChart
            samples={replay.tierCountSeries}
            durationTicks={replay.durationTicks}
            surrenderTick={surrenderTick}
          />
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
          surrenderTick={surrenderTick}
        />
      </section>

      {replay.deathEvents !== undefined || isSurrenderGame ? (
        <section className="post-game-section">
          <h2>戰鬥事件時間軸（單位陣亡）</h2>
          <EventTimeline
            events={deathTimeline(replay.deathEvents ?? [])}
            durationTicks={replay.durationTicks}
            markerColorOf={(index) =>
              replay.deathEvents?.[index]?.player === 'player' ? '#e05c5c' : '#6f8ecf'
            }
            testId="combat-timeline"
            listTestId="combat-timeline-list"
            emptyText="對局中無陣亡"
            surrender={replay.surrender}
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
            surrender={replay.surrender}
          />
        </section>
      ) : null}

      {endType === 'normal_end' ? (
        <section className="post-game-section">
          <h2>Policy 調整時間軸</h2>
          <PolicyTimeline events={replay.policyEvents} durationTicks={replay.durationTicks} />
        </section>
      ) : (
        <section className="post-game-section">
          <h2>Policy 調整時間軸（投旗之後灰化）</h2>
          <PolicyTimeline
            events={replay.policyEvents}
            durationTicks={replay.durationTicks}
            surrender={replay.surrender}
          />
        </section>
      )}

      {replay.decisions !== undefined ? (
        endType === 'player_surrender' ? (
          <section className="post-game-section">
            <h2>為什麼會輸？（投降前的關鍵決策與備選）</h2>
            <DecisionTable decisions={replay.decisions} filter={preSurrenderFilter} />
            <div className="pre-game-note">前 5 個勢均力敵的抉擇時刻（分差小 → 當時選另一個也可能翻盤）</div>
            <LostMomentsList moments={lostMomentsList} />
          </section>
        ) : endType === 'ai_surrender' ? (
          <section className="post-game-section">
            <h2>你的 Policy 為什麼贏？（關鍵決策佐證）</h2>
            <DecisionTable decisions={replay.decisions} filter={preSurrenderFilter} />
            <div className="pre-game-note" data-testid="ai-surrender-challenge">
              下次可以挑戰：提高對手難度（敵方滑桿目前固定預設值），或換一套極端取向的
              Policy（全軍事／全經濟）測試這套設計的邊界。
            </div>
          </section>
        ) : (
          <section className="post-game-section">
            <h2>決策歸因（前 10 關鍵決策，依成本排序）</h2>
            <DecisionTable decisions={replay.decisions} />
          </section>
        )
      ) : null}

      {replay.armorStats !== undefined ? (
        <section className="post-game-section">
          <h2>裝甲效益</h2>
          <ArmorBlock armor={replay.armorStats} />
        </section>
      ) : null}

      {loadFailed ? (
        <section className="post-game-section">
          <h2>反事實建議</h2>
          <div className="policy-timeline-empty" data-testid="counterfactual-load-error">
            內容包載入失敗——反事實建議暫不可用（不影響其他復盤內容）
          </div>
        </section>
      ) : (
        <CounterfactualSection
          replay={replay}
          content={content}
          onReplayWithPolicies={onReplayWithPolicies}
          onRestart={onRestart}
        />
      )}

      {endType === 'normal_end' ? (
        <button type="button" className="post-game-restart" data-testid="post-game-restart" onClick={onRestart}>
          再來一場
        </button>
      ) : null}
    </div>
  )
}
