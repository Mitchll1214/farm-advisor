/**
 * 水分盈亏 —— 未来 7 天逐日「有效降水 − 作物蒸散 ETc」累计（参考 agrisignal-mcp 的水分收支模型）。
 *
 * 与灌溉卡片的分工：灌溉卡片回答"现在要不要灌、灌多少"，
 * 本卡片回答"未来一周水分是净盈余还是净亏缺"。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext } from "../lib/types";
import { rainFactorOf } from "../lib/regions";
import { dateLabel, fmt, fmtSigned, isValid, makeCard, todayIndex } from "../lib/util";

const HORIZON_DAYS = 7;

export function waterBalanceAdvice(ctx: AdvisoryContext): AdviceCard {
  const { crop, weather } = ctx;
  // 有效降水系数按地区取：湿润区径流损失大，取值低于半干旱区。
  const rainFactor = rainFactorOf(ctx.region);
  const daily = weather.daily;
  const today = todayIndex(daily.time, weather.localDate);
  const length = daily.time.length;
  const end = Math.min(length, today + HORIZON_DAYS);
  const kc = ctx.phenology?.kc ?? crop.kc;
  const kcLabel = ctx.phenology
    ? `${fmt(kc, 2)}（${ctx.phenology.stageLabel}）`
    : fmt(kc, 2);

  const dates: string[] = [];
  const balances: number[] = [];
  let precipTotal = 0;
  let etcTotal = 0;
  let deficitDays = 0;
  let surplusDays = 0;
  let worstIndex = -1;
  let worstValue = 0;

  for (let i = today; i < end; i += 1) {
    const rain = daily.precipitation[i];
    const et0 = daily.et0[i];
    if (!isValid(rain) || !isValid(et0)) continue;

    const effectiveRain = rain * rainFactor;
    const etc = et0 * kc;
    const balance = effectiveRain - etc;

    dates.push(daily.time[i] ?? "");
    balances.push(balance);
    precipTotal += effectiveRain;
    etcTotal += etc;
    if (balance < -1) deficitDays += 1;
    if (balance > 1) surplusDays += 1;
    if (balance < worstValue) {
      worstValue = balance;
      worstIndex = balances.length - 1;
    }
  }

  if (balances.length === 0) {
    return makeCard({
      id: "waterBalance",
      category: "水分盈亏",
      level: "watch",
      headline: "缺少未来 7 天的逐日降水与蒸散数据，暂时无法核算水分盈亏",
      reason: "上游返回的逐日数据不足（可能因为变量裁剪或预报范围较短）。可稍后重试，或参考灌溉卡片的水量平衡结论。",
      actions: ["稍后刷新重试", "结合田间墒情人工判断"],
      metrics: [],
    });
  }

  const cumulative = balances.reduce((total, value) => total + value, 0);
  const deficitTotal = balances.reduce((total, value) => total + Math.min(0, value), 0);
  const surplusTotal = balances.reduce((total, value) => total + Math.max(0, value), 0);

  let level: AdviceLevel = "ok";
  if (cumulative <= -50) level = "alert";
  else if (cumulative <= -25) level = "warn";
  else if (cumulative <= -8) level = "watch";

  const metrics = [
    { label: `未来 ${balances.length} 天有效降水`, value: fmt(precipTotal, 1, "mm") },
    { label: `未来 ${balances.length} 天作物蒸散 ETc`, value: fmt(etcTotal, 1, "mm") },
    { label: "当前作物系数 Kc", value: kcLabel },
    { label: "净盈亏", value: fmtSigned(cumulative, 1, "mm") },
    { label: "亏缺 / 盈余天数", value: `${deficitDays} / ${surplusDays} 天` },
    {
      label: "最缺水的日子",
      value: worstIndex >= 0 ? `${dateLabel(dates[worstIndex] ?? "")}（${fmtSigned(worstValue, 1, "mm")}）` : "—",
    },
  ];

  const regionText = ctx.region ? `（有效降水系数按${ctx.region.name}取 ${rainFactor}）` : "";
  const reason = `未来 ${balances.length} 天按有效降水系数 ${rainFactor}、作物系数 Kc ${kcLabel}（${crop.name}）逐日核算${regionText}：有效降水 ${fmt(precipTotal, 1, "mm")}、作物蒸散 ETc ${fmt(etcTotal, 1, "mm")}，净盈亏 ${fmtSigned(cumulative, 1, "mm")}（累计亏缺 ${fmt(deficitTotal, 1, "mm")}、累计盈余 ${fmt(surplusTotal, 1, "mm")}）。`;

  if (level === "ok") {
    return makeCard({
      id: "waterBalance",
      category: "水分盈亏",
      level: "ok",
      headline: `未来一周水分${cumulative >= 0 ? "净盈余" : "略有亏缺"} ${fmt(Math.abs(cumulative), 0, "mm")}，总体平衡`,
      reason,
      actions: [
        "按当前灌溉节奏管理，无需额外补水",
        "雨后及时检查田间排水，避免短时积水造成渍害",
      ],
      metrics,
    });
  }

  const headline =
    cumulative <= -25
      ? `未来一周水分净亏缺 ${fmt(Math.abs(cumulative), 0, "mm")}，需提前安排灌溉`
      : `未来一周水分净亏缺 ${fmt(Math.abs(cumulative), 0, "mm")}，注意保墒`;

  const actions: string[] = [
    `按当前蒸散强度，日均亏缺约 ${fmt(Math.abs(cumulative) / balances.length, 1, "mm")}，可分次补灌、避免单次过量`,
    "优先保证作物关键需水期地块的用水",
    "采取覆盖、中耕等保墒措施降低无效蒸发",
  ];
  if (level === "alert") {
    actions.unshift("本周亏缺较大，建议立即检修灌溉设备并按计划轮灌");
  }

  return makeCard({
    id: "waterBalance",
    category: "水分盈亏",
    level,
    headline,
    reason,
    actions,
    metrics,
  });
}
