/**
 * 农忙参谋 — 数值与格式化工具。
 *
 * 约定：所有来自 Open-Meteo 的缺失值在使用前都已被转成 NaN，
 * 因此这里的函数统一切实处理 NaN，避免决策模块出现 NaN 传播。
 */

import { LEVEL_LABEL, LEVEL_RANK } from "./types";
import type { AdviceCard, AdviceLevel, Metric } from "./types";

/** 把未知输入转成数字，不可用则返回 NaN。 */
export function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** 是否为可用数值（非 NaN / Infinity）。 */
export function isValid(value: number): boolean {
  return Number.isFinite(value);
}

export function round(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return NaN;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 求和，自动跳过 NaN。全为 NaN 时返回 NaN。 */
export function sum(values: number[]): number {
  let total = 0;
  let seen = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
      seen += 1;
    }
  }
  return seen === 0 ? NaN : total;
}

/** 平均，自动跳过 NaN。全为 NaN 时返回 NaN。 */
export function avg(values: number[]): number {
  let total = 0;
  let seen = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
      seen += 1;
    }
  }
  return seen === 0 ? NaN : total / seen;
}

/** 有效值个数。 */
export function validCount(values: number[]): number {
  let seen = 0;
  for (const value of values) {
    if (Number.isFinite(value)) seen += 1;
  }
  return seen;
}

/** 最小值的下标，全为 NaN 时返回 -1。 */
export function minIndex(values: number[]): number {
  let best = -1;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (Number.isFinite(value) && value < bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** 最大值的下标，全为 NaN 时返回 -1。 */
export function maxIndex(values: number[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (Number.isFinite(value) && value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** 量化格式化：NaN 输出 “—”，避免页面上出现 NaN。 */
export function fmt(value: number, digits = 1, unit = ""): string {
  if (!Number.isFinite(value)) return "—";
  const text = value.toFixed(digits);
  return unit ? `${text} ${unit}` : text;
}

/** 带正负号的格式化，用于水分盈亏这类有方向的量。 */
export function fmtSigned(value: number, digits = 1, unit = ""): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

/** "2026-09-20T14:00" → "9月20日 14:00"。 */
export function hourLabel(iso: string): string {
  if (typeof iso !== "string" || iso.length < 13) return "—";
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const hour = iso.slice(11, 13);
  return `${month}月${day}日 ${hour}:00`;
}

/** "2026-09-20" → "9月20日"。 */
export function dateLabel(iso: string): string {
  if (typeof iso !== "string" || iso.length < 10) return "—";
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return `${month}月${day}日`;
}

/** "2026-09-20T14:00" 或 "2026-09-20" → 14 / 0。 */
export function hourOf(iso: string): number {
  if (typeof iso !== "string" || iso.length < 13) return NaN;
  return Number(iso.slice(11, 13));
}

/** 截取一段数组（越界安全）。 */
export function windowOf(values: number[], start: number, count: number): number[] {
  const from = Math.max(0, start);
  return values.slice(from, from + Math.max(0, count));
}

/** 取两者中更高的建议等级。 */
export function higherLevel(a: AdviceLevel, b: AdviceLevel): AdviceLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** 构造建议卡片，自动补上等级中文标签。 */
export function makeCard(input: {
  id: string;
  category: string;
  level: AdviceLevel;
  headline: string;
  reason: string;
  actions: string[];
  metrics?: Metric[];
}): AdviceCard {
  return {
    id: input.id,
    category: input.category,
    level: input.level,
    levelLabel: LEVEL_LABEL[input.level],
    headline: input.headline,
    reason: input.reason,
    actions: input.actions,
    metrics: input.metrics ?? [],
  };
}

/**
 * 在 daily.time 里定位"今天"的下标：优先精确匹配，否则取第一个不早于 today 的日期，
 * 全部日期都早于 today 时返回数组长度（调用方应据此判断数据不足）。
 */
export function todayIndex(dates: string[], today: string): number {
  const exact = dates.indexOf(today);
  if (exact >= 0) return exact;
  for (let i = 0; i < dates.length; i += 1) {
    if (dates[i] >= today) return i;
  }
  return dates.length;
}
