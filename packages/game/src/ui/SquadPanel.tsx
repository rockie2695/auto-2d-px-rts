import type { SquadInfo } from '../session.ts'

/** 任務中文名。 */
const MISSION_LABEL: Record<string, string> = {
  defend: '守備',
  attack: '進攻',
  harass: '騷擾',
  retreat: '撤退',
}

/**
 * 右下：小隊狀態（Prompt 9.5）。
 * 一隊一行：任務 + 人數 + 戰力 + 距目標距離。
 */
export function SquadPanel({ squads }: { squads: readonly SquadInfo[] }) {
  return (
    <aside className="hud-panel panel-bottom-right" data-testid="squad-panel">
      <div className="hud-panel-title">小隊狀態</div>
      {squads.length === 0 ? (
        <div className="hud-empty">尚未編隊</div>
      ) : (
        <ul className="squad-list">
          {squads.map((squad) => (
            <li key={`${squad.player}-${squad.index}`}>
              <span className={squad.player}>{squad.player === 'player' ? '我' : '敵'}</span>
              <span>#{squad.index}</span>
              <span>{MISSION_LABEL[squad.mission] ?? squad.mission}</span>
              <span>
                ({squad.targetX},{squad.targetY})
              </span>
              <span>{squad.memberCount} 人</span>
              <span>戰力 {squad.power}</span>
              <span>距 {squad.distTiles} 格</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
