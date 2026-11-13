import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { loadContentPackFromFetch } from '../data/loadFromFetch.ts'
import { simulateOpening } from '../ai/opening.ts'
import { setInitialPolicies } from '../session.ts'
import type { PolicyValues } from '../ai/policy.ts'
import { resolvePolicies } from '../ai/policy.ts'
import type { TempoPreset } from '@auto-2d-px-rts/shared'
import type { ContentPack } from '@auto-2d-px-rts/shared'
import { formatClock } from './collector.ts'
import { radarStats } from './factionStats.ts'
import { keepSpawnTiles } from './preGameData.ts'
import { MapPreview } from './MapPreview.tsx'
import { RadarChart } from './RadarChart.tsx'
import { SLIDERS, TEMPO_OPTIONS } from './policyMeta.ts'
import type { NumericPolicyKey } from './policyMeta.ts'

/**
 * 戰前準備頁（Prompt 10.5 完整版，路由 /pre-game）：
 * - **地圖預覽**：地形（岩石）、資源點（按類型著色）、雙方出生點（keep 標記）。
 * - **勢力對比雷達**：自繪 canvas 六軸（經濟/軍事/科技/機動性/韌性/裝甲——
 *   裝甲水平 = 成本加權平均 armor，見 factionStats.ts）。
 * - **60 秒開局預測**：headless 快照模擬（真 sim＋真戰略層、固定預測種子），
 *   列出我方 AI 前 60 秒實際執行的生產/建造計劃。
 * - **Policy 預設滑桿＋節奏下拉**：寫入初始政策（下一次 startGameSession 消費）。
 * - 「開始對戰」→ /game。本頁不依賴即時 sim——地圖/雷達讀 content pack 靜態資料、
 *   預測是一次性 headless 計算。
 *
 * 結構沿用專案慣例（PostGamePanel 模式）：`PreGameView` 是**純 props 渲染**
 * （測試直接餵 content pack），`PreGamePage` 只負責載入與路由接線。
 */

/** 預測種子：地圖與開局佈局來自 content pack 靜態資料；命運抽籤只影響同分候選次序。 */
export const PREDICTION_SEED = 42

export function PreGameView({ content, onStart }: { content: ContentPack; onStart: (values: PolicyValues) => void }) {
  const [draft, setDraft] = useState<PolicyValues | null>(null)

  // 60 秒開局預測（純計算、確定性——content 變更才重算；同步 headless 約數百 ms）。
  const plan = useMemo(
    () => simulateOpening(content, { ticks: 1200, seed: PREDICTION_SEED }),
    [content],
  )

  const spawnTiles = useMemo(() => keepSpawnTiles(content, PREDICTION_SEED), [content])
  const radarSides = useMemo(() => {
    const entry = { faction: content.faction, units: content.units, buildings: content.buildings }
    return radarStats([entry, entry])
  }, [content])

  // 生效值：草稿 ?? 預設（戰前頁用預設政策為基底）。
  const base = draft ?? resolvePolicies({})

  const setSlider = (key: NumericPolicyKey, value: number): void => {
    setDraft({ ...base, [key]: value })
  }
  const setTempo = (value: TempoPreset): void => {
    setDraft({ ...base, tempoPreset: value })
  }

  return (
    <div className="pre-game" data-testid="pre-game-panel">
      <h1 className="pre-game-title">戰前準備</h1>
      <div className="pre-game-columns">
        <section className="pre-game-section">
          <h2>地圖預覽</h2>
          <MapPreview content={content} spawnTiles={spawnTiles} />
          <div className="pre-game-note">岩石灰格；藍/紅/綠點 = 三資源點；框 = 雙方主堡（出生點）</div>
        </section>

        <section className="pre-game-section">
          <h2>勢力對比（六軸雷達）</h2>
          <RadarChart sides={radarSides} />
          <div className="pre-game-note">經濟/軍事/科技/機動性/韌性/裝甲（裝甲水平 = 成本加權平均 armor）</div>
        </section>

        <section className="pre-game-section pre-game-setup">
          <h2>Policy 預設（開局帶入）</h2>
          <label className="pre-game-tempo">
            <span>節奏預設</span>
            <select
              data-testid="pre-game-tempo"
              value={base.tempoPreset}
              onChange={(event) => setTempo(event.target.value as TempoPreset)}
            >
              {TEMPO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="pre-game-sliders">
            {SLIDERS.map(({ key, label, tooltip }) => (
              <label className="pre-game-slider" key={key}>
                <span title={tooltip}>{label}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={base[key]}
                  data-testid={`pre-game-slider-${key}`}
                  aria-label={label}
                  onChange={(event) => setSlider(key, Number(event.target.value))}
                />
                <output>{base[key].toFixed(2)}</output>
              </label>
            ))}
          </div>
          <button type="button" className="pre-game-start" data-testid="pre-game-start" onClick={() => onStart(base)}>
            開始對戰
          </button>
        </section>
      </div>

      <section className="pre-game-section">
        <h2>開局預測（模擬前 60 秒）</h2>
        {plan === null ? (
          <div className="pre-game-loading">模擬中…</div>
        ) : (
          <>
            <div className="pre-game-note" data-testid="pre-game-prediction-summary">
              60 秒末水晶 {plan.finalCrystal}；生產統計{' '}
              {Object.entries(plan.trainCounts)
                .map(([defId, count]) => `${defId}×${count}`)
                .join('、') || '（無）'}
            </div>
            <ol className="pre-game-prediction" data-testid="pre-game-prediction">
              {plan.actions.map((action, index) => (
                <li key={`${action.tick}-${action.action}-${action.target}-${index}`}>
                  <span className="decision-log-time">{formatClock(action.tick)}</span>
                  <span>
                    {action.action === 'build' ? '蓋' : '生'} {action.target}（{action.explanation}）
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </div>
  )
}

/** 路由頁殼：載入 content pack（一次性）＋「開始對戰」接線（初始政策＋導航）。 */
export function PreGamePage() {
  const navigate = useNavigate()
  const [content, setContent] = useState<ContentPack | null>(null)

  useEffect(() => {
    let cancelled = false
    loadContentPackFromFetch('/data').then((pack) => {
      if (!cancelled) setContent(pack)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (content === null) {
    return (
      <div className="pre-game" data-testid="pre-game-panel">
        <h1 className="pre-game-title">戰前準備</h1>
        <div className="pre-game-loading">載入內容包…</div>
      </div>
    )
  }
  return (
    <PreGameView
      content={content}
      onStart={(values) => {
        setInitialPolicies(values)
        navigate('/game')
      }}
    />
  )
}
