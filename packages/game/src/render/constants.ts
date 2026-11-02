/** 畫布背景深灰色。驗收：`pnpm dev` 開起來是滿版深灰。 */
export const GAME_BACKGROUND_COLOR = 0x1c1c1c

/** 1 格 tile 的邊長（px）。32×32 格地圖 = 1024×1024 px 世界座標。 */
export const TILE_SIZE = 32

/** 單位色塊邊長（px），以單位固定點座標為中心放置（點擊命中框相同）。 */
export const UNIT_RENDER_SIZE = 20

/** 血條高度（px）。 */
export const HP_BAR_HEIGHT = 3

/* ---- 配色（像素風深色主題）---- */

/** 地板（可走格）。 */
export const COLOR_FLOOR = 0x2c3440
/** 岩石（不可走格）。 */
export const COLOR_ROCK = 0x16181d
/** 資源點（水晶脈）。 */
export const COLOR_CRYSTAL_NODE = 0x59c9ff

/** 單位：我方青、敵方紅。 */
export const COLOR_UNIT_PLAYER = 0x53d9d1
export const COLOR_UNIT_ENEMY = 0xe8705f
/** 建築：我方暗青、敵方暗紅（與單位同色相、較低明度）。 */
export const COLOR_BUILDING_PLAYER = 0x2fa3a3
export const COLOR_BUILDING_ENEMY = 0xa34a3f

/** 血條底色 + 依比例分三段（綠 / 黃 / 紅）。 */
export const COLOR_HP_BG = 0x101014
export const COLOR_HP_HIGH = 0x67d15c
export const COLOR_HP_MID = 0xd9c94a
export const COLOR_HP_LOW = 0xd95c4f

/** 選取框。 */
export const COLOR_SELECTED = 0xffffff
