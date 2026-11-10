/**
 * 喷洒窗口 —— 未来 48 小时逐小时打分，筛出适合喷施农药/叶面肥的时段
 * （参考 agrisignal-mcp 的喷洒窗口模型）。
 *
 * 硬性排除条件（任一命中即该小时不可作业）：
 *   夜间与清晨（20:00–05:00）、正在降水、风速 > 5 m/s、阵风 > 9 m/s、
 *   气温 < 5 ℃ 或 > 32 ℃、未来 6 小时雨量 > 1 mm、降水概率 > 70%。
 * 其余条件按风速/温度/湿度/降水概率/蒸发强度扣分，得到 0–100 的作业适宜度。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext } from "../lib/types";
import { avg, clamp, fmt, hourLabel, hourOf, isValid, makeCard, sum, windowOf } from "../lib/util";

const HORIZON_HOURS = 48;
const DAY_START = 5;
const DAY_END = 19;
const WIND_BLOCK = 5;
const WIND_IDEAL = 3;
const GUST_BLOCK = 9;
const TEMP_MIN = 5;
const TEMP_MAX = 32;
const HUMIDITY_LOW = 40;
const HUMIDITY_HIGH = 92;
const PROB_BLOCK = 70;
const RAIN_NEXT6_BLOCK = 1;
/** 窗口至少要满足的分数与时长，避免把"勉强能喷"的碎片时段推给用户。 */
const MIN_WINDOW_SCORE = 45;
const MIN_SINGLE_HOUR_SCORE = 85;
const MAX_WINDOWS = 3;

interface HourScore {
  index: number;
  score: number;
  blocked: string | null;
  wind: number;
  temp: number;
  humidity: number;
  vpd: number;
}

interface SprayWindow {
  startIndex: number;
  endIndex: number;
  hours: number;
  score: number;
  wind: number;
  temp: number;
  humidity: number;
  vpd: number;
}

function scoreHour(ctx: AdvisoryContext, index: number): HourScore {
  const hourly = ctx.weather.hourly;
  const time = hourly.time[index] ?? "";
  const hour = hourOf(time);
  const wind = hourly.windSpeed[index];
  const gust = hourly.windGust[index];
  const temp = hourly.temperature[index];
  const humidity = hourly.humidity[index];
  const precip = hourly.precipitation[index];
  const probability = hourly.precipProbability[index];
  const et0 = hourly.et0[index];
  const vpd = hourly.vpd[index];
  const base = { index, wind, temp, humidity, vpd };

  if (!isValid(hour)) return { ...base, score: 0, blocked: "时间数据缺失" };
  if (hour < DAY_START || hour > DAY_END) {
    return { ...base, score: 0, blocked: "夜间与清晨时段，不宜喷洒作业" };
  }
  if (!isValid(wind) || !isValid(temp)) return { ...base, score: 0, blocked: "气象数据缺失" };
  if (isValid(precip) && precip > 0.1) return { ...base, score: 0, blocked: "正在降水" };
  if (wind > WIND_BLOCK) {
    return { ...base, score: 0, blocked: `风速 ${fmt(wind, 1, "m/s")}，飘移风险高` };
  }
  if (isValid(gust) && gust > GUST_BLOCK) return { ...base, score: 0, blocked: "阵风过大，飘移风险高" };
  if (temp < TEMP_MIN) return { ...base, score: 0, blocked: `气温 ${fmt(temp, 0, "℃")} 过低，药效差` };
  if (temp > TEMP_MAX) return { ...base, score: 0, blocked: `气温 ${fmt(temp, 0, "℃")} 过高，易药害` };

  const rainNext6 = sum(windowOf(hourly.precipitation, index, 6));
  if (isValid(rainNext6) && rainNext6 > RAIN_NEXT6_BLOCK) {
    return { ...base, score: 0, blocked: "未来 6 小时有雨，药液易被冲刷" };
  }
  if (isValid(probability) && probability > PROB_BLOCK) {
    return { ...base, score: 0, blocked: `降水概率 ${fmt(probability, 0, "%")}，风险偏高` };
  }

  let score = 100;
  if (wind > WIND_IDEAL) score -= 12;
  else if (wind > 2) score -= 5;
  if (isValid(gust) && gust > 6) score -= 8;
  if (temp < 10 || temp > 28) score -= 12;
  if (isValid(humidity)) {
    if (humidity < HUMIDITY_LOW) score -= 12;
    else if (humidity < 50) score -= 6;
    else if (humidity > HUMIDITY_HIGH) score -= 6;
    else if (humidity > 85) score -= 8;
  }
  if (isValid(vpd)) {
    // VPD 过高：雾滴蒸发快、飘移与药害风险上升；过低：叶面干燥慢、药液易流失。
    if (vpd > 2.5) score -= 10;
    else if (vpd > 2.0) score -= 6;
    else if (vpd < 0.4) score -= 5;
  }
  if (isValid(probability)) {
    if (probability > 50) score -= 12;
    else if (probability > 20) score -= 8;
  }
  if (isValid(et0) && et0 > 0.35) score -= 10;

  return { ...base, score: clamp(Math.round(score), 0, 100), blocked: null };
}

export function sprayAdvice(ctx: AdvisoryContext): AdviceCard {
  const hourly = ctx.weather.hourly;
  const start = ctx.weather.nowIndex + 1;
  const end = Math.min(hourly.time.length, start + HORIZON_HOURS);

  const hours: HourScore[] = [];
  for (let i = start; i < end; i += 1) hours.push(scoreHour(ctx, i));

  // 把连续可作业的小时合并成窗口
  const windows: SprayWindow[] = [];
  let current: HourScore[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const score = avg(current.map((item) => item.score));
    const acceptable =
      current.length >= 2 || (current.length === 1 && current[0].score >= MIN_SINGLE_HOUR_SCORE);
    if (acceptable && isValid(score) && score >= MIN_WINDOW_SCORE) {
      windows.push({
        startIndex: current[0].index,
        endIndex: current[current.length - 1].index,
        hours: current.length,
        score: Math.round(score),
        wind: avg(current.map((item) => item.wind)),
        temp: avg(current.map((item) => item.temp)),
        humidity: avg(current.map((item) => item.humidity)),
        vpd: avg(current.map((item) => item.vpd)),
      });
    }
    current = [];
  };

  for (const hour of hours) {
    if (hour.blocked === null) current.push(hour);
    else flush();
  }
  flush();

  windows.sort((a, b) => b.score - a.score);
  const top = windows.slice(0, MAX_WINDOWS);
  const best = top[0];

  const blockedReasons = new Map<string, number>();
  for (const hour of hours) {
    if (hour.blocked) blockedReasons.set(hour.blocked, (blockedReasons.get(hour.blocked) ?? 0) + 1);
  }
  const mainBlocker = [...blockedReasons.entries()].sort((a, b) => b[1] - a[1])[0];

  const metrics = best
    ? [
        {
          label: "最佳窗口",
          value: `${hourLabel(hourly.time[best.startIndex] ?? "")} – ${hourLabel(hourly.time[best.endIndex] ?? "")}`,
        },
        { label: "窗口适宜度", value: `${best.score} / 100` },
        { label: "窗口平均风速", value: fmt(best.wind, 1, "m/s") },
        { label: "窗口平均气温", value: fmt(best.temp, 1, "℃") },
        { label: "窗口平均湿度", value: fmt(best.humidity, 0, "%") },
        { label: "窗口平均 VPD", value: fmt(best.vpd, 2, "kPa") },
        { label: "未来 48h 候选窗口", value: `${windows.length} 个` },
      ]
    : [
        { label: "未来 48h 候选窗口", value: "0 个" },
        { label: "主要限制因素", value: mainBlocker ? mainBlocker[0] : "气象条件不满足作业要求" },
      ];

  const conditionText = `判定条件：风速 ≤ ${WIND_BLOCK} m/s、阵风 ≤ ${GUST_BLOCK} m/s、无降水且未来 6 小时雨量 < ${RAIN_NEXT6_BLOCK} mm、气温 ${TEMP_MIN}–${TEMP_MAX} ℃、降水概率 ≤ ${PROB_BLOCK}%，作业时段限 ${DAY_START}:00–${DAY_END}:00；VPD 作为蒸发与飘移的扣分项（>2.5 kPa 或 <0.4 kPa 降分）。`;

  if (!best) {
    const level: AdviceLevel = "warn";
    return makeCard({
      id: "spray",
      category: "喷洒窗口",
      level,
      headline: "未来 48 小时没有适合作业的喷洒窗口",
      reason: `${conditionText}未来 48 小时逐小时评估后没有满足条件的连续时段${mainBlocker ? `，主要限制因素是「${mainBlocker[0]}」（占 ${mainBlocker[1]} 小时）` : ""}。`,
      actions: [
        "暂缓喷药，等风速降低或无雨时段再安排作业",
        "确需作业时改用抗飘移喷头、降低喷头高度并加大雾滴粒径",
        "雨后重新评估药效，必要时按标签要求补喷",
        "优先处理病虫害已达防治指标的地块，其余地块可延后",
      ],
      metrics,
    });
  }

  const level: AdviceLevel = best.score >= 75 ? "ok" : best.score >= 60 ? "watch" : "warn";
  const windowText = top
    .map(
      (item) =>
        `${hourLabel(hourly.time[item.startIndex] ?? "")}–${hourLabel(hourly.time[item.endIndex] ?? "")}（${item.score} 分）`,
    )
    .join("、");

  const headline =
    level === "ok"
      ? `适宜作业：${hourLabel(hourly.time[best.startIndex] ?? "")} 起 ${best.hours} 小时（${best.score} 分）`
      : level === "watch"
        ? `窗口条件一般：${hourLabel(hourly.time[best.startIndex] ?? "")} 起 ${best.hours} 小时（${best.score} 分）`
        : `窗口条件较差，仅 ${hourLabel(hourly.time[best.startIndex] ?? "")} 前后勉强可作业（${best.score} 分）`;

  return makeCard({
    id: "spray",
    category: "喷洒窗口",
    level,
    headline,
    reason: `${conditionText}未来 48 小时筛出 ${windows.length} 个候选窗口，推荐时段：${windowText}。首选窗口平均风速 ${fmt(best.wind, 1, "m/s")}、气温 ${fmt(best.temp, 1, "℃")}、相对湿度 ${fmt(best.humidity, 0, "%")}、VPD ${fmt(best.vpd, 2, "kPa")}。`,
    actions: [
      "选择清晨露水干后或傍晚作业，此时风速低、蒸发损失小",
      "核查下风向 100 m 内有无敏感作物、水源、蜂场与居民点",
      "按标签推荐剂量与用水量配药，避免重喷、漏喷",
      "施药后 6 小时内如遇降雨，视药剂耐冲刷性决定是否补喷",
    ],
    metrics,
  });
}
