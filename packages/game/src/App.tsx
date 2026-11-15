import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'

import type { ContentPack } from '@auto-2d-px-rts/shared'

import { getActiveSession, getLastReplay, setInitialPolicies } from './session.ts'
import type { ReplayRecord } from './replay.ts'
import { InfoPanel } from './ui/InfoPanel.tsx'
import { PixiCanvas } from './ui/PixiCanvas.tsx'
import { BattleDashboard } from './ui/BattleDashboard.tsx'
import { PostGamePanel } from './ui/PostGamePanel.tsx'
import { PreGamePage } from './ui/PreGamePage.tsx'
import { loadPackWithFallback } from './data/pack.ts'

/**
 * 遊戲最外層（Prompt 9 / 9.5 / 10.5 完整版）：react-router-dom 三路由
 * （HashRouter——dev server 與未來 file:// 場景都安全）：
 * - `/pre-game`（默認）：戰前準備（地圖預覽、六軸雷達、60 秒開局預測、
 *   Policy/節奏預設）——見 PreGamePage。
 * - `/game`：`<PixiCanvas>` 掛載 PixiJS 畫布並啟動對局（組合根 session.ts）；
 *   `<BattleDashboard>` 用唯一的 250ms 輪詢餵四角 HUD 與政策滑桿；
 *   500ms 輪詢偵測 `getOutcome().ended` → navigate 到 `/post-game`。
 * - `/post-game`：戰後復盤（Prompt 10.5 完整版＋10.5c 三視圖與反事實）——
 *   replay 由 session 模組傳遞（`getLastReplay`），App 載入內容包供反事實
 *   重放；「用建議參數重玩」→ `setInitialPolicies` ＋開新局。
 *   無可復盤對局 → 導回 `/pre-game`。
 */

/** `/game`：對局畫面＋結束偵測（router 版輪詢）。 */
function GamePage() {
  const navigate = useNavigate()
  useEffect(() => {
    const timer = window.setInterval(() => {
      const active = getActiveSession()
      if (active === null) return
      const outcome = active.getOutcome()
      if (outcome.ended && outcome.replay !== null) {
        navigate('/post-game')
      }
    }, 500)
    return () => {
      window.clearInterval(timer)
    }
  }, [navigate])

  return (
    <div className="game-shell">
      <PixiCanvas />
      <BattleDashboard>
        <InfoPanel />
      </BattleDashboard>
    </div>
  )
}

/**
 * `/post-game`：復盤頁——replay 從 session 模組取（路由間傳遞）。
 * Prompt 10.5c：App 載入內容包傳給 PostGamePanel（反事實重放計算用）；
 * 「用建議參數重玩」→ 寫入初始政策（快照時刻＋覆寫）並開新局。
 */
function PostGamePage() {
  const navigate = useNavigate()
  const [replay] = useState<ReplayRecord | null>(getLastReplay())
  const [content, setContent] = useState<ContentPack | null>(null)
  useEffect(() => {
    let alive = true
    loadPackWithFallback('/data-db')
      .then((loaded) => {
        if (alive) setContent(loaded.pack)
      })
      .catch(() => {
        /* 載入失敗：PostGamePanel 自行處理 null → 反事實降級顯示。 */
      })
    return () => {
      alive = false
    }
  }, [])
  if (replay === null) {
    return <Navigate to="/pre-game" replace />
  }
  return (
    <PostGamePanel
      replay={replay}
      content={content}
      onRestart={() => {
        navigate('/pre-game')
      }}
      onReplayWithPolicies={(values) => {
        setInitialPolicies(values)
        navigate('/game')
      }}
    />
  )
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/pre-game" element={<PreGamePage />} />
        <Route path="/game" element={<GamePage />} />
        <Route path="/post-game" element={<PostGamePage />} />
        <Route path="*" element={<Navigate to="/pre-game" replace />} />
      </Routes>
    </HashRouter>
  )
}
