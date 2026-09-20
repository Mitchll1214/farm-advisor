/**
 * 霜冻与热应激风险 —— 扫描未来 48 小时逐时气温（参考 agrisignal-mcp 的霜冻/热胁迫模型）。
 *
 * 判定使用 2 m 气温：作物冠层与地表实际温度在晴夜还会更低，
 * 因此把阈值以上的 2 ℃ 区间作为"关注"档，留出缓冲。
 */

import type { AdviceCard, AdviceLevel, AdvisoryContext } from "../lib/types";
import { LEVEL_RANK } from "../lib/types";
import { fmt, higherLevel, hourLabel, makeCard, maxIndex, minIndex, windowOf } from "../lib/util";

const HORIZON_HOURS = 48;

export function frostAdvice(ctx: AdvisoryContext): AdviceCard {
  const { crop, weather } = ctx;
  const hourly = weather.hourly;
  const start = weather.nowIndex;

  const temperatures = windowOf(hourly.temperature, start, HORIZON_HOURS);
  const times = hourly.time.slice(start, start + HORIZON_HOURS);

  const coldIndex = minIndex(temperatures);
  const hotIndex = maxIndex(temperatures);
  const tMin = coldIndex >= 0 ? temperatures[coldIndex] : NaN;
  const tMax = hotIndex >= 0 ? temperatures[hotIndex] : NaN;
  const tMinTime = coldIndex >= 0 ? (times[coldIndex] ?? "") : "";
  const tMaxTime = hotIndex >= 0 ? (times[hotIndex] ?? "") : "";

  const frostLevel: AdviceLevel = !Number.isFinite(tMin)
    ? "ok"
    : tMin <= crop.frostTmin - 2
      ? "alert"
      : tMin <= crop.frostTmin
        ? "warn"
        : tMin <= crop.frostTmin + 2
          ? "watch"
          : "ok";

  const heatLevel: AdviceLevel = !Number.isFinite(tMax)
    ? "ok"
    : tMax >= crop.heatTmax + 3
      ? "alert"
      : tMax >= crop.heatTmax
        ? "warn"
        : tMax >= crop.heatTmax - 2
          ? "watch"
          : "ok";

  const level = higherLevel(frostLevel, heatLevel);
  const metrics = [
    { label: "48h 最低气温", value: Number.isFinite(tMin) ? `${fmt(tMin, 1, "℃")}（${hourLabel(tMinTime)}）` : "—" },
    { label: "48h 最高气温", value: Number.isFinite(tMax) ? `${fmt(tMax, 1, "℃")}（${hourLabel(tMaxTime)}）` : "—" },
    { label: "霜冻阈值", value: `${fmt(crop.frostTmin, 0, "℃")}` },
    { label: "热应激阈值", value: `${fmt(crop.heatTmax, 0, "℃")}` },
  ];

  if (level === "ok") {
    return makeCard({
      id: "frost",
      category: "霜冻 / 热应激",
      level: "ok",
      headline: "未来 48 小时无霜冻与高温胁迫风险",
      reason: `未来 48 小时气温区间 ${fmt(tMin, 1, "℃")} ~ ${fmt(tMax, 1, "℃")}，处于 ${crop.name} 的耐受范围（霜冻阈值 ${fmt(crop.frostTmin, 0, "℃")}、热应激阈值 ${fmt(crop.heatTmax, 0, "℃")}）内。`,
      actions: ["按正常节奏安排田间作业", "夜间晴冷时段仍建议留意低洼地块的辐射降温"],
      metrics,
    });
  }

  // 霜冻风险主导。必须用 LEVEL_RANK 比较：字符串直接比较会得到
  // "watch" >= "warn" 为真这类错误结果。
  if (frostLevel !== "ok" && LEVEL_RANK[frostLevel] >= LEVEL_RANK[heatLevel]) {
    const actions =
      frostLevel === "watch"
        ? ["提前关注夜间降温预报，准备好覆盖物或熏烟材料", "苗期作物可适当推迟定植，避开降温过程"]
        : [
            "霜冻前 1 天傍晚灌水，利用土壤热容减缓夜间降温",
            "低洼地块与苗期作物用无纺布、稻草覆盖，或在上风侧熏烟增温",
            "霜冻过后及时检查受冻叶片，暂缓追施速效氮肥以免加重冷害",
            "果树花期可提前喷施磷酸二氢钾等措施提高抗寒性",
          ];
    return makeCard({
      id: "frost",
      category: "霜冻 / 热应激",
      level: frostLevel,
      headline: `未来 48 小时最低 ${fmt(tMin, 1, "℃")}，${crop.name} 有霜冻风险`,
      reason: `预计 ${hourLabel(tMinTime)} 前后出现最低气温 ${fmt(tMin, 1, "℃")}，低于 ${crop.name} 的霜冻阈值 ${fmt(crop.frostTmin, 0, "℃")}。晴夜地表温度通常比 2 m 气温再低 1–2 ℃，实际霜冻可能更强。`,
      actions,
      metrics,
    });
  }

  // 热应激风险主导
  const heatActions =
    heatLevel === "watch"
      ? ["关注午间高温，提前把灌溉安排在清晨或傍晚", "高温来临前适量灌水，增加田间湿度缓冲降温"]
      : [
          "把灌溉改到清晨或傍晚，避免中午高温时段浇水",
          "设施栽培及时通风、遮阳，必要时喷雾降温",
          "高温期间避免喷施药剂与叶面肥，防止药害与蒸发损失",
          "注意开花授粉期高温对结实率的影响，必要时辅助授粉",
        ];
  return makeCard({
    id: "frost",
    category: "霜冻 / 热应激",
    level: heatLevel,
    headline: `未来 48 小时最高 ${fmt(tMax, 1, "℃")}，${crop.name} 有高温胁迫风险`,
    reason: `预计 ${hourLabel(tMaxTime)} 前后出现最高气温 ${fmt(tMax, 1, "℃")}，达到或超过 ${crop.name} 的热应激阈值 ${fmt(crop.heatTmax, 0, "℃")}。持续高温会加剧蒸腾失水并影响授粉结实。`,
    actions: heatActions,
    metrics,
  });
}
