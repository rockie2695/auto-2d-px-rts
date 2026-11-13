import { useEffect, useState } from 'react'

/**
 * 右上角投降按鈕（Prompt 10.6）：像素風格外框、hover 變紅。
 * - 點擊 → 確認對話框（標題「確定投降？」／內容／「確認投降」「取消」）；
 *   確認 → `onConfirm`（呼叫端負責 `session.surrender('player')`）；
 *   取消 → 關框、對局繼續。
 * - **Esc 快捷鍵**：框關著且對局可投 → 開啟確認框；框開著 → 取消（toggle）。
 *   「只在沒有其他對話框開啟時」守衛：目前遊戲內僅此一個對話框（條件即
 *   本框的 open 狀態本身）；未來新增對話框時共用同一個 modal-open 狀態源。
 * - 已投降／對局已結束（`hidden`）→ 整顆不渲染（Esc 監聽也不掛）。
 *   `hidden` 只會單向翻真（投降後本局不再復原；復盤頁切換即卸載），
 *   故不需在 effect 內同步復位 open 狀態。
 */
export function SurrenderButton({
  onConfirm,
  hidden = false,
}: {
  onConfirm: () => void
  /** 已投降／對局已結束：整顆按鈕不渲染。 */
  hidden?: boolean
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (hidden) return // 已投降／已結束：不掛監聽（render 端 return null）。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 避免覆寫事件（如正在打字）——目前遊戲內無文字輸入框；僅擋重複觸發。
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden])

  if (hidden) return null

  return (
    <>
      <button
        type="button"
        className="surrender-button"
        data-testid="surrender-button"
        onClick={() => setOpen(true)}
      >
        投降
      </button>
      {open && (
        <div className="surrender-overlay" data-testid="surrender-overlay">
          <div
            className="surrender-dialog"
            data-testid="surrender-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="確定投降？"
          >
            <div className="surrender-dialog-title">確定投降？</div>
            <div className="surrender-dialog-body">
              本局將立即結束，AI 對戰結果計為失敗。
              <span className="surrender-dialog-note">（敵方 AI 繼續行動 3 秒後定局）</span>
            </div>
            <div className="surrender-dialog-actions">
              <button
                type="button"
                className="surrender-dialog-confirm"
                data-testid="surrender-confirm"
                onClick={() => {
                  setOpen(false)
                  onConfirm()
                }}
              >
                確認投降
              </button>
              <button
                type="button"
                data-testid="surrender-cancel"
                onClick={() => setOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
