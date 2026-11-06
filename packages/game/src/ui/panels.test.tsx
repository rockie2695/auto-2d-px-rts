/**
 * @vitest-environment jsdom
 */

import { StrictMode, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { DecisionLogPanel } from './DecisionLogPanel.tsx'
import { formatClock, layerLabel } from './collector.ts'
import { PolicyPanel } from './PolicyPanel.tsx'
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
})

const DEFAULT_POLICY_VALUES = {
  econMilitary: 0.5,
  unitSize: 0.5,
  unitRange: 0.5,
  aggression: 0.5,
  clusterSpread: 0.5,
}

const policyOf = (
  overrides?: Partial<Omit<PolicySnapshot, 'values'>> & { values?: Partial<PolicyValues> },
): PolicySnapshot => {
  const { values: valueOverrides, ...rest } = overrides ?? {}
  return {
    values: { ...DEFAULT_POLICY_VALUES, ...valueOverrides },
    cooldownRemainingTicks: 0,
    summary: null,
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
  it('顯示最近 20 條、新的在上（時間 + 層級 + 動作原因）', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 21; index++) {
      entries.push(logEntry(index, index * 20, `決策 ${index}`, 'strategic'))
    }
    const container = render(<DecisionLogPanel entries={entries} />)
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(20) // 21 條 → 顯示最近 20 條（捲動看較舊的）
    expect(items[0]?.textContent).toContain('決策 21') // 新的在上
    expect(items[19]?.textContent).toContain('決策 2') // 第 1 條被淘汰
  })

  it('空日誌顯示尚未有決策；formatClock / layerLabel', () => {
    const container = render(<DecisionLogPanel entries={[]} />)
    expect(textOf(container)).toContain('尚未有決策')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(2700)).toBe('2:15') // SPEC 例
    expect(layerLabel('strategic')).toBe('戰略')
    expect(layerLabel('tactical')).toBe('戰術')
    expect(layerLabel('policy')).toBe('政策')
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

  it('篩選片（Prompt 10.20）：先篩選再取 20 條；陣營 × 層級可組合', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 25; index++) {
      const actor = index % 2 === 0 ? 'player' : 'enemy'
      entries.push({
        ...logEntry(index, index * 20, `決策 ${index}`, index % 3 === 0 ? 'tactical' : 'strategic'),
        actor,
      })
    }
    const container = render(<DecisionLogPanel entries={entries} />)

    // 藍：25 條中 12 條（偶數 index）全顯示（未滿 20）。
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-player"]') as HTMLButtonElement).click()
    })
    let items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(12)
    expect(Array.from(items).every((item) => item.className.includes('actor-player'))).toBe(true)

    // 藍 × 戰略：12 條藍中非 3 的倍數者 → 8 條。
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

  it('篩選後仍只顯示最近 20 條（先篩選再切片）', () => {
    const entries: DecisionLogEntry[] = []
    for (let index = 1; index <= 30; index++) {
      entries.push({ ...logEntry(index, index * 20, `紅決策 ${index}`, 'strategic'), actor: 'enemy' })
    }
    const container = render(<DecisionLogPanel entries={entries} />)
    act(() => {
      ;(container.querySelector('[data-testid="decision-log-chip-team-enemy"]') as HTMLButtonElement).click()
    })
    const items = container.querySelectorAll('ol.decision-log li')
    expect(items.length).toBe(20)
    expect(items[0]?.textContent).toContain('紅決策 30')
    expect(items[19]?.textContent).toContain('紅決策 11') // 第 10 條被淘汰
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

describe('ResourceChart（左上，三指標切換）', () => {
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

  it('預設資源曲線：select 有三個選項、標題隨模式變化', () => {
    const container = render(
      <ResourceChart
        crystalSamples={crystalSamples}
        unitSamples={unitSamples}
        powerSamples={powerSamples}
      />,
    )
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(textOf(container)).not.toContain('等待資料')
    const select = container.querySelector('[data-testid="chart-mode"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.value).toBe('crystal')
    const options = [...select.querySelectorAll('option')].map((option) => option.value)
    expect(options).toEqual(['crystal', 'units', 'power'])
    expect(textOf(container)).toContain('資源曲線（60 秒）')
  })

  it('切換模式 → 標題變為單位數量／戰力（canvas 仍在）', () => {
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

  it('空樣本：canvas 仍在，畫面走等待分支不擲錯', () => {
    const container = render(
      <ResourceChart crystalSamples={[]} unitSamples={[]} powerSamples={[]} />,
    )
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull() // 空樣本 → 折線分支跳過，畫「等待資料」文字於 canvas 上
    expect(textOf(container)).toContain('資源曲線（60 秒）')
  })
})

/* ---------- AI 政策滑桿（Prompt 10：草稿＋套用/還原） ---------- */

describe('PolicyPanel（底部中央）', () => {
  it('顯示 5 個滑桿（名稱／0–1 範圍／數值）＋決策摘要＋可調整狀態', () => {
    const container = render(
      <PolicyPanel policy={policyOf({ summary: 'build mine（收入不足）' })} onApply={() => {}} onEndMatch={() => {}} />,
    )
    // 5 個滑桿、範圍 0–1。
    const sliders = container.querySelectorAll('input[type="range"]')
    expect(sliders.length).toBe(5)
    for (const slider of sliders) {
      expect((slider as HTMLInputElement).min).toBe('0')
      expect((slider as HTMLInputElement).max).toBe('1')
      expect((slider as HTMLInputElement).disabled).toBe(false)
    }
    // 名稱與數值。
    expect(textOf(container)).toContain('經濟↔軍事')
    expect(textOf(container)).toContain('單位規模')
    expect(textOf(container)).toContain('單位射程')
    expect(textOf(container)).toContain('侵略性')
    expect(textOf(container)).toContain('集結密度')
    expect(container.querySelector('[data-testid="slider-aggression"]')?.getAttribute('value')).toBe('0.5')
    expect(textOf(container)).toContain('0.50')
    // 決策摘要與冷卻狀態。
    expect(container.querySelector('[data-testid="policy-summary"]')?.textContent).toBe(
      'build mine（收入不足）',
    )
    expect(container.querySelector('[data-testid="policy-cooldown"]')?.textContent).toContain('可調整')
  })

  it('冷卻中：滑桿與套用鈕禁用、顯示倒數秒數（600 tick → 30s）', () => {
    const container = render(
      <PolicyPanel policy={policyOf({ cooldownRemainingTicks: 600 })} onApply={() => {}} onEndMatch={() => {}} />,
    )
    for (const slider of container.querySelectorAll('input[type="range"]')) {
      expect((slider as HTMLInputElement).disabled).toBe(true)
    }
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(container.querySelector('[data-testid="policy-cooldown"]')?.textContent).toContain('冷卻中 30s')
  })

  it('拖動滑桿只改草稿（不觸發 onApply）；按套用 → 整包 draft 呼叫一次', () => {
    const applied: PolicyValues[] = []
    const container = render(
      <PolicyPanel policy={policyOf()} onApply={(values) => applied.push(values)} onEndMatch={() => {}} />,
    )
    const slider = container.querySelector('[data-testid="slider-aggression"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(slider, '0.9')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 草稿數值已顯示、onApply 還沒被呼叫、套用鈕解鎖並標示變更數。
    expect(container.querySelector('[data-testid="slider-aggression"]')?.getAttribute('value')).toBe('0.9')
    expect(textOf(container)).toContain('0.90')
    expect(applied).toHaveLength(0)
    const apply = container.querySelector('[data-testid="policy-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    expect(apply.textContent).toContain('套用變更（1 項）')

    act(() => {
      apply.click()
    })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual({
      econMilitary: 0.5,
      unitSize: 0.5,
      unitRange: 0.5,
      aggression: 0.9,
      clusterSpread: 0.5,
    })
  })

  it('還原：草稿回復為生效值（變更前）；無差異時兩鈕禁用', () => {
    const applied: PolicyValues[] = []
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

  it('無差異套用鈕禁用；收合 → 只剩收合鈕；再點展開恢復 5 個滑桿', () => {
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
    expect(container.querySelectorAll('input[type="range"]').length).toBe(5)
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
})
