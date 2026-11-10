/**
 * 农忙参谋 — 共享类型定义
 *
 * 这些类型是 /api/advisony 响应体的契约来源，同时被 Pages Functions（functions/）
 * 与决策模块（src/decision/）复用。
 */

/** 建议等级，前端用它决定卡片配色与排序。 */
export type AdviceLevel = "ok" | "watch" | "warn" | "alert";

export const LEVEL_RANK: Record<AdviceLevel, number> = {
  ok: 0,
  watch: 1,
  warn: 2,
  alert: 3,
};

export const LEVEL_LABEL: Record<AdviceLevel, string> = {
  ok: "平稳",
  watch: "关注",
  warn: "预警",
  alert: "警报",
};

/** 卡片上展示的关键指标。 */
export interface Metric {
  label: string;
  value: string;
}

/** 一张中文建议卡片：结论 + 原因 + 操作建议。 */
export interface AdviceCard {
  id: string;
  category: string;
  level: AdviceLevel;
  levelLabel: string;
  /** 结论：一句话给出判断，尽量带上关键数字。 */
  headline: string;
  /** 原因：说明判断依据与所用数据。 */
  reason: string;
  /** 操作建议：可直接执行的农事动作。 */
  actions: string[];
  metrics: Metric[];
}

/** Open-Meteo hourly 变量规范化结果。缺失值一律为 NaN。 */
export interface HourlySeries {
  time: string[];
  temperature: number[];
  humidity: number[];
  dewPoint: number[];
  precipitation: number[];
  precipProbability: number[];
  windSpeed: number[];
  windGust: number[];
  et0: number[];
  soilMoisture0to1: number[];
  soilMoisture3to9: number[];
  soilMoisture9to27: number[];
  soilMoisture27to81: number[];
  soilTemperature6: number[];
  cloudCover: number[];
  /** 叶面湿润概率 %（ECMWF），缺失为 NaN。 */
  leafWetness: number[];
  /** 饱和水汽压差 kPa，缺失为 NaN。 */
  vpd: number[];
}

/** Open-Meteo daily 变量规范化结果。缺失值一律为 NaN。 */
export interface DailySeries {
  time: string[];
  tMax: number[];
  tMin: number[];
  precipitation: number[];
  et0: number[];
  precipProbabilityMax: number[];
  windSpeedMax: number[];
}

/** 一次请求拿到的全部气象/土壤数据。 */
export interface WeatherBundle {
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  utcOffsetSeconds: number;
  /** 站点本地日期，形如 2026-09-20。 */
  localDate: string;
  localHour: number;
  /** hourly 数组中对应“当前小时”的下标。 */
  nowIndex: number;
  hourly: HourlySeries;
  daily: DailySeries;
  fetchedAt: string;
  /** 是否因为变量裁剪而降级到精简变量集。 */
  degradedVariables: boolean;
  /** 变量完整度：full 全部变量；extended 缺新增农业变量；core 仅核心变量。 */
  variableTier: "full" | "extended" | "core";
}

/** 作物分组，用于前端下拉框分组展示。 */
export type CropGroup = "粮食作物" | "油料作物" | "经济作物" | "蔬菜" | "果树" | "饲草" | "其他";

/** FAO-56 三段作物系数。 */
export interface KcStages {
  /** 苗期 Kc。 */
  initial: number;
  /** 旺盛期 Kc。 */
  mid: number;
  /** 成熟期 Kc。 */
  late: number;
  /** 阶段分界（占全生育期 GDD 的比例）：苗期末、发育期末、旺盛期末。 */
  ratios: [number, number, number];
}

/** 物候阶段。 */
export type PhenologyStage = "initial" | "development" | "mid" | "late";

/** 由播种日期与积温推算出的当前物候。 */
export interface Phenology {
  sowingDate: string;
  stage: PhenologyStage;
  stageLabel: string;
  /** 当前作物系数 Kc。 */
  kc: number;
  /** 生育进度 0–1（超过 1 表示已过全生育期）。 */
  progress: number;
  /** 播种以来累计 GDD。 */
  gddSinceSowing: number;
  /** 全生育期参考 GDD。 */
  gddToMaturity: number;
}

/** 病虫害气象风险模型（简化版，仅依赖温湿条件与参考积温）。 */
export interface PestModel {
  id: string;
  name: string;
  kind: "虫害" | "病害";
  /** 发育起点温度 ℃。 */
  baseTemp: number;
  /** 参考积温阈值（自生长季起算，仅作发育进度参考）。 */
  gddReference: number;
  /** 适宜日均气温区间 ℃。 */
  tempMin: number;
  tempMax: number;
  /** 适宜相对湿度下限 %。 */
  humidityMin: number;
  /** 是否需要连续湿润（降水）条件。 */
  needsWet: boolean;
  advice: string;
}

/** 作物参数档案。土壤水文参数为经验假定值，用于在没有田块实测数据时给出量级合理的建议。 */
export interface CropProfile {
  id: string;
  name: string;
  aliases: string[];
  /** 作物分组，用于前端下拉框分组。 */
  group?: CropGroup;
  /** 多年生作物（茶、柑橘、苹果、葡萄等）不按播种期推算物候。 */
  perennial?: boolean;
  /** GDD 基温 ℃（生长度日基点）。 */
  baseTemp: number;
  /** GDD 上限温度 ℃（超出部分不计入积温）。 */
  upperTemp: number;
  /** 作物系数 Kc，用于由 ET₀ 换算作物蒸散量 ETc；有物候时作为回退值。 */
  kc: number;
  /** FAO-56 三段 Kc；缺省时不推算物候，直接使用 kc。 */
  kcStages?: KcStages;
  /** 全生育期参考 GDD（自播种起算）；缺省时不推算物候。 */
  gddToMaturity?: number;
  /** 霜冻风险阈值：预报最低气温低于该值即提示霜冻。 */
  frostTmin: number;
  /** 热应激阈值：预报最高气温高于该值即提示高温胁迫。 */
  heatTmax: number;
  /** 假定田间持水量 m³/m³。 */
  fieldCapacity: number;
  /** 假定凋萎点 m³/m³。 */
  wiltingPoint: number;
  /** 根区有效水补给触发比例：剩余有效水低于 TAW×该值时建议灌溉。 */
  refillTrigger: number;
  /** 有效根区深度 m。 */
  rootDepth: number;
  /** 土壤参数假定说明，会写进灌溉卡片的原因里。 */
  assumptions: string;
  pests: PestModel[];
}

/** 地区季节窗口：该地区某一季主要种植什么、这些作物在田的月份。 */
export interface SeasonWindow {
  label: string;
  /** 作物 id，按当季重要性排序，与 src/lib/crops.ts 的 CROPS 一致。 */
  crops: string[];
  /** 在地月份（1–12）。 */
  months: number[];
  /** 该季主要作物的播种月份（1–12），用于在没有用户输入时估算物候。 */
  sowingMonth?: number;
}

/**
 * 地区参数覆盖：只包含确实随地理变化的量。
 * 作物自身的生理参数（基点温度、Kc、霜冻阈值）不随地区改变，因此不在此覆盖。
 */
export interface RegionOverrides {
  /** 该地区主要土类的田间持水量 m³/m³。 */
  fieldCapacity?: number;
  /** 该地区主要土类的凋萎点 m³/m³。 */
  wiltingPoint?: number;
  /** 有效降水系数：降水真正进入根区的比例，湿润区低于半干旱区。 */
  effectiveRainFactor?: number;
}

/** 省级地区档案，见 src/lib/regions.ts。 */
export interface RegionProfile {
  /** ISO 3166-2 短码，与 Cloudflare request.cf.regionCode 对应，如 SD。 */
  code: string;
  name: string;
  short: string;
  aliases: string[];
  climateZone: string;
  croppingSystem: string;
  seasons: SeasonWindow[];
  overrides: RegionOverrides;
  /** 主要土类说明，会写进灌溉卡片的原因里。 */
  soilNote: string;
  /** 该地区重点监测的病虫害 id（对应 CropProfile.pests[].id）。 */
  pestPriority: string[];
}

/** 响应中的地区信息：本次建议所采用的地区口径。 */
export interface RegionInfo {
  code: string;
  name: string;
  climateZone: string;
  croppingSystem: string;
  soilNote: string;
  effectiveRainFactor: number;
  /** 参考地（市/县级）地名，如"南阳市"；用于让用户核对数据是按哪里计算的。 */
  placeName: string;
  /** 省份是怎么认出来的：IP 省码 / 地名匹配 / 坐标反查。 */
  matchedBy: "region_code" | "region_name" | "reverse_geocode";
}

/** 自动选取作物的依据，前端据此展示"为什么默认给这个作物"。 */
export interface CropSelection {
  /** 是否为自动选取（false 表示用户手动指定）。 */
  auto: boolean;
  reason: string;
  seasonLabel: string | null;
  /** 该地区同季的备选作物，供一键切换。 */
  alternatives: { id: string; name: string }[];
  /** 本次采用的播种日期（YYYY-MM-DD）；无法确定时为 null。 */
  sowingDate: string | null;
  /** 播种日期来源：user 手动输入；region 按地区季节窗口估算。 */
  sowingSource: "user" | "region" | null;
  /** 由播种日期与积温推算的当前物候；无法推算时为 null。 */
  phenology: Phenology | null;
}

/** 定位结果。 */
export interface ResolvedLocation {
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** ip = 网络粗定位；manual = 手动选择城市；device = 浏览器本机定位。 */
  source: "ip" | "manual" | "device";
  timezone: string;
}

/** 决策模块的统一输入。 */
export interface AdvisoryContext {
  location: ResolvedLocation;
  /** 命中的省级地区档案；未识别到省份时为 null（按作物档案的全国经验值计算）。 */
  region: RegionProfile | null;
  crop: CropProfile;
  weather: WeatherBundle;
  /** 由播种日期与积温推算的物候；无播种期或多年生作物时为 null。 */
  phenology?: Phenology | null;
}

export interface AdvisorySummary {
  level: AdviceLevel;
  headline: string;
  /** 最需要关注的那张卡片。 */
  focusId: string;
}

export interface AdvisoryResult {
  summary: AdvisorySummary;
  cards: AdviceCard[];
  notices: string[];
}

/** 页面顶部“当前条件”条的数据。 */
export interface CurrentConditions {
  timeLabel: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  soilMoisture: number | null;
  soilTemperature: number | null;
  precipitation1h: number | null;
  et0Today: number | null;
}

export type AdvisoryErrorCode =
  | "locate_failed"
  | "bad_request"
  | "upstream_error"
  | "internal_error";

export interface AdvisorySuccess {
  ok: true;
  generatedAt: string;
  location: ResolvedLocation;
  crop: { id: string; name: string };
  /** 本次建议采用的地区口径；未识别到省份时为 null。 */
  region: RegionInfo | null;
  /** 作物是自动选取还是用户指定，以及自动选取的依据。 */
  selection: CropSelection | null;
  current: CurrentConditions;
  summary: AdvisorySummary;
  cards: AdviceCard[];
  notices: string[];
  source: { weather: string; cache: "HIT" | "MISS" };
}

export interface AdvisoryFailure {
  ok: false;
  code: AdvisoryErrorCode;
  message: string;
  /** 是否属于可预期降级（前端据此提示手动选择城市等）。 */
  fallback: boolean;
  detail?: string;
}

export type AdvisoryResponse = AdvisorySuccess | AdvisoryFailure;
