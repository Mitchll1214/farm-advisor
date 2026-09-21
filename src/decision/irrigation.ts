/**
 * 灌溉建议 —— 根区水量平衡模型（参考 agrisignal-mcp 的灌溉决策）。
 *
 * 数据：Open-Meteo 分层土壤湿度（0–1 / 3–9 / 9–27 cm）、FAO-56 参考蒸散 ET₀、逐小时降水。
 * 水量：ETc = ET₀ × Kc；有效降水按 80%；根区可利用水 TAW = (FC − PWP) × 根深。
 * 触发：剩余有效水低于 TAW × refillTrigger 时建议灌溉，补至田间持水量。
 * 未接入 SoilGrids，土壤水文参数采用作物档案中的经验假定值（卡片上会写明）。
 */

import type { AdviceCard, AdvisoryContext } from "../lib/types";
import { rainFactorOf } from "../lib/regions";
import { clamp, fmt, isValid, makeCard, round, sum, windowOf } from "../lib/util";

/** 各土壤湿度层的厚度权重（cm）。 */
const LAYERS = [
  { key: "soilMoisture0to1", depth: 1 },
  { key: "soilMoisture3to9", depth: 6 },
  { key: "soilMoisture9to27", depth: 18 },
] as const;

/** 灌溉水利用系数：田间实际到达根区的水量占比。 */
const IRRIGATION_EFFICIENCY = 0.8;
/** 单次建议灌溉量上限（mm），避免一次给水过深。 */
const SINGLE_SHOT_LIMIT_MM = 45;

/** 根区土壤体积含水量（m³/m³），无可用数据时返回 NaN。 */
export function rootZoneSoilMoisture(ctx: AdvisoryContext): number {
  const hourly = ctx.weather.hourly;
  const index = ctx.weather.nowIndex;
  let weighted = 0;
  let depth = 0;

  for (const layer of LAYERS) {
    const value = hourly[layer.key][index];
    // 只接受物理上合理的体积含水量，剔除缺测与异常值。
    if (isValid(value) && value > 0.01 && value < 0.7) {
      weighted += value * layer.depth;
      depth += layer.depth;
    }
  }
  return depth > 0 ? weighted / depth : NaN;
}

export function irrigationAdvice(ctx: AdvisoryContext): AdviceCard {
  const { crop, weather } = ctx;
  const hourly = weather.hourly;
  const index = weather.nowIndex;

  const soilMoisture = rootZoneSoilMoisture(ctx);
  const taw = (crop.fieldCapacity - crop.wiltingPoint) * crop.rootDepth * 1000;
  const et0Next24 = sum(windowOf(hourly.et0, index, 24));
  const rainNext24 = sum(windowOf(hourly.precipitation, index, 24));
  const etcNext24 = isValid(et0Next24) ? et0Next24 * crop.kc : NaN;
  // 有效降水系数按地区取：湿润区径流损失大，取值低于半干旱区。
  const rainFactor = rainFactorOf(ctx.region);
  const effectiveRain24 = isValid(rainNext24) ? rainNext24 * rainFactor : NaN;
  const netDemand = Math.max(0, (isValid(etcNext24) ? etcNext24 : 0) - (isValid(effectiveRain24) ? effectiveRain24 : 0));

  const fcPercent = round(crop.fieldCapacity * 100, 0);
  const metrics = [
    { label: "根区土壤湿度", value: isValid(soilMoisture) ? `${round(soilMoisture * 100, 1)} %` : "无数据" },
    { label: "假定田间持水量", value: `${fcPercent} %` },
    { label: "未来 24h 作物蒸散 ETc", value: fmt(etcNext24, 1, "mm") },
    { label: "未来 24h 有效降水", value: fmt(effectiveRain24, 1, "mm") },
  ];

  // 没有土壤湿度数据时退化为纯水量平衡建议，并明确说明精度下降。
  if (!isValid(soilMoisture)) {
    metrics.splice(2, 0, { label: "根区可利用水 TAW", value: fmt(taw, 0, "mm") });
    const level = netDemand >= 8 ? "watch" : "ok";
    return makeCard({
      id: "irrigation",
      category: "灌溉",
      level,
      headline:
        netDemand >= 8
          ? `无土壤湿度实测，按水量平衡估算未来 24 小时缺水约 ${round(netDemand, 0)} mm`
          : `无土壤湿度数据，按蒸散与降水估算未来 24 小时水分基本平衡`,
      reason: `本区域暂无分层土壤湿度数据，改用 ${crop.name} 的 ETc 与有效降水做水量平衡：未来 24 小时 ETc ${fmt(etcNext24, 1, "mm")}、有效降水 ${fmt(effectiveRain24, 1, "mm")}。土壤参数（${crop.assumptions}）仅用于估计可利用水量。`,
      actions:
        netDemand >= 8
          ? ["结合田间观察（表土颜色、植株叶片萎蔫时间）确认墒情后再决定灌溉量", "灌溉后 2–3 天复查墒情，砂性土宜少量多次"]
          : ["暂不灌溉，继续观察田间墒情变化", "关注 3 天后的降水和蒸散变化"],
      metrics,
    });
  }

  const availableWater = Math.max(0, soilMoisture - crop.wiltingPoint) * crop.rootDepth * 1000;
  const refillThreshold = taw * crop.refillTrigger;
  const waterRatio = taw > 0 ? clamp(availableWater / taw, 0, 1.2) : 0;
  const deficitToFieldCapacity = Math.max(0, crop.fieldCapacity - soilMoisture) * crop.rootDepth * 1000;
  const suggestedMm = round(
    clamp(deficitToFieldCapacity / IRRIGATION_EFFICIENCY, 0, Math.min(SINGLE_SHOT_LIMIT_MM, taw * 0.9)),
    0,
  );

  metrics.splice(2, 0,
    { label: "根区可利用水", value: `${fmt(availableWater, 0, "mm")} / ${fmt(taw, 0, "mm")}` },
    { label: "灌溉触发阈值", value: fmt(refillThreshold, 0, "mm") },
  );

  const wet = soilMoisture > crop.fieldCapacity + 0.03;
  const critical = availableWater <= taw * 0.25;
  const needsWater = availableWater < refillThreshold;
  const rainWillHelp = isValid(effectiveRain24) && effectiveRain24 >= Math.max(3, (refillThreshold - availableWater) * 0.7);

  const baseReason = `根区土壤体积含水量 ${round(soilMoisture * 100, 1)} %（假定田间持水量 ${fcPercent}%、凋萎点 ${round(crop.wiltingPoint * 100, 0)}%，${crop.assumptions}）；剩余有效水 ${fmt(availableWater, 0, "mm")}，灌溉触发阈值 ${fmt(refillThreshold, 0, "mm")}。未来 24 小时作物蒸散 ETc ${fmt(etcNext24, 1, "mm")}、有效降水 ${fmt(effectiveRain24, 1, "mm")}。建议灌溉量按灌溉水利用系数 ${IRRIGATION_EFFICIENCY} 折算。`;

  if (wet) {
    return makeCard({
      id: "irrigation",
      category: "灌溉",
      level: "watch",
      headline: "根区偏湿，暂停灌溉并注意排涝",
      reason: baseReason,
      actions: [
        "暂停灌溉，检查田间排水沟是否畅通，低洼地块优先排涝",
        "土壤过湿时避免机械进地作业，防止压实板结",
        "根系长时间泡水易发根腐，天晴后注意查根",
      ],
      metrics,
    });
  }

  if (critical || (needsWater && !rainWillHelp)) {
    return makeCard({
      id: "irrigation",
      category: "灌溉",
      level: critical ? "alert" : "warn",
      headline: `根区水分偏低，建议灌溉约 ${suggestedMm} mm`,
      reason: `${baseReason}剩余有效水仅占可利用水 ${fmt(waterRatio * 100, 0, "%")}，${critical ? "已接近凋萎点，作物将出现明显水分胁迫。" : "低于触发阈值，需及时补水。"}`,
      actions: [
        `建议灌溉量约 ${suggestedMm} mm，分次给水，避免大水漫灌造成深层渗漏`,
        "选择清晨或傍晚灌溉，减少蒸发损失",
        "灌溉后 2–3 天复查根区湿度，砂性土应少量多次",
      ],
      metrics,
    });
  }

  if (needsWater && rainWillHelp) {
    return makeCard({
      id: "irrigation",
      category: "灌溉",
      level: "watch",
      headline: `墒情偏低，但未来 24 小时有雨，建议推迟灌溉`,
      reason: `${baseReason}剩余有效水 ${fmt(availableWater, 0, "mm")} 已低于触发阈值，但预报有效降水 ${fmt(effectiveRain24, 1, "mm")} 可基本覆盖本期需水，建议等雨后再评估。`,
      actions: [
        "暂缓灌溉，等本轮降水过后复查土壤湿度",
        "提前疏通排水沟，强降水后及时排涝防渍",
        `若降水落空（低于 ${round(netDemand, 0)} mm），按约 ${suggestedMm} mm 补灌`,
      ],
      metrics,
    });
  }

  return makeCard({
    id: "irrigation",
    category: "灌溉",
    level: "ok",
    headline: "墒情适宜，暂不需要灌溉",
    reason: `${baseReason}剩余有效水占可利用水 ${fmt(waterRatio * 100, 0, "%")}，高于灌溉触发阈值。`,
    actions: [
      "按当前墒情正常管理，无需灌溉",
      "表土发白、午间叶片短暂萎蔫时再评估灌溉需求",
      "关注 3–5 天后的蒸散与降水变化",
    ],
    metrics,
  });
}
