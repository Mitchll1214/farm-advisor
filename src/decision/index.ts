/**
 * 决策编排 —— 把各决策模块的输出汇总为一组中文建议卡片。
 *
 * 对外只暴露两个纯函数：
 *   generateAdvisory(ctx)         → 摘要 + 卡片列表 + 数据质量提示
 *   buildCurrentConditions(ctx)   → 页面顶部"当前条件"条
 * 这样 Pages Function 只负责定位、取数、缓存与错误处理。
 */

import type {
  AdviceCard,
  AdvisoryContext,
  AdvisoryResult,
  AdvisorySummary,
  CurrentConditions,
} from "../lib/types";
import { LEVEL_RANK } from "../lib/types";
import { hourLabel, isValid, round, todayIndex, validCount } from "../lib/util";
import { droughtAdvice } from "./drought";
import { frostAdvice } from "./frost";
import { gddAdvice } from "./gdd";
import { irrigationAdvice, rootZoneSoilMoisture } from "./irrigation";
import { pestAdvice } from "./pest";
import { sprayAdvice } from "./spray";
import { waterBalanceAdvice } from "./waterBalance";

/** 生成全部建议卡片，按等级从高到低排序（同级保持固定顺序）。 */
export function generateAdvisory(ctx: AdvisoryContext): AdvisoryResult {
  const cards: AdviceCard[] = [
    irrigationAdvice(ctx),
    frostAdvice(ctx),
    gddAdvice(ctx),
    droughtAdvice(ctx),
    sprayAdvice(ctx),
    waterBalanceAdvice(ctx),
    pestAdvice(ctx),
  ];

  const sorted = [...cards].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const top = sorted[0];

  const summary: AdvisorySummary = {
    level: top.level,
    headline: top.level === "ok" ? "各项农事条件平稳，按常规管理即可" : top.headline,
    focusId: top.id,
  };

  return { summary, cards: sorted, notices: buildNotices(ctx) };
}

/** 数据质量与口径提示，前端以"提示条"形式展示。 */
function buildNotices(ctx: AdvisoryContext): string[] {
  const notices: string[] = [];
  const { crop, region, weather } = ctx;
  const hourly = weather.hourly;

  if (validCount(hourly.soilMoisture3to9) === 0 && validCount(hourly.soilMoisture9to27) === 0) {
    notices.push("本区域没有可用的分层土壤湿度数据，灌溉建议已退化为降水与蒸散的水量平衡估算。");
  }
  if (region) {
    notices.push(
      `土壤水文参数已按${region.name}（${region.climateZone}）主要土类修正：${region.soilNote}；有效降水系数取 ${region.overrides.effectiveRainFactor ?? 0.8}。`,
    );
  }
  if (weather.degradedVariables) {
    notices.push("部分农业气象变量本次不可用，建议已用核心变量降级生成，精度低于常规情况。");
  }
  if (weather.daily.time.length < 10) {
    notices.push("历史逐日数据不足，干旱趋势与积温结果的可靠性下降。");
  }
  if (crop.id === "general") {
    notices.push(
      region
        ? `未识别到${region.name}当季的主栽作物，当前按「通用大田作物」阈值计算，选择具体作物后建议会更贴合。`
        : "未能识别所在省份，当前按「通用大田作物」全国经验阈值计算；在页面上选择具体作物、或手动指定所在城市后，建议会更贴合。",
    );
  }
  if (notices.length === 0) {
    notices.push("建议基于公开气象与土壤模式数据自动生成，仅供参考。");
  }
  return notices;
}

/** 页面顶部"当前条件"条：每个字段都可能是 null，前端按缺测展示。 */
export function buildCurrentConditions(ctx: AdvisoryContext): CurrentConditions {
  const { weather } = ctx;
  const hourly = weather.hourly;
  const index = weather.nowIndex;
  const dailyIndex = todayIndex(weather.daily.time, weather.localDate);
  const et0Today = dailyIndex < weather.daily.time.length ? weather.daily.et0[dailyIndex] : NaN;
  const soilMoisture = rootZoneSoilMoisture(ctx);

  return {
    timeLabel: hourLabel(hourly.time[index] ?? ""),
    temperature: numOrNull(hourly.temperature[index], 1),
    humidity: numOrNull(hourly.humidity[index], 0),
    windSpeed: numOrNull(hourly.windSpeed[index], 1),
    soilMoisture: isValid(soilMoisture) ? round(soilMoisture * 100, 1) : null,
    soilTemperature: numOrNull(hourly.soilTemperature6[index], 1),
    precipitation1h: numOrNull(hourly.precipitation[index], 1),
    et0Today: numOrNull(et0Today, 1),
  };
}

function numOrNull(value: number, digits: number): number | null {
  return isValid(value) ? round(value, digits) : null;
}
