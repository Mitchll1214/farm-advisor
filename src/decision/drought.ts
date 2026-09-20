/**
 * 干旱趋势 —— 基于过去 14 天的降水与蒸散（参考 agrisignal-mcp 的干旱累积模型）。
 *
 * 指标：
 * 1) 连续无有效降水天数（单日 < 1 mm 记为无有效降水）；
 * 2) 近 14 天降水总量 / ET₀ 总量的比值，反映水分亏缺程度。
 * 若未来 7 天预报降水能覆盖同期蒸散的 80% 且不少于 10 mm，则下调一级旱情。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext } from "../lib/types";
import { fmt, isValid, makeCard, round, sum, todayIndex } from "../lib/util";

const PAST_WINDOW_DAYS = 14;
const FUTURE_WINDOW_DAYS = 7;
const EFFECTIVE_RAIN_MM = 1;

/** 旱情降一级。 */
function relax(level: AdviceLevel): AdviceLevel {
  if (level === "alert") return "warn";
  if (level === "warn") return "watch";
  return "ok";
}

export function droughtAdvice(ctx: AdvisoryContext): AdviceCard {
  const daily = ctx.weather.daily;
  const today = todayIndex(daily.time, ctx.weather.localDate);
  const length = daily.time.length;

  const start = Math.max(0, today - PAST_WINDOW_DAYS);
  const pastPrecip: number[] = [];
  const pastEt0: number[] = [];
  for (let i = start; i < today && i < length; i += 1) {
    pastPrecip.push(daily.precipitation[i]);
    pastEt0.push(daily.et0[i]);
  }

  const precipSum = sum(pastPrecip);
  const et0Sum = sum(pastEt0);
  const deficit = isValid(precipSum) && isValid(et0Sum) ? et0Sum - precipSum : NaN;
  const ratio = isValid(precipSum) && isValid(et0Sum) && et0Sum > 0 ? precipSum / et0Sum : NaN;

  // 连续无有效降水天数：从昨天往前数到第一个有效降水日。
  let dryDays = 0;
  for (let i = today - 1; i >= 0; i -= 1) {
    const value = daily.precipitation[i];
    if (!isValid(value) || value >= EFFECTIVE_RAIN_MM) break;
    dryDays += 1;
  }

  const futureEnd = Math.min(length, today + FUTURE_WINDOW_DAYS);
  const futurePrecip = sum(daily.precipitation.slice(today, futureEnd));
  const futureEt0 = sum(daily.et0.slice(today, futureEnd));
  const effectiveFutureEt0 = isValid(futureEt0) ? futureEt0 : 0;
  const reliefExpected =
    isValid(futurePrecip) && futurePrecip >= Math.max(10, effectiveFutureEt0 * 0.8);

  let level: AdviceLevel = "ok";
  if (dryDays >= 14 || (isValid(ratio) && ratio < 0.15)) level = "alert";
  else if (dryDays >= 8 || (isValid(ratio) && ratio < 0.35)) level = "warn";
  else if (dryDays >= 4 || (isValid(ratio) && ratio < 0.6)) level = "watch";

  const rawLevel = level;
  if (level !== "ok" && reliefExpected) level = relax(level);

  const metrics = [
    { label: "连续无有效降水", value: `${dryDays} 天` },
    { label: `近 ${PAST_WINDOW_DAYS} 天降水`, value: fmt(precipSum, 1, "mm") },
    { label: `近 ${PAST_WINDOW_DAYS} 天 ET₀`, value: fmt(et0Sum, 1, "mm") },
    { label: `近 ${PAST_WINDOW_DAYS} 天水分亏缺`, value: fmt(deficit, 1, "mm") },
    { label: "未来 7 天预报降水", value: fmt(futurePrecip, 1, "mm") },
  ];

  const reliefNote = reliefExpected
    ? `未来 7 天预报降水 ${fmt(futurePrecip, 1, "mm")}，可覆盖同期蒸散的 80% 以上，旱情有望缓解。`
    : `未来 7 天预报降水仅 ${fmt(futurePrecip, 1, "mm")}，不足以补充当前亏缺。`;

  const balanceText = `近 ${pastPrecip.length} 天累计降水 ${fmt(precipSum, 1, "mm")}、蒸散 ET₀ ${fmt(et0Sum, 1, "mm")}（降水/蒸散 ${isValid(ratio) ? round(ratio * 100, 0) : "—"}%），连续 ${dryDays} 天没有 ≥${EFFECTIVE_RAIN_MM} mm 的有效降水。`;

  if (level === "ok") {
    return makeCard({
      id: "drought",
      category: "干旱趋势",
      level: "ok",
      headline: "近期水分收支基本平衡，无明显干旱趋势",
      reason: `${balanceText}${reliefNote}`,
      actions: [
        "维持当前灌溉与保墒措施",
        "坡地与砂性土保水能力弱，可覆盖秸秆减少无效蒸发",
      ],
      metrics,
    });
  }

  const actionsByLevel: Record<Exclude<AdviceLevel, "ok">, string[]> = {
    watch: [
      "关注土壤墒情变化，优先保证作物关键需水期用水",
      "采取覆盖、少耕等保墒措施，减少表层水分蒸发",
    ],
    warn: [
      "提前安排灌溉水源与设备，重点保关键生育期地块",
      "采用滴灌、沟灌等节水方式，避免大水漫灌",
      "秸秆或地膜覆盖保墒，中耕切断土壤毛细管减少蒸发",
      "暂缓追施速效氮肥，避免肥害与徒长耗水",
    ],
    alert: [
      "立即排查水源，制定轮灌顺序，优先保苗期与关键生育期地块",
      "采用滴灌、覆膜等节水措施，减少输水与蒸发损失",
      "覆盖秸秆、中耕保墒，必要时采用抗蒸腾剂",
      "暂缓非必要田间作业与施肥，降低植株负担",
    ],
  };

  const levelWord = level === "alert" ? "重度干旱" : level === "warn" ? "明显干旱" : "偏旱";

  return makeCard({
    id: "drought",
    category: "干旱趋势",
    level,
    headline: `出现${levelWord}趋势：连续 ${dryDays} 天无有效降水，水分亏缺 ${fmt(deficit, 0, "mm")}`,
    reason: `${balanceText}${reliefNote}${rawLevel !== level ? "（已根据降水预报下调一级）" : ""}`,
    actions: actionsByLevel[level === "alert" ? "alert" : level === "warn" ? "warn" : "watch"],
    metrics,
  });
}
