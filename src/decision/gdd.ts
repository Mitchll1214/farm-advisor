/**
 * 生长度日 GDD（参考 agrisignal-mcp 的积温模型）。
 *
 * 算法：日均气温 = (Tmax + Tmin)/2，用上限温度截断后减去基温（截断法）：
 *   GDD = max(0, clamp(日均温, 基温, 上限温度) − 基温)
 * 输出近 14 天实测积温与未来 7 天预报积温，用于判断热量供给节奏。
 *
 * 局限：没有播种日期，无法换算作物生育阶段，因此本卡片只报告积温收支与速率，
 * 不宣称"当前处于某生育期"。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext } from "../lib/types";
import { dailyGdd } from "../lib/agro";
import { avg, clamp, fmt, isValid, makeCard, sum, todayIndex } from "../lib/util";

export { dailyGdd } from "../lib/agro";

const PAST_DAYS = 14;
const FUTURE_DAYS = 7;

export function gddAdvice(ctx: AdvisoryContext): AdviceCard {
  const { crop, weather } = ctx;
  const daily = weather.daily;
  const today = todayIndex(daily.time, weather.localDate);
  const length = daily.time.length;

  const pastStart = Math.max(0, today - PAST_DAYS);
  const pastValues: number[] = [];
  for (let i = pastStart; i < today && i < length; i += 1) {
    pastValues.push(dailyGdd(daily.tMax[i], daily.tMin[i], crop.baseTemp, crop.upperTemp));
  }

  const futureEnd = Math.min(length, today + FUTURE_DAYS);
  const futureValues: number[] = [];
  for (let i = today; i < futureEnd; i += 1) {
    futureValues.push(dailyGdd(daily.tMax[i], daily.tMin[i], crop.baseTemp, crop.upperTemp));
  }

  const pastSum = sum(pastValues);
  const futureSum = sum(futureValues);
  const futureRate = avg(futureValues);
  const pastRate = avg(pastValues);

  const base = crop.baseTemp;
  const upper = crop.upperTemp;
  const maxDailyGdd = Math.max(1, upper - base);

  let level: AdviceLevel = "ok";
  let headline =
    futureValues.length > 0
      ? `近 ${pastValues.length} 天积温 ${fmt(pastSum, 0, "GDD")}，未来 ${futureValues.length} 天预计 ${fmt(futureSum, 0, "GDD")}`
      : `近 ${pastValues.length} 天积温 ${fmt(pastSum, 0, "GDD")}（本次未取得未来的逐日预报）`;

  if (isValid(futureRate)) {
    if (futureRate < Math.max(2, maxDailyGdd * 0.2)) {
      level = "watch";
      headline = `热量供给偏少：未来日均积温仅 ${fmt(futureRate, 1, "GDD")}`;
    } else if (futureRate > maxDailyGdd * 0.8) {
      level = "watch";
      headline = `热量偏足：未来日均积温约 ${fmt(futureRate, 1, "GDD")}，注意高温逼熟`;
    }
  }

  const metrics = [
    { label: `近 ${PAST_DAYS} 天积温`, value: fmt(pastSum, 0, "GDD") },
    { label: `未来 ${FUTURE_DAYS} 天预计积温`, value: fmt(futureSum, 0, "GDD") },
    { label: "未来日均积温", value: fmt(futureRate, 1, "GDD/天") },
    { label: "基准 / 上限温度", value: `${fmt(base, 0, "℃")} / ${fmt(upper, 0, "℃")}` },
  ];

  const phenology = ctx.phenology;
  if (phenology) {
    metrics.splice(
      3,
      0,
      { label: "播种以来积温", value: fmt(phenology.gddSinceSowing, 0, "GDD") },
      { label: "全生育期参考", value: fmt(phenology.gddToMaturity, 0, "GDD") },
      {
        label: "当前物候",
        value: `${phenology.stageLabel}（进度 ${fmt(phenology.progress * 100, 0, "%")}，Kc ${fmt(phenology.kc, 2)}）`,
      },
    );
  }

  const actions: string[] = [];
  if (level === "watch" && isValid(futureRate) && futureRate < maxDailyGdd * 0.5) {
    actions.push("热量偏少，可考虑地膜或秸秆覆盖提高地温，苗期不宜过早播种");
    actions.push("低温时段避免偏施氮肥，以免徒长削弱抗逆性");
  } else if (level === "watch") {
    actions.push("热量偏足，保证水肥供应，避免灌浆期缺水导致粒重下降");
    actions.push("高温时段注意田间通风与适度灌水降温");
  } else {
    actions.push("热量供给正常，按当前生育期常规水肥管理即可");
  }
  actions.push("把播种日期与逐日积温记入田间档案，可据此换算生育阶段，判断精度会明显提高");
  actions.push(`当前按 ${crop.name} 基点温度 ${fmt(base, 0, "℃")} 计算，切换作物后积温口径会随之改变`);

  const phenologyReason = phenology
    ? `已按播种日期 ${phenology.sowingDate} 累计播种以来积温 ${fmt(phenology.gddSinceSowing, 0, "GDD")}，约为全生育期 ${fmt(phenology.gddToMaturity, 0, "GDD")} 的 ${fmt(phenology.progress * 100, 0, "%")}，当前处于${phenology.stageLabel}（Kc ${fmt(phenology.kc, 2)}）。`
    : "未提供播种日期，故不推断当前所处的生育阶段，仅反映热量收支节奏。";

  const reason = `采用基点温度 ${fmt(base, 0, "℃")}、上限温度 ${fmt(upper, 0, "℃")} 的截断法逐日计算：近 ${pastValues.length} 天累计 ${fmt(pastSum, 0, "GDD")}（日均 ${fmt(pastRate, 1, "GDD")}），未来 ${futureValues.length} 天预报累计 ${fmt(futureSum, 0, "GDD")}（日均 ${fmt(futureRate, 1, "GDD")}）。${phenologyReason}`;

  return makeCard({
    id: "gdd",
    category: "生长度日 GDD",
    level,
    headline,
    reason,
    actions,
    metrics,
  });
}
