import { useEffect, useState } from 'react'

import { getActiveSession } from '../session.ts'
import type { BuildingInfo, MarkerInfo, UnitInfo } from '../session.ts'
import { useUiStore } from './uiStore.ts'

/** 輪詢間隔（≈5Hz）：面板是文字資訊，不需要 60fps 重繪。 */
const POLL_MS = 200

/**
 * 資訊面板（Prompt 9 點單位；Prompt 9.1 點建築；Prompt 9.4 顯示微操決策原因）。
 * 讀 zustand 的選取目標（UI 狀態），遊戲資料經組合根
 * `getUnitInfo`/`getBuildingInfo` 取得；面板本身不做任何遊戲計算。
 * 位置由 App 的 `.hud-top-right` 直欄控制（疊在資源面板下方）。
 */
export function InfoPanel() {
  const selected = useUiStore((state) => state.selected)
  const panelOpen = useUiStore((state) => state.panelOpen)
  const togglePanel = useUiStore((state) => state.togglePanel)
  const [unitInfo, setUnitInfo] = useState<UnitInfo | null>(null)
  const [buildingInfo, setBuildingInfo] = useState<BuildingInfo | null>(null)
  const [markerInfo, setMarkerInfo] = useState<MarkerInfo | null>(null)
  const [exists, setExists] = useState(false)

  useEffect(() => {
    if (selected === null) return
    // 只在輪詢回呼裡 setState（不在 effect 內同步呼叫，避免級聯渲染）；
    // 取消選取時不清 info —— 渲染端以 `selected === null` 分支處理，
    // 殘留值不會顯示出來。
    const refresh = (): void => {
      const active = getActiveSession()
      if (selected.kind === 'unit') {
        const unit = active?.getUnitInfo(selected.id) ?? null
        setUnitInfo(unit)
        setBuildingInfo(null)
        setMarkerInfo(null)
        setExists(unit !== null)
      } else if (selected.kind === 'building') {
        const building = active?.getBuildingInfo(selected.id) ?? null
        setBuildingInfo(building)
        setUnitInfo(null)
        setMarkerInfo(null)
        setExists(building !== null)
      } else {
        // 地圖標記（Prompt 10.17）：集結點／生產點的名稱與說明。
        const marker = active?.getMarkerInfo(selected.marker) ?? null
        setMarkerInfo(marker)
        setUnitInfo(null)
        setBuildingInfo(null)
        setExists(marker !== null)
      }
    }
    const timer = window.setInterval(refresh, POLL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [selected])

  if (!panelOpen) {
    return (
      <button className="info-panel-collapsed" onClick={togglePanel}>
        資訊 ▸
      </button>
    )
  }

  const kindLabel: string =
    selected === null
      ? ''
      : selected.kind === 'unit'
        ? '單位資訊'
        : selected.kind === 'building'
          ? '建築資訊'
          : (markerInfo?.title ?? '標記資訊')

  return (
    <aside className="info-panel">
      <div className="info-panel-title">
        <span>{kindLabel}</span>
        <button onClick={togglePanel} aria-label="關閉資訊面板">
          ×
        </button>
      </div>
      {selected === null ? (
        <div className="info-panel-empty">點擊地圖上的物件查看資訊</div>
      ) : !exists ? (
        <div className="info-panel-empty">此物件已不存在</div>
      ) : selected.kind === 'unit' && unitInfo !== null ? (
        <dl className="info-panel-rows">
          <div>
            <dt>單位</dt>
            <dd>
              {unitInfo.defId} #{unitInfo.id}
            </dd>
          </div>
          <div>
            <dt>陣營</dt>
            <dd>{unitInfo.player === 'player' ? '我方' : '敵方'}</dd>
          </div>
          <div>
            <dt>HP</dt>
            <dd>
              {unitInfo.hp} / {unitInfo.maxHp}
            </dd>
          </div>
          <div>
            <dt>裝甲</dt>
            <dd>
              {Math.round(unitInfo.armor * 1000) / 10}%（受到傷害 −
              {Math.round(unitInfo.armor * 1000) / 10}%）
            </dd>
          </div>
          <div>
            <dt>有效 HP</dt>
            <dd>{Math.round(unitInfo.effHp * 10) / 10}</dd>
          </div>
          <div>
            <dt>DPS</dt>
            <dd>{Math.round(unitInfo.dps * 10) / 10}</dd>
          </div>
          <div>
            <dt>座標</dt>
            <dd>
              ({unitInfo.tileX}, {unitInfo.tileY})
            </dd>
          </div>
          <div>
            <dt>射程</dt>
            <dd>{unitInfo.rangeTiles.toFixed(1)} 格</dd>
          </div>
          <div>
            <dt>速度</dt>
            <dd>{unitInfo.moveSpeedTilesPerSec.toFixed(1)} 格/秒</dd>
          </div>
          {unitInfo.squadMission !== null ? (
            <div>
              <dt>小隊</dt>
              <dd>{unitInfo.squadMission}</dd>
            </div>
          ) : null}
          {unitInfo.decision !== null ? (
            <div className="info-panel-decision">
              <dt>決策</dt>
              <dd>{unitInfo.decision}</dd>
            </div>
          ) : null}
        </dl>
      ) : selected.kind === 'building' && buildingInfo !== null ? (
        <dl className="info-panel-rows">
          <div>
            <dt>建築</dt>
            <dd>
              {buildingInfo.defId} #{buildingInfo.id}
            </dd>
          </div>
          <div>
            <dt>陣營</dt>
            <dd>{buildingInfo.player === 'player' ? '我方' : '敵方'}</dd>
          </div>
          <div>
            <dt>HP</dt>
            <dd>
              {buildingInfo.hp} / {buildingInfo.effMaxHp}
            </dd>
          </div>
          <div>
            <dt>狀態</dt>
            <dd>{buildingInfo.progressPct >= 100 ? '已建成' : `施工中 ${buildingInfo.progressPct}%`}</dd>
          </div>
          <div>
            <dt>佔地</dt>
            <dd>
              {buildingInfo.w}×{buildingInfo.h}
            </dd>
          </div>
          <div>
            <dt>座標</dt>
            <dd>
              ({buildingInfo.tileX}, {buildingInfo.tileY})
            </dd>
          </div>
        </dl>
      ) : selected.kind === 'marker' && markerInfo !== null ? (
        <dl className="info-panel-rows">
          <div>
            <dt>標記</dt>
            <dd>{markerInfo.title}</dd>
          </div>
          <div>
            <dt>陣營</dt>
            <dd>{markerInfo.player === 'player' ? '我方' : '敵方'}</dd>
          </div>
          <div>
            <dt>座標</dt>
            <dd>
              ({markerInfo.tileX}, {markerInfo.tileY})
            </dd>
          </div>
          <div className="info-panel-decision">
            <dt>用途</dt>
            <dd>{markerInfo.description}</dd>
          </div>
        </dl>
      ) : null}
    </aside>
  )
}
