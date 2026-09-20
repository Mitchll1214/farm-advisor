/**
 * 病虫害风险提示（可选模块，气象驱动）。
 *
 * 重要说明：本模块只用气象条件推断"是否有利于发生"，没有接入田块虫情调查、
 * 诱捕器计数或区域测报数据，因此等级上限为"预警"，不作为施药依据。
 *
 * 判定：近 3 天平均气温落入害虫/病害适宜区间、近 72 小时平均相对湿度达到下限，
 * 需湿型病害还要求近 3 天累计降水 ≥ 2 mm；非需湿型虫害在近 3 天降水 ≥ 15 mm 时
 * 因雨水冲刷下调一级。近 14 天积温（按各模型基点温度）作为发育进度参考量展示。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext, PestModel } from "../lib/types";
import { avg, fmt, isValid, makeCard, sum, todayIndex } from "../lib/util";
import { dailyGdd } from "./gdd";

const TEMP_WINDOW_DAYS = 3;
const GDD_WINDOW_DAYS = 14;
const HUMIDITY_WINDOW_HOURS = 72;
/** 需湿型病害在近 3 天累计降水低于该值时不算满足。 */
const WET_MIN_MM = 2;
/** 非需湿型虫害在近 3 天降水超过该值时，因冲刷下调一级。 */
const WASHOUT_MM = 15;
/** 积温计算时使用的气温上限（超过部分不计入）。 */
const GDD_UPPER_TEMP = 40;

interface PestHit {
  pest: PestModel;
  level: AdviceLevel;
  gdd: number;
}

export function pestAdvice(ctx: AdvisoryContext): AdviceCard {
  const { crop, weather } = ctx;
  const daily = weather.daily;
  const hourly = weather.hourly;
  const today = todayIndex(daily.time, weather.localDate);

  const windowStart = Math.max(0, today - TEMP_WINDOW_DAYS);
  const tMax = avg(daily.tMax.slice(windowStart, today));
  const tMin = avg(daily.tMin.slice(windowStart, today));
  const meanTemp = isValid(tMax) && isValid(tMin) ? (tMax + tMin) / 2 : NaN;
  const rain3 = sum(daily.precipitation.slice(windowStart, today));

  const humidityStart = Math.max(0, weather.nowIndex - HUMIDITY_WINDOW_HOURS);
  const humidity = avg(hourly.humidity.slice(humidityStart, weather.nowIndex + 1));

  const metricsCommon = [
    { label: "近 3 天平均气温", value: fmt(meanTemp, 1, "℃") },
    { label: "近 72h 平均湿度", value: fmt(humidity, 0, "%") },
    { label: "近 3 天累计降水", value: fmt(rain3, 1, "mm") },
  ];

  if (crop.pests.length === 0) {
    return makeCard({
      id: "pest",
      category: "病虫害风险",
      level: "ok",
      headline: `${crop.name} 未配置病虫害气象模型`,
      reason: "当前作物档案没有可用的病虫害温湿阈值，暂不给出风险提示。",
      actions: ["按当地植保部门测报安排防治", "如需覆盖病虫害提示，可在作物档案中补充模型参数"],
      metrics: metricsCommon,
    });
  }

  const hits: PestHit[] = [];
  const gddStart = Math.max(0, today - GDD_WINDOW_DAYS);

  for (const pest of crop.pests) {
    let gdd = 0;
    let gddSeen = false;
    for (let i = gddStart; i < today && i < daily.time.length; i += 1) {
      const value = dailyGdd(daily.tMax[i], daily.tMin[i], pest.baseTemp, GDD_UPPER_TEMP);
      if (isValid(value)) {
        gdd += value;
        gddSeen = true;
      }
    }
    const gddValue = gddSeen ? gdd : NaN;

    const tempOk = isValid(meanTemp) && meanTemp >= pest.tempMin && meanTemp <= pest.tempMax;
    const humidityOk = isValid(humidity) ? humidity >= pest.humidityMin : false;
    const wetOk = pest.needsWet ? isValid(rain3) && rain3 >= WET_MIN_MM : true;
    if (!(tempOk && humidityOk && wetOk)) continue;

    const center = (pest.tempMin + pest.tempMax) / 2;
    const half = (pest.tempMax - pest.tempMin) / 2;
    let level: AdviceLevel =
      half > 0 && isValid(meanTemp) && Math.abs(meanTemp - center) <= half * 0.5 ? "warn" : "watch";

    // 非需湿型：大雨冲刷会压低虫口，下调一级。
    if (!pest.needsWet && isValid(rain3) && rain3 >= WASHOUT_MM && level === "warn") level = "watch";

    hits.push({ pest, level, gdd: gddValue });
  }

  hits.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
  const topHit = hits[0];

  if (!topHit) {
    return makeCard({
      id: "pest",
      category: "病虫害风险",
      level: "ok",
      headline: "当前温湿条件不利于主要病虫害活跃",
      reason: `近 3 天平均气温 ${fmt(meanTemp, 1, "℃")}、近 72 小时平均相对湿度 ${fmt(humidity, 0, "%")}、累计降水 ${fmt(rain3, 1, "mm")}，均未同时落入 ${crop.name} 主要病虫害的适宜发生区间。本提示仅依据气象条件推断，未经田块虫情校准。`,
      actions: [
        "保持常规田间巡查，重点查看叶片背面与新梢",
        "遇连续阴雨或气温骤升，及时重新评估",
      ],
      metrics: metricsCommon,
    });
  }

  const names = hits.map((hit) => hit.pest.name).join("、");
  const level: AdviceLevel = topHit.level === "warn" ? "warn" : "watch";

  const detail = hits
    .slice(0, 3)
    .map((hit) => {
      const condition = `适宜区间 ${hit.pest.tempMin}–${hit.pest.tempMax} ℃、湿度 ≥ ${hit.pest.humidityMin}%`;
      const gddText = isValid(hit.gdd) ? `，近 ${GDD_WINDOW_DAYS} 天积温 ${fmt(hit.gdd, 0, "GDD")}（基点 ${hit.pest.baseTemp} ℃）` : "";
      return `${hit.pest.name}：${condition}${gddText}`;
    })
    .join("；");

  const actions = hits.slice(0, 3).map((hit) => hit.pest.advice);
  actions.push("以田块实际调查结果为准，达到当地防治指标后再用药");

  return makeCard({
    id: "pest",
    category: "病虫害风险",
    level,
    headline: `气象条件有利于${names}发生发展`,
    reason: `近 3 天平均气温 ${fmt(meanTemp, 1, "℃")}、近 72 小时平均相对湿度 ${fmt(humidity, 0, "%")}、累计降水 ${fmt(rain3, 1, "mm")}，达到以下模型的适宜发生条件——${detail}。本提示为气象驱动的风险推断，没有接入田块虫情与测报数据，不能替代田间调查。`,
    actions,
    metrics: [
      ...metricsCommon,
      {
        label: "参考积温",
        value: isValid(topHit.gdd) ? `${fmt(topHit.gdd, 0, "GDD")}（基点 ${topHit.pest.baseTemp} ℃）` : "—",
      },
    ],
  });
}
