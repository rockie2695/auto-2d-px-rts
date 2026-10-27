/**
 * UI 覆蓋層（React）：負責掛載 PixiJS 畫布與之後的 Policy 滑桿等控件。
 * 本層不直接操作 Pixi 物件，一律透過 render 層的 API。
 */
export function GameCanvas() {
  return <div className="game-canvas-host" />
}
