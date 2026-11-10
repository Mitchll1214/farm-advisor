/**
 * 农忙参谋 — 积温与物候纯函数。
 *
 * 目的：把「作物档案里的 Kc 单值」升级为「按播种日期与积温推进的 Kc 阶段」。
 * 采用 FAO-56 的三段 Kc 思路（苗期 / 发育期 / 旺盛期 / 成熟期），
 * 用全生育期 GDD 的比例划分阶段，而不是依赖固定的日历天数 ——
 * 同一作物在不同气候区、不同年份的生育进程差异很大。
 *
 * 局限：
 *   - 全生育期 GDD 是公开资料的经验量级值，不是品种实测值；
 *   - 播种日期若早于天气数据窗口，无法累计完整积温，调用方应提示精度下降；
 *   - 多年生作物（茶、柑橘、苹果、葡萄等）不按播种期推算，直接使用作物档案 Kc。
 */

import type { CropProfile, Phenology, PhenologyStage } from "./types";
import { clamp, round, todayIndex } from "./util";

/**
 * 单日积温（截断法）：日均温 = (Tmax + Tmin)/2，超出上限温度的部分不计入。
 * gdd.ts 与 pest.ts 复用同一公式，保证全站积温口径一致。
 */
export function dailyGdd(tMax: number, tMin: number, base: number, upper: number): number {
  if (!Number.isFinite(tMax) || !Number.isFinite(tMin)) return NaN;
  const mean = (tMax + tMin) / 2;
  return Math.max(0, clamp(mean, base, upper) - base);
}

interface KcAtProgress {
  kc: number;
  stage: PhenologyStage;
  stageLabel: string;
}

/**
 * 按生育进度（0–1）返回当前 Kc。
 * initial → development 线性上升，mid 持平，late 线性下降；
 * 进度超过 1 时保持成熟期 Kc，表示已到收获期。
 */
export function kcAtProgress(crop: CropProfile, progress: number): KcAtProgress {
  const stages = crop.kcStages;
  if (!stages) {
    return { kc: crop.kc, stage: "mid", stageLabel: "生长期" };
  }

  const [initialEnd, developmentEnd, midEnd] = stages.ratios;
  const p = clamp(progress, 0, 1.05);

  if (p <= initialEnd) {
    return { kc: stages.initial, stage: "initial", stageLabel: "苗期" };
  }
  if (p <= developmentEnd) {
    const span = Math.max(1e-6, developmentEnd - initialEnd);
    const ratio = (p - initialEnd) / span;
    return {
      kc: stages.initial + (stages.mid - stages.initial) * ratio,
      stage: "development",
      stageLabel: "发育期",
    };
  }
  if (p <= midEnd) {
    return { kc: stages.mid, stage: "mid", stageLabel: "旺盛期" };
  }
  if (p <= 1) {
    const span = Math.max(1e-6, 1 - midEnd);
    const ratio = (p - midEnd) / span;
    return {
      kc: stages.mid + (stages.late - stages.mid) * ratio,
      stage: "late",
      stageLabel: "成熟期",
    };
  }
  return { kc: stages.late, stage: "late", stageLabel: "成熟/收获期" };
}

/**
 * 由播种日期与逐日气温推算当前物候。
 * 返回 null 表示无法可靠推算（多年生、缺 Kc 阶段/全生育期 GDD、播种日不在数据窗口内）。
 */
export function computePhenology(input: {
  crop: CropProfile;
  sowingDate: string;
  dates: string[];
  tMax: number[];
  tMin: number[];
  today: string;
}): Phenology | null {
  const { crop, sowingDate, dates, tMax, tMin, today } = input;

  if (crop.perennial) return null;
  if (!crop.kcStages || !crop.gddToMaturity || crop.gddToMaturity <= 0) return null;

  const start = dates.indexOf(sowingDate);
  if (start < 0) return null;

  const end = todayIndex(dates, today);
  if (end <= start) return null;

  let gdd = 0;
  let seen = false;
  for (let i = start; i < end; i += 1) {
    const value = dailyGdd(tMax[i], tMin[i], crop.baseTemp, crop.upperTemp);
    if (Number.isFinite(value)) {
      gdd += value;
      seen = true;
    }
  }
  if (!seen) return null;

  const progress = gdd / crop.gddToMaturity;
  const info = kcAtProgress(crop, progress);

  return {
    sowingDate,
    stage: info.stage,
    stageLabel: info.stageLabel,
    kc: round(info.kc, 2),
    progress: round(Math.min(1.2, progress), 3),
    gddSinceSowing: round(gdd, 0),
    gddToMaturity: crop.gddToMaturity,
  };
}
