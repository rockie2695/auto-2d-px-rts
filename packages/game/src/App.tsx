import { GameCanvas } from './ui/GameCanvas.tsx'

/**
 * 遊戲最外層：React 負責包住整個畫面，
 * PixiJS 畫布由 GameCanvas 掛載到 .game-canvas-host。
 */
export default function App() {
  return (
    <div className="game-shell">
      <GameCanvas />
    </div>
  )
}
