import type { JSX } from 'react'

import { ratioTone } from './collector.ts'
import type { RatioTone } from './collector.ts'
import type { TierHpTable } from '../session.ts'

/** tier 段顏色（像素風；small 藍／medium 琥珀／large 橙）。 */
const TIER_COLORS: Record<'small' | 'medium' | 'large', string> = {
  small: '#8fd3ff',
  medium: '#ffd866',
  large: '#ff9d66',
}

const TIER_LABEL: Record<'small' | 'medium' | 'large', string> = {
  small: '小',
  medium: '中',
  large: '大',
}

function toneColor(tone: RatioTone): string {
  if (tone === 'red') return '#ff7a7a'
  if (tone === 'yellow') return '#ffd866'
  return '#7ce38b'
}

/**
 * 一根堆疊條：三 tier 段按 HP 佔比並排（總寬 = 該行 max(raw, eff) 歸一，
 * 兩根條共用同一比例尺——有效 HP 恆 ≥ 原始 HP，長度差即裝甲攤薄）。
 */
function StackBar({ table, scaleMax, testId }: {
  table: TierHpTable
  scaleMax: number
  testId: string
}): JSX.Element {
  const total = table.small.rawHp + table.medium.rawHp + table.large.rawHp
  const effTotal = table.small.effHp + table.medium.effHp + table.large.effHp
  const segments = (pick: 'rawHp' | 'effHp'): JSX.Element[] => {
    const grand = pick === 'rawHp' ? total : effTotal
    return (['small', 'medium', 'large'] as const).map((tier) => {
      const value = table[tier][pick]
      const width = grand > 0 ? (value / Math.max(scaleMax, 1)) * 100 : 0
      return (
        <span
          key={tier}
          className="power-stack-seg"
          data-testid={`${testId}-${tier}`}
          style={{ width: `${width}%`, background: TIER_COLORS[tier] }}
          title={`${TIER_LABEL[tier]}：${Math.round(value)}`}
        />
      )
    })
  }
  return (
    <>
      <div className="power-stack-bar" data-testid={testId}>
        {segments('rawHp')}
      </div>
      <div className="power-stack-bar" data-testid={`${testId}-eff`}>
        {segments('effHp')}
      </div>
    </>
  )
}

/**
 * 右上：戰力對比堆疊條（Prompt 9.5 完整版）。
 * 每陣營兩根條：上＝原始 HP、下＝有效 HP（hp/(1−armor) 當量），按
 * small/medium/large 分段；條寬共用同一比例尺（雙陣營 × 雙指標可直接比較）。
 * 戰力比數字沿用 `ratioTone` 警示（< 0.7 紅、> 1.4 綠）。
 */
export function PowerStack({
  playerTiers,
  enemyTiers,
  ratio,
}: {
  playerTiers: TierHpTable
  enemyTiers: TierHpTable
  ratio: number
}) {
  const tone = ratioTone(ratio)
  const scaleMax = Math.max(
    playerTiers.small.rawHp + playerTiers.medium.rawHp + playerTiers.large.rawHp,
    playerTiers.small.effHp + playerTiers.medium.effHp + playerTiers.large.effHp,
    enemyTiers.small.rawHp + enemyTiers.medium.rawHp + enemyTiers.large.rawHp,
    enemyTiers.small.effHp + enemyTiers.medium.effHp + enemyTiers.large.effHp,
    1,
  )
  return (
    <aside className="hud-panel" data-testid="power-stack">
      <div className="hud-panel-title">
        <span>戰力對比</span>
        <span style={{ color: toneColor(tone) }} data-testid="power-stack-ratio">
          {ratio.toFixed(2)}
        </span>
      </div>
      <div className="power-stack-row">
        <span className="power-stack-side player">我</span>
        <div className="power-stack-bars">
          <StackBar table={playerTiers} scaleMax={scaleMax} testId="power-stack-player" />
        </div>
      </div>
      <div className="power-stack-row">
        <span className="power-stack-side enemy">敵</span>
        <div className="power-stack-bars">
          <StackBar table={enemyTiers} scaleMax={scaleMax} testId="power-stack-enemy" />
        </div>
      </div>
      <div className="power-stack-legend">
        {(['small', 'medium', 'large'] as const).map((tier) => (
          <span key={tier}>
            <i style={{ background: TIER_COLORS[tier] }} />
            {TIER_LABEL[tier]}
          </span>
        ))}
      </div>
    </aside>
  )
}
