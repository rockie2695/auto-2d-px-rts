/**
 * @vitest-environment jsdom
 */

import { StrictMode, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// uPlot 在模組初始化時就碰 `matchMedia`（jsdom 沒有）——測試環境整體 mock：
// 建構子/setData 記下收到的資料，供「圖表能正確渲染」斷言（Prompt 9.5 驗收）。
const uplotInstances: Array<{ opts: unknown; data: unknown; setData: (data: unknown) => void; destroy: () => void }> = []
vi.mock('uplot', () => ({
  default: class FakeUPlot {
    opts: unknown
    data: unknown
    constructor(opts: unknown, data: unknown) {
      this.opts = opts
      this.data = data
      uplotInstances.push(this)
    }
    setData(data: unknown): void {
      this.data = data
    }
    destroy(): void {
      // 測試無需清理
    }
  },
}))

import { DecisionLogPanel } from './DecisionLogPanel.tsx'
import { formatClock, layerLabel } from './collector.ts'
import { PolicyPanel } from './PolicyPanel.tsx'
import type { PolicyApplyPayload } from './PolicyPanel.tsx'
import type { PolicyValues } from '../ai/policy.ts'
import { PostGamePanel } from './PostGamePanel.tsx'
import { ResourceChart } from './ResourceChart.tsx'
import { ResourcePanel } from './ResourcePanel.tsx'
import { SquadPanel } from './SquadPanel.tsx'
import type { DecisionLogEntry, PolicySnapshot, SquadInfo } from '../session.ts'
import type { ReplayRecord } from '../replay.ts'

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
  engaging: false,
})

const DEFAULT_POLICY_VALUES: PolicyValues = {
  econMilitary: 0.5,
  unitSize: 0.5,
  unitRange: 0.5,
  aggression: 0.5,
  clusterSpread: 0.5,
  expansion: 0.5,
  techRush: 0.5,
  reserve: 0.5,
  retreatThreshold: 0.5,
  resourceBias: { blue: 0.5, red: 0.5, green: 0.5 },
  tempoPreset: 'standard',
}

const policyOf = (
  overrides?: Partial<Omit<PolicySnapshot, 'values'>> & {
    values?: Partial<PolicyValues> & { resourceBias?: Partial<PolicyValues['resourceBias']> }
  },
): PolicySnapshot => {
  const { values: valueOverrides, ...rest } = overrides ?? {}
  const { resourceBias, ...restValues } = valueOverrides ?? {}
  return {
    values: {
      ...DEFAULT_POLICY_VALUES,
      ...restValues,
      resourceBias: { ...DEFAULT_POLICY_VALUES.resourceBias, ...resourceBias },
    },
    cooldownRemainingTicks: 0,
    summary: null,
    tick: 0,
    ...rest,
  }
}

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

describe('ResourcePanel（右上；Prompt 5 三資源）', () => {
  it('顯示三資源庫存、各自收入與戰力比', () => {
    const container = render(
      <ResourcePanel
        playerResources={{ blue_crystal: 51, red_ruby: 12, green_emerald: 3 }}
        enemyResources={{ blue_crystal: 40, red_ruby: 0, green_emerald: 0 }}
        playerIncomes={{ blue_crystal: 1.2, red_ruby: 0.5, green_emerald: 0.2 }}
        ratio={1.1}
      />,
    )
    expect(textOf(container)).toContain('藍水晶51（+1.2/s）')
    expect(textOf(container)).toContain('紅寶石12（+0.5/s）')
    expect(textOf(container)).toContain('綠翡翠3（+0.2/s）')
    expect(textOf(container)).toContain('敵方三資源40/0/0')
    expect(container.querySelector('[data-testid="ratio-value"]')?.textContent).toBe('1.10')
  })

  it('收入未知顯示 --', () => {
    const container = render(
      <ResourcePanel
        playerResources={{ blue_crystal: 3, red_ruby: 0, green_emerald: 0 }}
        enemyResources={{ blue_crystal: 3, red_ruby: 0, green_emerald: 0 }}
        playerIncomes={{ blue_crystal: null as unknown as number, red_ruby: 0, green_emerald: 0 }}
        ratio={1}
      />,
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
          playerResources={{ blue_crystal: 0, red_ruby: 0, green_emerald: 0 }}
          enemyResources={{ blue_crystal: 0, red_ruby: 0, green_emerald: 0 }}
          playerIncomes={{ blue_crystal: 0, red_ruby: 0, green_emerald: 0 }}
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
  it('顯示最近 10 條、新的在上（時間 + 層級 + 動作原因）', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 21; index++) {
      entries.push(logEntry(index, index * 20, `決策 ${index}`, 'strategic'))
    }
    const container = render(<DecisionLogPanel entries={entries} />)
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(10) // 21 條 → 顯示最近 10 條（Prompt 9.5 完整版）
    expect(items[0]?.textContent).toContain('決策 21') // 新的在上
    expect(items[9]?.textContent).toContain('決策 12') // 第 11 條被淘汰
  })

  it('空日誌顯示尚未有決策；formatClock / layerLabel', () => {
    const container = render(<DecisionLogPanel entries={[]} />)
    expect(textOf(container)).toContain('尚未有決策')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(2700)).toBe('2:15') // SPEC 例
    expect(layerLabel('strategic')).toBe('戰略')
    expect(layerLabel('tactical')).toBe('戰術')
    expect(layerLabel('policy')).toBe('政策')
    expect(layerLabel('micro')).toBe('微操')
  })

  it('陣營色帶（Prompt 10.20）：藍列 actor-player、紅列 actor-enemy', () => {
    const entries: DecisionLogEntry[] = [
      { ...logEntry(1, 20, '藍方決策', 'strategic'), actor: 'player' },
      { ...logEntry(2, 40, '紅方決策', 'strategic'), actor: 'enemy' },
    ]
    const container = render(<DecisionLogPanel entries={entries} />)
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items[0]?.className).toContain('actor-enemy') // 新的在上（紅）
    expect(items[1]?.className).toContain('actor-player')
  })

  it('篩選片（Prompt 10.20）：先篩選再取 10 條；陣營 × 層級可組合', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 25; index++) {
      const actor = index % 2 === 0 ? 'player' : 'enemy'
      entries.push({
        ...logEntry(index, index * 20, `決策 ${index}`, index % 3 === 0 ? 'tactical' : 'strategic'),
        actor,
      })
    }
    const container = render(<DecisionLogPanel entries={entries} />)

    // 藍：25 條中 12 條（偶數 index）→ 取最新 10 條。
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-player"]') as HTMLButtonElement).click()
    })
    let items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(10)
    expect(Array.from(items).every((item) => item.className.includes('actor-player'))).toBe(true)

    // 藍 × 戰略：12 條藍中非 3 的倍數者共 8 條（≤ 10 全顯示）。
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-layer-strategic"]') as HTMLButtonElement).click()
    })
    items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(8)

    // 紅 × 戰術：紅為奇數 index、戰術為 3 的倍數 → 4 條。
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-all"]') as HTMLButtonElement).click()
      ;(container.querySelector('[data-testid="decision-log-chip-team-enemy"]') as HTMLButtonElement).click()
      ;(container.querySelector('[data-testid="decision-log-chip-layer-tactical"]') as HTMLButtonElement).click()
    })
    items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(4)
    expect(items[0]?.textContent).toContain('決策 21') // 最新（紅 × 戰術：3,9,15,21）
  })

  it('篩選後仍只顯示最近 10 條（先篩選再切片）', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 30; index++) {
      entries.push({ ...logEntry(index, index * 20, `紅決策 ${index}`, 'strategic'), actor: 'enemy' })
    }
    const container = render(<DecisionLogPanel entries={entries} />)
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-enemy"]') as HTMLButtonElement).click()
    })
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(10)
    expect(items[0]?.textContent).toContain('紅決策 30')
    expect(items[9]?.textContent).toContain('紅決策 21') // 第 11 條被淘汰
  })

  it('篩選無結果 → 尚未有決策', () => {
    const entries: DecisionLogEntry[] = [logEntry(1, 20, '藍方決策', 'strategic')]
    const container = render(<DecisionLogPanel entries={entries} />)
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-enemy"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('ol.decision-log')).toBeNull()
    expect(textOf(container)).toContain('尚未有決策')
  })

  it('點擊展開候選柱狀圖（Prompt 9.5 完整版）：最高分高亮、分數歸一', () => {
    const entry: DecisionLogEntry = {
      ...logEntry(1, 20, 'train legionnaire（軍事權重主導）', 'strategic'),
      candidates: [
        { defId: 'legionnaire', score: 2.4 },
        { defId: 'archer', score: 1.2 },
      ],
      topFactor: 'militaryWeight',
    }
    const container = render(<DecisionLogPanel entries={[entry]} />)
    // 未展開：沒有柱狀圖。
    expect(container.querySelector('[data-testid="decision-candidates"]')).toBeNull()
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-row-1"]') as HTMLElement).click()
    })
    const panel = container.querySelector('[data-testid="decision-candidates"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('militaryWeight')
    const legionnaire = container.querySelector(
      '[data-testid="decision-candidate-legionnaire"] .decision-candidate-bar',
    ) as HTMLElement
    const archer = container.querySelector(
      '[data-testid="decision-candidate-archer"] .decision-candidate-bar',
    ) as HTMLElement
    expect(legionnaire.style.width).toBe('100%') // 最高分 = 滿寬
    expect(archer.style.width).toBe('50%') // 1.2 / 2.4
    // 最高分列高亮（.top class）。
    expect(
      container.querySelector('[data-testid="decision-candidate-legionnaire"]')?.className,
    ).toContain('top')
    expect(
      container.querySelector('[data-testid="decision-candidate-archer"]')?.className,
    ).not.toContain('top')
    // 再點一次收起。
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-row-1"]') as HTMLElement).click()
    })
    expect(container.querySelector('[data-testid="decision-candidates"]')).toBeNull()
  })

  it('裝甲色標（Prompt 9.5 完整版）：重裝甲紫、超重裝甲金、無甲不標', () => {
    const entries: DecisionLogEntry[] = [
      { ...logEntry(1, 20, 'train shield_guard', 'strategic'), armorTier: 'heavy' },
      { ...logEntry(2, 40, 'train heavy_unit', 'strategic'), armorTier: 'ultra' },
      { ...logEntry(3, 60, 'train archer', 'strategic'), armorTier: 'none' },
    ]
    const container = render(<DecisionLogPanel entries={entries} />)
    const heavy = container.querySelector('[data-testid="decision-armor-1"]') as HTMLElement
    const ultra = container.querySelector('[data-testid="decision-armor-2"]') as HTMLElement
    expect(heavy.textContent).toBe('重甲')
    expect(heavy.style.color).toBe('rgb(180, 74, 255)') // #b44aff
    expect(ultra.textContent).toBe('超重甲')
    expect(ultra.style.color).toBe('rgb(255, 210, 74)') // #ffd24a
    expect(container.querySelector('[data-testid="decision-armor-3"]')).toBeNull()
  })

  it('政策標記（Prompt 9.5 完整版）：政策變更之後的條目掛「受政策影響」', () => {
    const entries: DecisionLogEntry[] = [
      logEntry(1, 20, '之前決策', 'strategic'),
      logEntry(2, 40, '滑桿調整', 'policy'),
      logEntry(3, 60, '之後決策', 'strategic'),
    ]
    const container = render(<DecisionLogPanel entries={entries} />)
    const marks = container.querySelectorAll('[data-testid="decision-policy-mark"]')
    expect(marks.length).toBe(1) // 只有政策變更「之後」的一條
    expect(marks[0]?.parentElement?.textContent).toContain('之後決策')
  })
})

/* ---------- 小隊狀態 ---------- */

describe('SquadPanel（右下）', () => {
  it('一隊一行：狀態色點 + 任務 + 人數 + 戰力 + 距離', () => {
    const squads: SquadInfo[] = [
      squadOf('player', 0, 'attack', 3),
      squadOf('enemy', 0, 'defend', 0),
    ]
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
    // 狀態色點（Prompt 9.5 完整版）：非撤退非交戰 → 綠（#7ce38b）。
    const tone = container.querySelector(
      '[data-testid="squad-tone-player-0"]',
    ) as HTMLElement
    expect(tone.style.background).toBe('rgb(124, 227, 139)')
  })

  it('狀態色（Prompt 9.5 完整版）：撤退紅、交戰黃、其餘綠', () => {
    const squads: SquadInfo[] = [
      squadOf('player', 0, 'retreat', 5),
      { ...squadOf('player', 1, 'attack', 2), engaging: true },
      squadOf('enemy', 0, 'defend', 0),
    ]
    const container = render(<SquadPanel squads={squads} />)
    const retreat = container.querySelector('[data-testid="squad-tone-player-0"]') as HTMLElement
    const engaging = container.querySelector('[data-testid="squad-tone-player-1"]') as HTMLElement
    const safe = container.querySelector('[data-testid="squad-tone-enemy-0"]') as HTMLElement
    expect(retreat.style.background).toBe('rgb(255, 122, 122)') // #ff7a7a
    expect(engaging.style.background).toBe('rgb(255, 216, 102)') // #ffd866
    expect(safe.style.background).toBe('rgb(124, 227, 139)') // #7ce38b
  })

  it('未編隊顯示提示', () => {
    const container = render(<SquadPanel squads={[]} />)
    expect(textOf(container)).toContain('尚未編隊')
  })
})

/* ---------- 資源曲線 ---------- */

describe('ResourceChart（左上；uPlot 三資源 + 雙線切換）', () => {
  const crystalSamples = [
    { tick: 0, player: 10, enemy: 8 },
    { tick: 100, player: 12, enemy: 9 },
  ]
  const unitSamples = [
    { tick: 0, player: 3, enemy: 3 },
    { tick: 100, player: 5, enemy: 4 },
  ]
  const powerSamples = [
    { tick: 0, player: 1440, enemy: 1440 },
    { tick: 100, player: 2000, enemy: 960 },
  ]
  const incomes = { blue_crystal: 0.8, red_ruby: 0.2, green_emerald: 0.1 }

  beforeEach(() => {
    uplotInstances.length = 0
  })

  it('預設資源曲線：uPlot 三線（mock 收到 3 條序列）＋線尾收入率', () => {
    const container = render(
      <ResourceChart
        crystalSamples={crystalSamples}
        unitSamples={unitSamples}
        powerSamples={powerSamples}
        playerIncomes={incomes}
      />,
    )
    expect(container.querySelector('[data-testid="uplot-host"]')).not.toBeNull()
    // StrictMode 雙掛載會建兩個實例（dev 行為）；斷言最後一個實例的資料。
    expect(uplotInstances.length).toBeGreaterThan(0)
    const data = (uplotInstances[uplotInstances.length - 1]?.data ?? null) as
      | [number[], number[], number[], number[]]
      | null
    if (data === null) throw new Error('uPlot 實例未收到資料')
    expect(data[0]).toEqual([0, 5]) // tick/20 → 秒
    expect(data[1]).toEqual([10, 12]) // 藍水晶（player 值）
    // 線尾收入率（x.x/s）。
    const tail = container.querySelector('[data-testid="income-tail"]')
    expect(tail?.textContent).toContain('藍 0.8/s')
    expect(tail?.textContent).toContain('紅 0.2/s')
    expect(tail?.textContent).toContain('綠 0.1/s')
    const select = container.querySelector('[data-testid="chart-mode"]') as HTMLSelectElement
    expect(select.value).toBe('resources')
    const options = [...select.querySelectorAll('option')].map((option) => option.value)
    expect(options).toEqual(['resources', 'units', 'power'])
    expect(textOf(container)).toContain('資源曲線（60 秒）')
  })

  it('資料更新 → setData 推新資料（不重建實例）', () => {
    renderAndRerender(
      <ResourceChart crystalSamples={crystalSamples} unitSamples={unitSamples} powerSamples={powerSamples} />,
      <ResourceChart
        crystalSamples={[...crystalSamples, { tick: 200, player: 15, enemy: 10 }]}
        unitSamples={unitSamples}
        powerSamples={powerSamples}
      />,
    )
    expect(uplotInstances.length).toBeGreaterThan(0)
    const data = (uplotInstances[uplotInstances.length - 1]?.data ?? null) as
      | [number[], number[], number[], number[]]
      | null
    expect(data?.[0]).toEqual([0, 5, 10])
  })

  it('切換模式 → 單位數量／戰力（canvas 雙線仍在）', () => {
    const container = render(
      <ResourceChart
        crystalSamples={crystalSamples}
        unitSamples={unitSamples}
        powerSamples={powerSamples}
      />,
    )
    const select = container.querySelector('[data-testid="chart-mode"]') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      setter?.call(select, 'units')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(textOf(container)).toContain('單位數量（60 秒）')
    expect(container.querySelector('canvas')).not.toBeNull()

    act(() => {
      setter?.call(select, 'power')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(textOf(container)).toContain('戰力（60 秒）')
  })

  it('空樣本：資源模式不建 uPlot 實例；單位模式 canvas 走等待分支', () => {
    const empty = render(<ResourceChart crystalSamples={[]} unitSamples={[]} powerSamples={[]} />)
    expect(uplotInstances.length).toBe(0) // 空樣本 → 不建實例
    const select = empty.querySelector('[data-testid="chart-mode"]') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      setter?.call(select, 'units')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const canvas = empty.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(textOf(empty)).toContain('單位數量（60 秒）')
  })
})

/** render ＋ rerender 工具（uPlot setData 測試用）。 */
function renderAndRerender(first: ReactNode, second: ReactNode): { rerender: (node: ReactNode) => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StrictMode>{first}</StrictMode>)
  })
  act(() => {
    root.render(<StrictMode>{second}</StrictMode>)
  })
  mounted = { container, root }
  return {
    rerender: (node: ReactNode) => {
      act(() => {
        root.render(<StrictMode>{node}</StrictMode>)
      })
    },
  }
}

/* ---------- AI 政策滑桿（Prompt 10：草稿＋套用/還原） ---------- */

describe('PolicyPanel（底部中央；Prompt 10 完整版：三段式 12+1 維度）', () => {
  it('顯示 12 個滑桿（9 方向式＋3 資源比例）＋節奏下拉＋覆蓋預覽＋決策摘要＋可調整狀態', () => {
    const container = render(
      <PolicyPanel policy={policyOf({ summary: 'build mine（收入不足）' })} onApply={() => {}} onEndMatch={() => {}} />,
    )
    // 12 個滑桿（9 維度 + 3 資源比例）、範圍 0–1。
    const sliders = container.querySelectorAll('input[type="range"]')
    expect(sliders.length).toBe(12)
    for (const slider of sliders) {
      expect((slider as HTMLInputElement).min).toBe('0')
      expect((slider as HTMLInputElement).max).toBe('1')
      expect((slider as HTMLInputElement).disabled).toBe(false)
    }
    // 節奏預設下拉（5 選項、預設 standard）。
    const tempo = container.querySelector('[data-testid="policy-tempo"]') as HTMLSelectElement
    expect(tempo).not.toBeNull()
    expect(tempo.value).toBe('standard')
    expect(tempo.querySelectorAll('option').length).toBe(5)
    // 三段式佈局（Prompt 10 完整版）。
    expect(container.querySelector('[data-testid="policy-section-tempo"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="policy-section-sliders"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="policy-section-bias"]')).not.toBeNull()
    // 方向式標籤（Prompt 10 完整版文案）。
    expect(textOf(container)).toContain('經濟 ← → 軍事')
    expect(textOf(container)).toContain('單位體型（大型 ← → 小型）')
    expect(textOf(container)).toContain('近戰 ← → 遠程')
    expect(textOf(container)).toContain('分散 ← → 集群')
    expect(textOf(container)).toContain('固守 ← → 強攻')
    expect(textOf(container)).toContain('龜縮 ← → 擴張')
    expect(textOf(container)).toContain('數量海 ← → 科技優先')
    expect(textOf(container)).toContain('全軍出擊 ← → 重兵留守')
    expect(textOf(container)).toContain('死戰不退 ← → 一有劣勢就撤')
    expect(textOf(container)).toContain('藍水晶礦')
    expect(textOf(container)).toContain('紅寶石礦')
    expect(textOf(container)).toContain('綠翡翠礦')
    // unitSize tooltip（Prompt 10 完整版指定文案，含勢力例外聲明）。
    const unitSize = container.querySelector('[data-testid="slider-unitSize"]') as HTMLInputElement
    expect(unitSize.title).toContain('大型單位：通常高 HP、高 DPS、低速度')
    expect(unitSize.title).toContain('但具體屬性取決於勢力設計，可能存在例外（例如小型高裝甲單位）')
    // simplex 資源比例：0.5/0.5/0.5 → 歸一各 1/3（百分比四捨五入 33%）。
    const redValue = Number(
      (container.querySelector('[data-testid="slider-resourceBias-red"]') as HTMLInputElement)
        .getAttribute('value'),
    )
    expect(Math.abs(redValue - 1 / 3)).toBeLessThan(1e-9)
    expect(container.querySelector('[data-testid="bias-pct-blue"]')?.textContent).toBe('33%')
    expect(container.querySelector('[data-testid="bias-pct-red"]')?.textContent).toBe('33%')
    expect(container.querySelector('[data-testid="bias-pct-green"]')?.textContent).toBe('33%')
    // standard 無時段覆蓋提示。
    expect(container.querySelector('[data-testid="policy-tempo-none"]')?.textContent).toContain('無時段覆蓋')
    // 決策摘要與冷卻狀態。
    expect(container.querySelector('[data-testid="policy-summary"]')?.textContent).toBe(
      'build mine（收入不足）',
    )
    expect(container.querySelector('[data-testid="policy-cooldown"]')?.textContent).toContain('可調整')
  })

  it('冷卻中：無變更時套用鈕禁用、顯示倒數秒數（600 tick → 30s）；節奏下拉免冷卻', () => {
    const container = render(
      <PolicyPanel policy={policyOf({ cooldownRemainingTicks: 600 })} onApply={() => {}} onEndMatch={() => {}} />,
    )
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(container.querySelector('[data-testid="policy-cooldown"]')?.textContent).toContain('冷卻中 30s')
    // 節奏預設免冷卻：下拉不禁用。
    const tempo = container.querySelector('[data-testid="policy-tempo"]') as HTMLSelectElement
    expect(tempo.disabled).toBe(false)
  })

  it('拖動滑桿只改草稿（不觸發 onApply）；按套用 → 整包 draft（12+1 維）呼叫一次', () => {
    const applied: PolicyApplyPayload[] = []
    const container = render(
      <PolicyPanel policy={policyOf()} onApply={(values) => applied.push(values)} onEndMatch={() => {}} />,
    )
    const slider = container.querySelector('[data-testid="slider-aggression"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(slider, '0.9')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 草稿數值已顯示、onApply 還沒被呼叫、套用鈕解鎖。
    expect(container.querySelector('[data-testid="slider-aggression"]')?.getAttribute('value')).toBe('0.9')
    expect(textOf(container)).toContain('0.90')
    expect(applied).toHaveLength(0)
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    expect(apply.textContent).toBe('套用變更')

    act(() => {
      apply.click()
    })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual({
      econMilitary: 0.5,
      unitSize: 0.5,
      unitRange: 0.5,
      clusterSpread: 0.5,
      aggression: 0.9,
      expansion: 0.5,
      techRush: 0.5,
      reserve: 0.5,
      retreatThreshold: 0.5,
      // 資源比例語義未變（歸一後相等）→ payload 不帶 resourceBias（Prompt 10 完整版）。
      tempoPreset: 'standard',
    })
  })

  it('節奏覆蓋預覽（Prompt 10 完整版）：rush 列出各時間窗覆蓋值；PolicySnapshot.tick 高亮當前窗口', () => {
    // tick 4000 = 200 秒 → 落在 rush 第二窗（120–300s）。
    const container = render(
      <PolicyPanel
        policy={policyOf({ tick: 4000, values: { tempoPreset: 'rush' } })}
        onApply={() => {}}
        onEndMatch={() => {}}
      />,
    )
    const rules = container.querySelectorAll('[data-testid="policy-tempo-rule"]')
    expect(rules.length).toBe(3)
    const texts = Array.from(rules).map((rule) => rule.textContent ?? '')
    expect(texts[0]).toContain('0–120s')
    expect(texts[0]).toContain('經濟→0.10')
    expect(texts[0]).toContain('侵略→1.00')
    expect(texts[1]).toContain('120–300s')
    expect(texts[1]).toContain('經濟→0.60')
    expect(texts[2]).toContain('300s 之後')
    // 當前所處時間窗（第二窗）高亮、其餘不高亮。
    expect(rules[1]?.className).toContain('is-active')
    expect(rules[0]?.className).not.toContain('is-active')
    expect(rules[2]?.className).not.toContain('is-active')
  })

  it('拖動下拉即預覽（草稿 tempo 未套用也更新覆蓋預覽；tempo 變更算差異）', () => {
    const container = render(
      <PolicyPanel policy={policyOf()} onApply={() => {}} onEndMatch={() => {}} />,
    )
    // 預設 standard：無覆蓋提示。
    expect(container.querySelector('[data-testid="policy-tempo-none"]')).not.toBeNull()
    const tempo = container.querySelector('[data-testid="policy-tempo"]') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      setter?.call(tempo, 'rush')
      tempo.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 草稿切到 rush → 預覽立即列出 3 個時間窗（未套用也生效）。
    expect(container.querySelectorAll('[data-testid="policy-tempo-rule"]').length).toBe(3)
    expect(container.querySelector('[data-testid="policy-tempo-none"]')).toBeNull()
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
  })

  it('simplex 資源比例（Prompt 10 完整版）：拖一支按比例重分另兩支；套用送歸一化三鍵', () => {
    const applied: PolicyApplyPayload[] = []
    const container = render(
      <PolicyPanel policy={policyOf()} onApply={(values) => applied.push(values)} onEndMatch={() => {}} />,
    )
    const red = container.querySelector('[data-testid="slider-resourceBias-red"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(red, '0.9')
      red.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 1/3,1/3,1/3 → 拖紅到 0.9：剩餘 0.1 對半 → 藍 5%、綠 5%（總和恆 1）。
    expect(container.querySelector('[data-testid="bias-pct-red"]')?.textContent).toBe('90%')
    expect(container.querySelector('[data-testid="bias-pct-blue"]')?.textContent).toBe('5%')
    expect(container.querySelector('[data-testid="bias-pct-green"]')?.textContent).toBe('5%')
    act(() => {
      ;(container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement).click()
    })
    expect(applied).toHaveLength(1)
    const bias = applied[0]?.resourceBias
    expect(bias?.red).toBeCloseTo(0.9, 12)
    expect(bias?.blue).toBeCloseTo(0.05, 12)
    expect(bias?.green).toBeCloseTo(0.05, 12)
  })

  it('資源比例語義等價（歸一後相等）→ payload 不帶 resourceBias（不吃冷卻、不記假日誌）', () => {
    const applied: PolicyApplyPayload[] = []
    // 生效值 {1, 0.5, 0.5} 歸一 = {0.5, 0.25, 0.25}；只拖 aggression。
    const container = render(
      <PolicyPanel
        policy={policyOf({ values: { resourceBias: { blue: 1, red: 0.5, green: 0.5 } } })}
        onApply={(values) => applied.push(values)}
        onEndMatch={() => {}}
      />,
    )
    // 顯示走歸一值：藍 50%、紅 25%、綠 25%。
    expect(container.querySelector('[data-testid="bias-pct-blue"]')?.textContent).toBe('50%')
    expect(container.querySelector('[data-testid="bias-pct-red"]')?.textContent).toBe('25%')
    const slider = container.querySelector('[data-testid="slider-aggression"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(slider, '0.9')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      ;(container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement).click()
    })
    expect(applied).toHaveLength(1)
    expect(applied[0]?.resourceBias).toBeUndefined()
  })

  it('資源比例存量全 0（CLI 邊界）→ 顯示為均分，不產生假變更', () => {
    const container = render(
      <PolicyPanel
        policy={policyOf({ values: { resourceBias: { blue: 0, red: 0, green: 0 } } })}
        onApply={() => {}}
        onEndMatch={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="bias-pct-blue"]')?.textContent).toBe('33%')
    expect(container.querySelector('[data-testid="bias-pct-red"]')?.textContent).toBe('33%')
    expect(container.querySelector('[data-testid="bias-pct-green"]')?.textContent).toBe('33%')
    // 歸一值等價 → 無差異：套用鈕禁用（不記無意義日誌）。
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('還原：草稿回復為生效值（變更前）；無差異時兩鈕禁用', () => {
    const applied: PolicyApplyPayload[] = []
    const container = render(
      <PolicyPanel
        policy={policyOf({ values: { unitRange: 0.25 } })}
        onApply={(values) => applied.push(values)}
        onEndMatch={() => {}}
      />,
    )
    // 初始無草稿：套用與還原都禁用。
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    const reset = container.querySelector('[data-testid="policy-reset"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(reset.disabled).toBe(true)

    // 拖動 unitRange 0.25 → 0.7：草稿與生效值不同。
    const slider = container.querySelector('[data-testid="slider-unitRange"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(slider, '0.7')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="slider-unitRange"]')?.getAttribute('value')).toBe('0.7')

    // 還原 → 回到 0.25（變更前）、按鈕回到禁用。
    act(() => {
      reset.click()
    })
    expect(container.querySelector('[data-testid="slider-unitRange"]')?.getAttribute('value')).toBe('0.25')
    expect(apply.disabled).toBe(true)
    expect(reset.disabled).toBe(true)
    expect(applied).toHaveLength(0)
  })

  it('無差異套用鈕禁用；收合 → 只剩收合鈕；再點展開恢復 12 個滑桿', () => {
    const container = render(<PolicyPanel policy={policyOf()} onApply={() => {}} onEndMatch={() => {}} />)
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true) // 草稿＝生效值
    expect(apply.textContent).toBe('套用變更')

    const collapseButton = container.querySelector('.hud-panel-title button') as HTMLButtonElement
    act(() => {
      collapseButton.click()
    })
    expect(textOf(container)).toContain('收合中')
    expect(container.querySelectorAll('input[type="range"]').length).toBe(0)

    const expandButton = container.querySelector(
      '[data-testid="policy-panel-collapsed"]',
    ) as HTMLButtonElement
    act(() => {
      expandButton.click()
    })
    expect(container.querySelectorAll('input[type="range"]').length).toBe(12)
  })

  it('無對局（policy null）→ 滑桿與套用鈕禁用、摘要走空狀態', () => {
    const container = render(<PolicyPanel policy={null} onApply={() => {}} onEndMatch={() => {}} />)
    for (const slider of container.querySelectorAll('input[type="range"]')) {
      expect((slider as HTMLInputElement).disabled).toBe(true)
    }
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(container.querySelector('[data-testid="policy-summary"]')?.textContent).toContain('尚未有戰略決策')
  })

  it('結束並復盤鈕 → onEndMatch', () => {
    let ended = 0
    const container = render(
      <PolicyPanel policy={policyOf()} onApply={() => {}} onEndMatch={() => { ended += 1 }} />,
    )
    const endButton = container.querySelector('[data-testid="policy-end-match"]') as HTMLButtonElement
    act(() => {
      endButton.click()
    })
    expect(ended).toBe(1)
  })
})

/* ---------- 戰後復盤（Prompt 10.5） ---------- */

const replayFixture: ReplayRecord = {
  seed: 42,
  result: 'player',
  durationTicks: 2400,
  finalCrystal: { player: 830, enemy: 410 },
  resourceSeries: [
    { tick: 0, player: 600, enemy: 600 },
    { tick: 1200, player: 700, enemy: 500 },
    { tick: 2400, player: 830, enemy: 410 },
  ],
  unitCountSeries: [
    { tick: 0, player: 3, enemy: 3 },
    { tick: 1200, player: 5, enemy: 4 },
    { tick: 2400, player: 7, enemy: 2 },
  ],
  powerSeries: [
    { tick: 0, player: 4320, enemy: 4320 },
    { tick: 1200, player: 5200, enemy: 3100 },
    { tick: 2400, player: 6400, enemy: 1200 },
  ],
  policyEvents: [
    { tick: 600, key: 'aggression', from: 0.5, to: 1 },
    { tick: 1800, key: 'econMilitary', from: 0.5, to: 0 },
  ],
}

describe('PostGamePanel（/post-game，Prompt 10.5）', () => {
  it('讀 replay：勝負＋時長＋最終資源＋三張曲線 canvas（資源／單位／戰力）', () => {
    const container = render(<PostGamePanel replay={replayFixture} onRestart={() => {}} />)
    const result = container.querySelector('[data-testid="post-game-result"]')
    expect(result?.textContent).toBe('勝利')
    expect((result as HTMLElement).style.color).toBe('rgb(124, 227, 139)')
    expect(container.querySelector('[data-testid="post-game-duration"]')?.textContent).toBe('時長 2:00')
    expect(container.querySelector('[data-testid="post-game-final-crystal"]')?.textContent).toContain('830')
    expect(container.querySelectorAll('canvas').length).toBe(3)
    expect(container.querySelector('[data-testid="post-game-resource-chart"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="post-game-unitcount-chart"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="post-game-power-chart"]')).not.toBeNull()
  })

  it('Policy 時間軸：標記數與明細（tick → 時鐘、key from→to）', () => {
    const container = render(<PostGamePanel replay={replayFixture} onRestart={() => {}} />)
    const timeline = container.querySelector('[data-testid="policy-timeline"]')
    expect(timeline).not.toBeNull()
    expect(timeline?.querySelectorAll('.policy-timeline-marker').length).toBe(2)
    const listText = timeline?.querySelector('ol')?.textContent ?? ''
    expect(listText).toContain('0:30') // tick 600 → 30 秒
    expect(listText).toContain('aggression 0.50→1.00')
    expect(listText).toContain('1:30') // tick 1800
    expect(listText).toContain('econMilitary 0.50→0.00')
  })

  it('平手顯示黃色、無政策變更走空狀態、「再來一場」觸發 onRestart', () => {
    const restarts: number[] = []
    const container = render(
      <PostGamePanel
        replay={{ ...replayFixture, result: 'draw', policyEvents: [] }}
        onRestart={() => restarts.push(1)}
      />,
    )
    const result = container.querySelector('[data-testid="post-game-result"]') as HTMLElement
    expect(result.textContent).toBe('平手')
    expect(result.style.color).toBe('rgb(255, 216, 102)')
    expect(container.querySelector('[data-testid="policy-timeline"]')).toBeNull()
    expect(textOf(container)).toContain('對局中未調整政策')

    const restart = container.querySelector('[data-testid="post-game-restart"]') as HTMLButtonElement
    act(() => {
      restart.click()
    })
    expect(restarts).toHaveLength(1)
  })

  it('戰敗顯示紅色', () => {
    const container = render(
      <PostGamePanel replay={{ ...replayFixture, result: 'enemy' }} onRestart={() => {}} />,
    )
    const result = container.querySelector('[data-testid="post-game-result"]') as HTMLElement
    expect(result.textContent).toBe('戰敗')
    expect(result.style.color).toBe('rgb(255, 122, 122)')
  })

  it('投降橫幅（Prompt 8.6）：投降方＋絕望值＋時鐘；無投降不渲染', () => {
    const withSurrender = render(
      <PostGamePanel
        replay={{
          ...replayFixture,
          surrender: {
            tick: 2400,
            player: 'enemy',
            type: 'ai_surrender',
            despairAtSurrender: 0.81,
            powerRatio: 0.42,
            incomeRatio: 0.35,
          },
        }}
        onRestart={() => {}}
      />,
    )
    const banner = withSurrender.querySelector('[data-testid="post-game-surrender"]')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('2:00') // tick 2400
    expect(banner?.textContent).toContain('敵方')
    expect(banner?.textContent).toContain('0.81')

    // 舊 replay（無投降欄）→ 不渲染橫幅。
    const without = render(<PostGamePanel replay={replayFixture} onRestart={() => {}} />)
    expect(without.querySelector('[data-testid="post-game-surrender"]')).toBeNull()
  })
})
