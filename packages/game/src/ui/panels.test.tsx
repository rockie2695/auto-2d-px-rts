/**
 * @vitest-environment jsdom
 */

import { StrictMode, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { ResourceSeries } from './collector.ts'
import { DecisionLogPanel } from './DecisionLogPanel.tsx'
import { formatClock, layerLabel } from './collector.ts'
import { ResourceChart } from './ResourceChart.tsx'
import { ResourcePanel } from './ResourcePanel.tsx'
import { SquadPanel } from './SquadPanel.tsx'
import type { DecisionLogEntry, SquadInfo } from '../session.ts'

/**
 * 四角 HUD 展示面板測試（Prompt 9.5 驗收）：
 * props 驅動（不碰 session 實作）——
 * 資源數字與收入、戰力比色階（紅/黃/綠切換）、日誌最多 5 條、
 * 小隊一隊一行、資源曲線有 canvas 元素。
 */

const logEntry = (
  sequence: number,
  tick: number,
  text: string,
  layer: DecisionLogEntry['layer'],
): DecisionLogEntry => ({
  sequence,
  tick,
  layer,
  actor: 'player',
  text,
})

const squadOf = (
  player: SquadInfo['player'],
  index: number,
  mission: string,
  dist: number,
): SquadInfo => ({
  player,
  index,
  mission,
  targetX: 20,
  targetY: 20,
  memberCount: 2,
  power: 84,
  distTiles: dist,
})

/* ---------- 掛載工具 ---------- */

let mounted: { container: HTMLElement; root: ReturnType<typeof createRoot> } | null = null

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StrictMode>{node}</StrictMode>)
  })
  if (mounted !== null) {
    act(() => {
      mounted?.root.unmount()
    })
    mounted.container.remove()
  }
  mounted = { container, root }
  return container
}

afterEach(() => {
  if (mounted === null) return
  act(() => {
    mounted?.root.unmount()
  })
  mounted.container.remove()
  mounted = null
})

const textOf = (container: HTMLElement): string => container.textContent ?? ''

/* ---------- 資源面板 ---------- */

describe('ResourcePanel（右上）', () => {
  it('顯示雙方水晶、收入與戰力比', () => {
    const container = render(
      <ResourcePanel
        playerCrystal={51}
        enemyCrystal={40}
        playerIncome={1.2}
        enemyIncome={0.5}
        ratio={1.1}
      />,
    )
    expect(textOf(container)).toContain('我方水晶51（+1.2/s）')
    expect(textOf(container)).toContain('敵方水晶40（+0.5/s）')
    expect(container.querySelector('[data-testid="ratio-value"]')?.textContent).toBe('1.10')
  })

  it('收入未知顯示 --', () => {
    const container = render(
      <ResourcePanel playerCrystal={3} enemyCrystal={3} playerIncome={null} enemyIncome={null} ratio={1} />,
    )
    expect(textOf(container)).toContain('--')
  })
})

describe('戰力比色階（0.7、1.4 邊界走黃）', () => {
  it('紅 / 黃 / 綠隨比例切換（0.7 以下紅、1.4 以上綠）', () => {
    const cases: Array<{ ratio: number; expected: string }> = [
      { ratio: 0.5, expected: 'rgb(255, 122, 122)' },
      { ratio: 0.7, expected: 'rgb(255, 216, 102)' },
      { ratio: 1.1, expected: 'rgb(255, 216, 102)' },
      { ratio: 1.4, expected: 'rgb(255, 216, 102)' },
      { ratio: 2.0, expected: 'rgb(124, 227, 139)' },
    ]
    for (const item of cases) {
      const container = render(
        <ResourcePanel
          playerCrystal={0}
          enemyCrystal={0}
          playerIncome={null}
          enemyIncome={null}
          ratio={item.ratio}
        />,
      )
      const value = container.querySelector('[data-testid="ratio-value"]') as HTMLElement
      expect(value.style.color).toBe(item.expected)
    }
  })
})

/* ---------- 決策日誌 ---------- */

describe('DecisionLogPanel（左下）', () => {
  it('顯示最新 5 條、新的在上（時間 + 層級 + 動作原因）', () => {
    const entries: DecisionLogEntry[] = [
      logEntry(1, 100, 'build mine（收入不足）', 'strategic'),
      logEntry(2, 120, '小隊 #0 attack→defend（兵力不足）', 'tactical'),
      logEntry(3, 140, 'build barracks（軍事建築不足）', 'strategic'),
      logEntry(4, 200, 'train legionnaire（補足軍力）', 'strategic'),
      logEntry(5, 240, '小隊 #1 目標改為 (20,20)', 'tactical'),
      logEntry(6, 260, 'build mine（第二座礦場）', 'strategic'), // 應淘汰第 1 條
    ]
    const container = render(<DecisionLogPanel entries={entries} />)
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(5)
    expect(items[0]?.textContent).toContain('0:13') // tick 260 → 13 秒
    expect(items[0]?.textContent).toContain('[戰略]')
    expect(items[0]?.textContent).toContain('build mine（第二座礦場）')
    expect(items[4]?.textContent).toContain('小隊 #0 attack→defend')
    expect(textOf(container)).not.toContain('build mine（收入不足）')
  })

  it('空日誌顯示尚未有決策；formatClock / layerLabel', () => {
    const container = render(<DecisionLogPanel entries={[]} />)
    expect(textOf(container)).toContain('尚未有決策')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(2700)).toBe('2:15') // SPEC 例
    expect(layerLabel('strategic')).toBe('戰略')
    expect(layerLabel('tactical')).toBe('戰術')
  })
})

/* ---------- 小隊狀態 ---------- */

describe('SquadPanel（右下）', () => {
  it('一隊一行：任務 + 人數 + 戰力 + 距離', () => {
    const squads: SquadInfo[] = [squadOf('player', 0, 'attack', 3), squadOf('enemy', 0, 'defend', 0)]
    const container = render(<SquadPanel squads={squads} />)
    const items = container.querySelectorAll('ul.squad-list li')
    expect(items.length).toBe(2)
    expect(items[0]?.textContent).toContain('我')
    expect(items[0]?.textContent).toContain('#0')
    expect(items[0]?.textContent).toContain('進攻')
    expect(items[0]?.textContent).toContain('2 人')
    expect(items[0]?.textContent).toContain('戰力 84')
    expect(items[0]?.textContent).toContain('距 3 格')
    expect(items[1]?.textContent).toContain('敵')
    expect(items[1]?.textContent).toContain('守備')
  })

  it('未編隊顯示提示', () => {
    const container = render(<SquadPanel squads={[]} />)
    expect(textOf(container)).toContain('尚未編隊')
  })
})

/* ---------- 資源曲線 ---------- */

describe('ResourceChart（左上）', () => {
  it('有樣本時掛出 canvas 且畫折線（不出等待文案）', () => {
    const series = new ResourceSeries()
    series.push(0, 10)
    series.push(100, 12)
    const container = render(<ResourceChart samples={series.chart()} />)
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(textOf(container)).not.toContain('等待資料')
  })

  it('空樣本：canvas 仍在，畫面走等待分支不擲錯', () => {
    const container = render(<ResourceChart samples={[]} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull() // 空樣本 → 折線分支跳過，畫「等待資料」文字於 canvas 上
  })
})
