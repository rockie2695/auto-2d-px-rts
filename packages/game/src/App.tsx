import { InfoPanel } from './ui/InfoPanel.tsx'
import { PixiCanvas } from './ui/PixiCanvas.tsx'
import { BattleDashboard } from './ui/BattleDashboard.tsx'

/**
 * 遊戲最外層（Prompt 9 / 9.5）：React 包住整個畫面。
 * `<PixiCanvas>` 掛載 PixiJS 畫布並啟動對局（組合根 session.ts）；
 * `<BattleDashboard>` 用唯一的 250ms 輪詢餵四角 HUD（資源曲線／資源面板／
 * 決策日誌／小隊狀態），右上面板下方疊點選用的 `<InfoPanel>`。
 */
export default function App() {
  return (
    <div className="game-shell">
      <PixiCanvas />
      <BattleDashboard>
        <InfoPanel />
      </BattleDashboard>
    </div>
  )
}
