import type { BuildingDef, FactionDef, UnitDef } from '@auto-2d-px-rts/shared'

/**
 * 勢力六軸戰力畫像（Prompt 10.5 完整版：戰前頁雷達圖資料源）。
 * 全部從 content pack 靜態定義計算——純函式、無 sim。
 *
 * 各軸原始值後按「兩陣營同軸最大值」歸一到 0..1（MVP 單陣營 → 兩側同形滿格，
 * 日後多陣營即見相對強弱）；軸定義：
 * - 經濟：Σ 收入建築的藍水晶收入/秒（紅/綠礦另計入科技軸）。
 * - 軍事：Σ roster 單位 DPS（dmg × attackSpeed）。
 * - 科技：高級資源消費——紅/綠收入建築存在（各 +0.5）＋ roster 內
 *   消耗紅/綠的單位佔比（0..1）。0 = 純藍水晶經濟。
 * - 機動性：**成本加權**平均 moveSpeed（藍水晶為權重）。
 * - 韌性：**成本加權**平均有效 HP（hp/(1−armor)，Prompt 3.1）。
 * - 裝甲水平：**成本加權**平均 armor（Prompt 10.5 完整版指定口徑）。
 */

/** 六軸標籤（順序即雷達軸序）。 */
export const RADAR_AXES = ['經濟', '軍事', '科技', '機動性', '韌性', '裝甲'] as const
export type RadarAxis = (typeof RADAR_AXES)[number]

/** 單陣營六軸原始值（未歸一）。 */
export type FactionRawStats = Record<RadarAxis, number>

/** 藍水晶成本（成本加權的權重；0 權重樣本跳過——避免除零）。 */
function crystalCost(cost: { blue_crystal?: number; red_ruby?: number; green_emerald?: number }): number {
  return Math.max(1, cost.blue_crystal ?? 0)
}

export function factionRawStats(faction: FactionDef, units: readonly UnitDef[], buildings: readonly BuildingDef[]): FactionRawStats {
  const roster = units.filter((unit) => faction.roster.includes(unit.id))
  const factionBuildings = buildings.filter((building) => faction.buildings.includes(building.id))

  let income = 0
  let techBuildings = 0
  for (const building of factionBuildings) {
    income += building.incomePerSec?.blue_crystal ?? 0
    if ((building.incomePerSec?.red_ruby ?? 0) > 0 || (building.incomePerSec?.green_emerald ?? 0) > 0) {
      techBuildings += 1
    }
  }
  let military = 0
  let weightedMove = 0
  let weightedEhp = 0
  let weightedArmor = 0
  let weightTotal = 0
  let techUnits = 0
  for (const unit of roster) {
    military += unit.stats.dmg * unit.stats.attackSpeed
    const weight = crystalCost(unit.cost)
    weightedMove += unit.stats.moveSpeed * weight
    weightedEhp += (unit.stats.hp / (1 - unit.stats.armor)) * weight
    weightedArmor += unit.stats.armor * weight
    weightTotal += weight
    if ((unit.cost.red_ruby ?? 0) > 0 || (unit.cost.green_emerald ?? 0) > 0) techUnits += 1
  }
  const techUnitShare = roster.length === 0 ? 0 : techUnits / roster.length
  return {
    經濟: income,
    軍事: military,
    科技: Math.min(1, techBuildings * 0.5 + techUnitShare),
    機動性: weightTotal === 0 ? 0 : weightedMove / weightTotal,
    韌性: weightTotal === 0 ? 0 : weightedEhp / weightTotal,
    裝甲: weightTotal === 0 ? 0 : weightedArmor / weightTotal,
  }
}

/**
 * 兩陣營六軸（0..1）：按同軸最大值歸一（最大值 0 → 兩側 0）。
 * MVP 單陣營鏡像 → 兩側同形（滿格）；多陣營時即相對強弱。
 */
export function radarStats(
  factions: ReadonlyArray<{ faction: FactionDef; units: readonly UnitDef[]; buildings: readonly BuildingDef[] }>,
): Array<{ label: string; side: 'player' | 'enemy'; values: ReadonlyArray<{ axis: RadarAxis; value: number }> }> {
  const raws = factions.map((entry) => factionRawStats(entry.faction, entry.units, entry.buildings))
  return factions.map((_entry, side) => ({
    label: side === 0 ? '我方' : '敵方',
    side: side === 0 ? 'player' : 'enemy',
    values: RADAR_AXES.map((axis) => {
      const max = Math.max(...raws.map((raw) => raw[axis]))
      const value = raws[side]?.[axis] ?? 0
      return { axis, value: max <= 0 ? 0 : value / max }
    }),
  }))
}
