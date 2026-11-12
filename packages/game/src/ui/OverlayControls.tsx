import { useEffect, useState } from 'react'

import { getActiveSession } from '../session.ts'

/** 疊加層開關狀態（Prompt 9.5 完整版：開關在 UI）。 */
export interface OverlayToggles {
  heatmap: boolean
  fog: boolean
  paths: boolean
}

/** 熱力圖資料刷新間隔（Prompt 9.5：熱力圖每 500ms 更新）。 */
const HEAT_REFRESH_MS = 500

/**
 * 可疊加圖層開關（Prompt 9.5 完整版）：影響力熱力圖／視野迷霧／路徑虛線。
 * 開關只呼叫 `session.setOverlays`（切 scene 容器 visible）——不影響模擬；
 * 熱力圖開啟時每 500ms `refreshInfluence`（推入離屏 canvas 重繪一次）。
 * 迷霧層資料由 Prompt 9.5b（sight.ts）接上；9.5a 為全可見（空 mask）。
 */
export function OverlayControls() {
  const [toggles, setToggles] = useState<OverlayToggles>({
    heatmap: false,
    fog: false,
    paths: false,
  })

  // 開關即時推入場景（同值重複設定無害）。
  useEffect(() => {
    getActiveSession()?.setOverlays(toggles)
  }, [toggles])

  // 熱力圖開啟 → 500ms 刷新資料（關閉時 interval 不跑，sim 零負擔）。
  useEffect(() => {
    if (!toggles.heatmap) return
    const refresh = (): void => {
      getActiveSession()?.refreshInfluence()
    }
    refresh()
    const timer = window.setInterval(refresh, HEAT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [toggles.heatmap])

  return (
    <div className="overlay-controls" data-testid="overlay-controls">
      {(
        [
          ['heatmap', '熱力圖'],
          ['fog', '迷霧'],
          ['paths', '路徑'],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="overlay-toggle">
          <input
            type="checkbox"
            data-testid={`overlay-${key}`}
            checked={toggles[key]}
            onChange={(event) =>
              setToggles((prev) => ({ ...prev, [key]: event.target.checked }))
            }
          />
          {label}
        </label>
      ))}
    </div>
  )
}
