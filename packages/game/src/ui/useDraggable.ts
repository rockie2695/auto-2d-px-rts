import { useRef, useState } from 'react'

/**
 * 面板拖曳（Prompt 10.10）：以面板標題列為把手，pointer 拖動更新 left/top。
 * - `position` 為 null 時沿用 CSS 預設定位（四角／底部中央）；拖過後改用內聯座標。
 * - 座標 clamp 在視窗內；標題列上的按鈕（收合等）不觸發拖曳。
 */
export function useDraggable(): {
  position: { x: number; y: number } | null
  panelRef: (element: HTMLElement | null) => void
  handleProps: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  }
} {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const panelElementRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  )

  const panelRef = (element: HTMLElement | null): void => {
    panelElementRef.current = element
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    // 標題列內的按鈕（收合／選單）不做拖曳。
    if ((event.target as HTMLElement).closest('button') !== null) return
    const panel = panelElementRef.current
    if (panel === null) return
    const rect = panel.getBoundingClientRect()
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: rect.left,
      baseY: rect.top,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const x = Math.max(4, Math.min(window.innerWidth - 60, drag.baseX + event.clientX - drag.startX))
    const y = Math.max(4, Math.min(window.innerHeight - 30, drag.baseY + event.clientY - drag.startY))
    setPosition({ x, y })
  }

  const onPointerUp = (): void => {
    dragRef.current = null
  }

  return {
    position,
    panelRef,
    handleProps: { onPointerDown, onPointerMove, onPointerUp },
  }
}
