import { useEffect, useState } from 'react'

import { getActiveSession } from './session.ts'
import type { ReplayRecord } from './replay.ts'
import { InfoPanel } from './ui/InfoPanel.tsx'
import { PixiCanvas } from './ui/PixiCanvas.tsx'
import { BattleDashboard } from './ui/BattleDashboard.tsx'
import { PostGamePanel } from './ui/PostGamePanel.tsx'

/**
 * 遊戲最外層（Prompt 9 / 9.5 / 10.5）：React 包住整個畫面。
 * 路由用簡單 state 切換（MVP 不引入 react-router）：
 * - `/game`：`<PixiCanvas>` 掛載 PixiJS 畫布並啟動對局（組合根 session.ts）；
 *   `<BattleDashboard>` 用唯一的 250ms 輪詢餵四角 HUD 與政策滑桿。
 * - `/post-game`：對局結束（keep 被毀 / 超時 / 手動「結束並復盤」）後，
 *   500ms 輪詢偵測 `getOutcome().ended` → 切換到 `<PostGamePanel>`，
 *   整頁由 replay 紀錄純渲染、不依賴即時 sim。
 */
export default function App() {
  const [view, setView] = useState<'game' | 'post-game'>('game')
  const [replay, setReplay] = useState<ReplayRecord | null>(null)

  useEffect(() => {
    if (view !== 'game') return
    const timer = window.setInterval(() => {
      const active = getActiveSession()
      if (active === null) return
      const outcome = active.getOutcome()
      if (outcome.ended && outcome.replay !== null) {
        setReplay(outcome.replay)
        setView('post-game')
      }
    }, 500)
    return () => {
      window.clearInterval(timer)
    }
  }, [view])

  if (view === 'post-game' && replay !== null) {
    return (
      <PostGamePanel
        replay={replay}
        onRestart={() => {
          setReplay(null)
          setView('game') // 重掛 PixiCanvas → 新對局
        }}
      />
    )
  }
  return (
    <div className="game-shell">
      <PixiCanvas />
      <BattleDashboard>
        <InfoPanel />
      </BattleDashboard>
    </div>
  )
}
