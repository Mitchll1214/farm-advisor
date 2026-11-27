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
  DailyForecastDay,
  SoilLayerView,
} from "../lib/types";
import { LEVEL_RANK } from "../lib/types";
import { rainFactorOf } from "../lib/regions";
import { hourLabel, isValid, round, todayIndex, validCount } from "../lib/util";
import { clockOf, weatherText, windDirectionText } from "../lib/wmo";
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

/**
 * 墒情剖面：与灌溉卡片使用的是同一批分层土壤湿度变量，
 * 这里按层原样摊开，让用户能看出根系深浅处的水分分布，而不只看到一个加权平均值。
 */
const SOIL_LAYERS = [
  { key: "soilMoisture0to1", label: "0–1 cm" },
  { key: "soilMoisture3to9", label: "3–9 cm" },
  { key: "soilMoisture9to27", label: "9–27 cm" },
  { key: "soilMoisture27to81", label: "27–81 cm" },
] as const;

function buildSoilProfile(ctx: AdvisoryContext): SoilLayerView[] {
  const hourly = ctx.weather.hourly;
  const index = ctx.weather.nowIndex;
  return SOIL_LAYERS.map((layer) => {
    const value = hourly[layer.key][index];
    // 与根区加权一致：只接受物理上合理的体积含水量，异常值按缺测处理。
    const usable = isValid(value) && value > 0.01 && value < 0.7;
    return { label: layer.label, value: usable ? round(value * 100, 1) : null };
  });
}

/** 页面顶部"当前条件"条：每个字段都可能是 null，前端按缺测展示。 */
export function buildCurrentConditions(ctx: AdvisoryContext): CurrentConditions {
  const { weather } = ctx;
  const hourly = weather.hourly;
  const daily = weather.daily;
  const index = weather.nowIndex;
  const dailyIndex = todayIndex(daily.time, weather.localDate);
  const inDaily = dailyIndex >= 0 && dailyIndex < daily.time.length;
  const et0Today = inDaily ? daily.et0[dailyIndex] : NaN;
  const soilMoisture = rootZoneSoilMoisture(ctx);

  return {
    timeLabel: hourLabel(hourly.time[index] ?? ""),
    temperature: numOrNull(hourly.temperature[index], 1),
    humidity: numOrNull(hourly.humidity[index], 0),
    windSpeed: numOrNull(hourly.windSpeed[index], 1),
    // 阵风是喷洒窗口的硬性排除条件，页面必须能看到它，否则平均风速会误导判断。
    windGust: numOrNull(hourly.windGust[index], 1),
    windDirection: windDirectionText(hourly.windDirection[index]),
    weather: weatherText(hourly.weatherCode[index]),
    dewPoint: numOrNull(hourly.dewPoint[index], 1),
    cloudCover: numOrNull(hourly.cloudCover[index], 0),
    vpd: numOrNull(hourly.vpd[index], 2),
    pressure: numOrNull(hourly.surfacePressure[index], 1),
    leafWetness: numOrNull(hourly.leafWetness[index], 0),
    precipProbability: numOrNull(hourly.precipProbability[index], 0),
    soilMoisture: isValid(soilMoisture) ? round(soilMoisture * 100, 1) : null,
    soilProfile: buildSoilProfile(ctx),
    soilTemperature: numOrNull(hourly.soilTemperature6[index], 1),
    precipitation1h: numOrNull(hourly.precipitation[index], 1),
    et0Today: numOrNull(et0Today, 1),
    sunrise: inDaily ? clockOf(daily.sunrise[dailyIndex] ?? "") : null,
    sunset: inDaily ? clockOf(daily.sunset[dailyIndex] ?? "") : null,
  };
}

function numOrNull(value: number, digits: number): number | null {
  return isValid(value) ? round(value, digits) : null;
}

/** 「未来 7 天」区块展示的逐日条数。 */
const FORECAST_DAYS = 7;

/**
 * 未来逐日预报：供页面「未来 7 天」区块使用。
 *
 * 数值全部来自 Open-Meteo 的 daily 响应，只有 effectivePrecipitation（有效降水）、
 * balance（有效降水 − 作物蒸散 ETc）与 daylightHours（秒 → 小时）是派生量：
 * 前两者口径与水分盈亏卡片一致，避免两处结论对不上。
 */
export function buildDailyForecast(ctx: AdvisoryContext): DailyForecastDay[] {
  const { crop, region, weather } = ctx;
  const daily = weather.daily;
  const today = todayIndex(daily.time, weather.localDate);
  const end = Math.min(daily.time.length, today + FORECAST_DAYS);
  const kc = ctx.phenology?.kc ?? crop.kc;
  const rainFactor = rainFactorOf(region);

  const out: DailyForecastDay[] = [];
  for (let i = Math.max(0, today); i < end; i += 1) {
    const date = daily.time[i] ?? "";
    if (!date) continue;

    const rain = daily.precipitation[i];
    const et0 = daily.et0[i];
    const effectiveRain = isValid(rain) ? rain * rainFactor : NaN;
    // 只有降水与蒸散都有值时才给盈亏，缺一个就留空，避免用半份数据算出误导性的结论。
    const balance =
      isValid(rain) && isValid(et0) ? round(rain * rainFactor - et0 * kc, 1) : null;
    // daylight_duration 以秒给出，页面按小时读更直观；无效值留空而不是给 0。
    const daylight = daily.daylightDuration[i];
    const daylightHours = isValid(daylight) ? round(daylight / 3600, 1) : null;

    out.push({
      date,
      tMax: numOrNull(daily.tMax[i], 1),
      tMin: numOrNull(daily.tMin[i], 1),
      precipitation: numOrNull(rain, 1),
      precipProbability: numOrNull(daily.precipProbabilityMax[i], 0),
      windSpeedMax: numOrNull(daily.windSpeedMax[i], 1),
      windGustMax: numOrNull(daily.windGustMax[i], 1),
      et0: numOrNull(et0, 1),
      effectivePrecipitation: numOrNull(effectiveRain, 1),
      daylightHours,
      weather: weatherText(daily.weatherCode[i]),
      windDirection: windDirectionText(daily.windDirectionDominant[i]),
      sunrise: clockOf(daily.sunrise[i] ?? ""),
      sunset: clockOf(daily.sunset[i] ?? ""),
      balance,
    });
  }
  return out;
}
