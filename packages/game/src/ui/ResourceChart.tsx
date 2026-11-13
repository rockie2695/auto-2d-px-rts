import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'

import { chartDomain, chartPoints, formatClock, uplotTripleData } from './collector.ts'
import type { SamplePoint } from './collector.ts'
import {
  drawEndDot,
  drawSeriesLine,
  drawYAxis,
  EMERALD_LINE_COLOR,
  ENEMY_LINE_COLOR,
  PLAYER_LINE_COLOR,
  RUBY_LINE_COLOR,
} from './chartDraw.ts'
import type { PlotGeometry } from './chartDraw.ts'

/**
 * 左上：資源／單位數量／戰力 曲線（Prompt 9.5 / 9.5 完整版 / 10 / 10.6）。
 * 下拉選單切換三種指標（皆 60 秒滾動窗）：
 * - 資源曲線（**uPlot 三線**，Prompt 9.5 完整版）：我方藍水晶／紅寶石／綠翡翠，
 *   線尾標收入率（`playerIncomes`，`x.x/s`）；1Hz 更新（取樣在 `BattleDashboard`）。
 * - 單位數量：雙方存活單位數（canvas 雙線，既有）
 * - 戰力：雙方有效當量戰力（canvas 雙線，既有）
 * 雙線模式：敵方紅 3px 墊底、我方藍 2px 疊上；線尾色點；圖例。
 * 繪圖工具在 `chartDraw.ts`，取樣在 `BattleDashboard`（三個 `ResourceSeries`）。
 */

export type ChartMode = 'resources' | 'units' | 'power'

const MODES: ReadonlyArray<{ id: ChartMode; label: string }> = [
  { id: 'resources', label: '資源曲線' },
  { id: 'units', label: '單位數量' },
  { id: 'power', label: '戰力' },
]

/** uPlot 選項（像素風：無平滑、mono、深底；Prompt 9.5 完整版）。 */
function uplotOptions(width: number, height: number): uPlot.Options {
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
        // x 值是「秒」——格式化為 m:ss（uPlot 預設把數值 x 當 1970 時間戳）。
        values: (_self, ticks) => ticks.map((seconds) => formatClock(seconds * 20)),
      },
      {
        stroke: '#5a6472',
        grid: { show: true, width: 1, stroke: '#242a33' },
        ticks: { show: false },
        font: '9px monospace',
      },
    ],
    series: [
      {},
      { stroke: PLAYER_LINE_COLOR, width: 2 },
      { stroke: RUBY_LINE_COLOR, width: 2 },
      { stroke: EMERALD_LINE_COLOR, width: 2 },
    ],
  }
}

export function ResourceChart({
  crystalSamples,
  unitSamples,
  powerSamples,
  rubySamples = [],
  emeraldSamples = [],
  playerIncomes,
}: {
  /** 我方水晶存量取樣（60 秒滾動窗；uPlot 模式取 player 值）。 */
  crystalSamples: readonly SamplePoint[]
  /** 雙方存活單位數取樣。 */
  unitSamples: readonly SamplePoint[]
  /** 雙方戰力取樣。 */
  powerSamples: readonly SamplePoint[]
  /** 我方紅寶石存量取樣（uPlot 模式）。 */
  rubySamples?: readonly SamplePoint[]
  /** 我方綠翡翠存量取樣（uPlot 模式）。 */
  emeraldSamples?: readonly SamplePoint[]
  /** 我方三資源收入率（每秒；線尾標籤，Prompt 9.5 完整版）。 */
  playerIncomes?: { blue_crystal: number; red_ruby: number; green_emerald: number }
}) {
  const [mode, setMode] = useState<ChartMode>('resources')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const plotHostRef = useRef<HTMLDivElement | null>(null)

  // uPlot 模式：實例只建一次（resize 無關——面板寬度固定），資料 setData 更新。
  useEffect(() => {
    if (mode !== 'resources') return
    const host = plotHostRef.current
    if (host === null) return
    const data = uplotTripleData(crystalSamples, rubySamples, emeraldSamples)
    if (data[0].length === 0) {
      plotRef.current?.destroy()
      plotRef.current = null
      return
    }
    if (plotRef.current === null) {
      plotRef.current = new uPlot(uplotOptions(240, 64), data, host)
    } else {
      plotRef.current.setData(data)
    }
    return () => {
      if (mode !== 'resources') {
        plotRef.current?.destroy()
        plotRef.current = null
      }
    }
  }, [mode, crystalSamples, rubySamples, emeraldSamples])
  // 模式離開 resources 時銷毀實例（effect 重跑時 mode 已是新值）。
  useEffect(() => {
    if (mode === 'resources') return
    plotRef.current?.destroy()
    plotRef.current = null
  }, [mode])
  useEffect(() => () => {
    plotRef.current?.destroy()
    plotRef.current = null
  }, [])

  const samples = mode === 'units' ? unitSamples : powerSamples

  useEffect(() => {
    if (mode === 'resources') return
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#2a2f38'
    ctx.fillRect(0, 0, width, height)
    const plot: PlotGeometry = { left: 34, right: width - 6, top: 8, bottom: height - 8 }

    const domain = chartDomain(samples)
    if (domain === null) {
      ctx.fillStyle = '#808a96'
      ctx.textAlign = 'left'
      ctx.fillText('等待資料…', 8, height / 2 + 4)
      return
    }
    drawYAxis(ctx, domain, plot)
    const enemy = chartPoints(samples, (point) => point.enemy)
    const player = chartPoints(samples, (point) => point.player)
    drawSeriesLine(ctx, enemy, plot, ENEMY_LINE_COLOR, 3)
    drawSeriesLine(ctx, player, plot, PLAYER_LINE_COLOR, 2)
    drawEndDot(ctx, enemy, plot, ENEMY_LINE_COLOR)
    drawEndDot(ctx, player, plot, PLAYER_LINE_COLOR)

    // 圖例（右上角）：色塊 + 名稱。
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = PLAYER_LINE_COLOR
    ctx.fillRect(width - 52, 6, 6, 6)
    ctx.fillText('我方', width - 43, 12)
    ctx.fillStyle = ENEMY_LINE_COLOR
    ctx.fillRect(width - 52, 18, 6, 6)
    ctx.fillText('敵方', width - 43, 24)
  }, [mode, samples])

  const incomes = playerIncomes
  return (
    <aside className="hud-panel panel-top-left" data-testid="resource-chart">
      <div className="hud-panel-title">
        <span>{MODES.find((item) => item.id === mode)?.label ?? ''}（60 秒）</span>
        <select
          className="chart-mode-select"
          data-testid="chart-mode"
          aria-label="切換圖表指標"
          value={mode}
          onChange={(event) => setMode(event.target.value as ChartMode)}
        >
          {MODES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      {mode === 'resources' ? (
        <>
          <div ref={plotHostRef} data-testid="uplot-host" />
          {incomes !== undefined ? (
            <div className="income-tail" data-testid="income-tail">
              <span style={{ color: PLAYER_LINE_COLOR }}>藍 {incomes.blue_crystal.toFixed(1)}/s</span>
              <span style={{ color: RUBY_LINE_COLOR }}>紅 {incomes.red_ruby.toFixed(1)}/s</span>
              <span style={{ color: EMERALD_LINE_COLOR }}>綠 {incomes.green_emerald.toFixed(1)}/s</span>
            </div>
          ) : null}
        </>
      ) : (
        <canvas ref={canvasRef} width={240} height={64} className="resource-chart-canvas" />
      )}
    </aside>
  )
}
