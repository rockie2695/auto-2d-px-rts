import type { SquadInfo } from '../session.ts'
import { useDraggable } from './useDraggable.ts'

/** 任務中文名。 */
const MISSION_LABEL: Record<string, string> = {
  defend: '守備',
  attack: '進攻',
  harass: '騷擾',
  stage: '集結待戰',
  retreat: '撤退',
}

/**
 * 右下：小隊狀態（Prompt 9.5 / 10.10）。
 * 一隊一行：任務 + 人數 + 戰力 + 距目標距離；標題列可拖曳移動面板。
 */
export function SquadPanel({ squads }: { squads: readonly SquadInfo[] }) {
  const { position, panelRef, handleProps } = useDraggable()
  return (
    <aside
      ref={panelRef}
      className="hud-panel panel-bottom-right draggable"
      data-testid="squad-panel"
      style={position === null ? undefined : { left: position.x, top: position.y, bottom: 'auto' }}
    >
      <div className="hud-panel-title drag-handle" {...handleProps}>
        <span>小隊狀態</span>
      </div>
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
