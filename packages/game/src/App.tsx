import { InfoPanel } from './ui/InfoPanel.tsx'
import { PixiCanvas } from './ui/PixiCanvas.tsx'

/**
 * 遊戲最外層（Prompt 9）：React 包住整個畫面。
 * `<PixiCanvas>` 掛載 PixiJS 畫布並啟動對局（組合根 session.ts）；
 * `<InfoPanel>` 是覆蓋在畫布右上的文字資訊面板（點單位／建築顯示資訊）。
 */
export default function App() {
  return (
    <div className="game-shell">
      <PixiCanvas />
      <InfoPanel />
    </div>
  )
}
