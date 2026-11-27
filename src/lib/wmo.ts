/**
 * 农忙参谋 — WMO 天气现象代码与风向方位的中文换算。
 *
 * Open-Meteo 的 weather_code 采用 WMO 4677 编码（0–99），风向采用气象学习惯的
 * "风的来向"（0° = 北风，90° = 东风）。这两者在决策层都是数字，
 * 到页面上必须变成人能直接读的中文，否则"看天"这件事对用户仍然是黑箱。
 *
 * 只做展示用换算，不参与任何阈值判断 —— 判断仍以原始数值为准，
 * 避免因为文案调整意外改变建议结论。
 */

/** WMO 4677 天气现象代码 → 中文描述。未收录的代码返回 null。 */
const WMO_TEXT: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

/** 八方位中文名，索引 = 度数 / 45 四舍五入后取模 8。 */
const WIND_DIRECTIONS = ["北风", "东北风", "东风", "东南风", "南风", "西南风", "西风", "西北风"];

/**
 * 天气现象代码 → 中文描述。
 * 代码缺失（NaN）或超出 0–99 时返回 null，由调用方按缺测展示。
 */
export function weatherText(code: number): string | null {
  if (!Number.isFinite(code)) return null;
  const rounded = Math.round(code);
  if (rounded < 0 || rounded > 99) return null;
  return WMO_TEXT[rounded] ?? null;
}

/**
 * 风向（来向，度）→ 八方位中文。
 * 342.5°–360° 与 0°–22.5° 都归为北风，符合"北风"覆盖区间跨 0° 的习惯。
 */
export function windDirectionText(degrees: number): string | null {
  if (!Number.isFinite(degrees)) return null;
  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return WIND_DIRECTIONS[index] ?? null;
}

/** "2026-11-27T06:53" → "06:53"；缺失或格式不符返回 null。 */
export function clockOf(iso: string): string | null {
  if (typeof iso !== "string" || iso.length < 16) return null;
  const hour = iso.slice(11, 13);
  const minute = iso.slice(14, 16);
  if (!/^\d{2}$/.test(hour) || !/^\d{2}$/.test(minute)) return null;
  return `${hour}:${minute}`;
}

/** 昼长秒数 → "12 小时 0 分"；缺失返回 null。 */
export function daylightText(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时 ${minutes} 分`;
}