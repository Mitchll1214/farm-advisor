/**
 * 农忙参谋 — 省级地区档案（地区化参数表）。
 *
 * 三个用途：
 *   1) 按访问者所在省份 + 当前月份，自动选取"当季大概率在种什么"作为默认作物；
 *   2) 用地区主要土类的土壤水文参数，覆盖 src/lib/crops.ts 里的全国经验假定值；
 *   3) 标出该地区需要重点监测的病虫害，供病虫害卡片加权、排序与降级。
 *
 * 数据口径（重要）：
 *   - 作物结构与熟制按《中国农业统计年鉴》分省主要农作物播种面积、全国种植业区划
 *     与各省栽培技术规程的经验整理值，**是量级排序而非精确统计**；用于给出一个
 *     可被用户随时覆盖的默认值，不代表某地块的真实种植情况。
 *   - seasons[].crops 的顺序即当季优先级：第一位是自动推荐的首选，其余作为备选作物
 *     出现在页面上。多年生作物（茶、柑橘、苹果）排在同季作物之后，不会抢当季首选。
 *   - 土壤参数按各区主要土类的经验范围取值，**未接入 SoilGrids 等土壤数据库**。
 *   - 有效降水系数按降水强度与径流特征分区取值：湿润区低于半干旱区。
 *   - 病虫害优先级只标注"该地区是否需要重点盯防"，不改变各模型的温湿阈值本身。
 *   修改本表时，作物 id 必须与 src/lib/crops.ts 的 CROPS 一致，
 *   病虫害 id 必须与各作物档案里的 PestModel.id 一致。
 */

import type { CropProfile, RegionProfile, SeasonWindow } from "./types";

/** 匹配结果：命中的省份与命中的字段来源。 */
export interface RegionMatch {
  region: RegionProfile;
  matchedBy: "region_code" | "region_name";
}

/** 有效降水系数默认值（沿用作物档案里的全国经验值）。 */
export const DEFAULT_RAIN_FACTOR = 0.8;

export const REGIONS: RegionProfile[] = [
  {
    code: "BJ",
    name: "北京市",
    short: "北京",
    aliases: ["Beijing", "京"],
    climateZone: "华北平原",
    croppingSystem: "一年两熟",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      { label: "夏播季", crops: ["corn", "soybean", "peanut"], months: [6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.3, wiltingPoint: 0.13, effectiveRainFactor: 0.8 },
    soilNote: "华北潮土/褐土，壤质为主",
    pestPriority: ["corn_borer", "wheat_aphid", "tomato_whitefly"],
  },
  {
    code: "TJ",
    name: "天津市",
    short: "天津",
    aliases: ["Tianjin", "津"],
    climateZone: "华北平原",
    croppingSystem: "一年两熟",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      { label: "夏播季", crops: ["corn", "soybean"], months: [6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.3, wiltingPoint: 0.13, effectiveRainFactor: 0.8 },
    soilNote: "滨海潮土，局部盐渍化",
    pestPriority: ["corn_borer", "wheat_aphid"],
  },
  {
    code: "HE",
    name: "河北省",
    short: "河北",
    aliases: ["Hebei", "冀"],
    climateZone: "黄淮海平原",
    croppingSystem: "一年两熟（坝上一年一熟）",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      { label: "夏播季", crops: ["corn", "peanut", "soybean", "sweetpotato"], months: [6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.31, wiltingPoint: 0.14, effectiveRainFactor: 0.85 },
    soilNote: "潮土与褐土，山前平原壤质",
    pestPriority: ["corn_borer", "wheat_aphid", "cotton_bollworm", "peanut_leafspot"],
  },
  {
    code: "SX",
    name: "山西省",
    short: "山西",
    aliases: ["Shanxi", "晋"],
    climateZone: "黄土高原",
    croppingSystem: "一年一熟与两年三熟",
    seasons: [
      { label: "春播季", crops: ["corn", "millet", "sorghum", "potato"], months: [4, 5, 6, 7, 8, 9, 10] },
      { label: "冬小麦季（南部）", crops: ["wheat"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.28, wiltingPoint: 0.12, effectiveRainFactor: 0.9 },
    soilNote: "黄土与褐土，土层深厚、易旱",
    pestPriority: ["corn_borer", "wheat_aphid", "potato_ladybird", "millet_smut"],
  },
  {
    code: "NM",
    name: "内蒙古自治区",
    short: "内蒙古",
    aliases: ["Inner Mongolia", "Nei Mongol", "Neimenggu", "内蒙", "蒙"],
    climateZone: "内蒙古高原",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["corn", "sunflower", "potato", "millet", "rapeseed"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.27, wiltingPoint: 0.12, effectiveRainFactor: 0.9 },
    soilNote: "栗钙土与草甸土，风蚀与旱情突出",
    pestPriority: ["corn_borer", "potato_ladybird", "sunflower_sclerotinia"],
  },
  {
    code: "LN",
    name: "辽宁省",
    short: "辽宁",
    aliases: ["Liaoning", "辽"],
    climateZone: "东北平原南部",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["corn", "peanut", "rice", "soybean"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.32, wiltingPoint: 0.15, effectiveRainFactor: 0.85 },
    soilNote: "棕壤与草甸土，保水较好",
    pestPriority: ["corn_borer", "rice_blast", "soybean_aphid", "peanut_leafspot"],
  },
  {
    code: "JL",
    name: "吉林省",
    short: "吉林",
    aliases: ["Jilin", "吉"],
    climateZone: "东北平原中部",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["corn", "rice", "soybean"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.15, effectiveRainFactor: 0.85 },
    soilNote: "黑土与黑钙土，保水性强",
    pestPriority: ["corn_borer", "rice_blast"],
  },
  {
    code: "HL",
    name: "黑龙江省",
    short: "黑龙江",
    aliases: ["Heilongjiang", "黑"],
    climateZone: "东北平原北部",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["soybean", "corn", "rice"], months: [5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.34, wiltingPoint: 0.16, effectiveRainFactor: 0.85 },
    soilNote: "东北黑土，保水性强、无霜期短",
    pestPriority: ["soybean_aphid", "corn_borer", "rice_blast"],
  },
  {
    code: "SH",
    name: "上海市",
    short: "上海",
    aliases: ["Shanghai", "沪"],
    climateZone: "长江三角洲",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      { label: "水稻季", crops: ["rice"], months: [5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["wheat", "rapeseed"], months: [11, 12, 1, 2, 3, 4] },
    ],
    overrides: { fieldCapacity: 0.36, wiltingPoint: 0.17, effectiveRainFactor: 0.75 },
    soilNote: "水稻土与灰潮土，地下水位高",
    pestPriority: ["rice_planthopper", "rice_blast", "rapeseed_sclerotinia"],
  },
  {
    code: "JS",
    name: "江苏省",
    short: "江苏",
    aliases: ["Jiangsu", "苏"],
    climateZone: "长江中下游",
    croppingSystem: "一年两熟（稻麦两熟）",
    seasons: [
      { label: "水稻季", crops: ["rice"], months: [5, 6, 7, 8, 9, 10] },
      { label: "冬小麦季", crops: ["wheat", "rapeseed"], months: [11, 12, 1, 2, 3, 4] },
    ],
    overrides: { fieldCapacity: 0.35, wiltingPoint: 0.16, effectiveRainFactor: 0.75 },
    soilNote: "水稻土与黄潮土，江淮之间壤质",
    pestPriority: ["wheat_scab", "rice_planthopper", "rice_blast"],
  },
  {
    code: "ZJ",
    name: "浙江省",
    short: "浙江",
    aliases: ["Zhejiang", "浙"],
    climateZone: "长江中下游南部",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      { label: "水稻季", crops: ["rice", "tea", "citrus"], months: [4, 5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["rapeseed", "wheat"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.35, wiltingPoint: 0.16, effectiveRainFactor: 0.75 },
    soilNote: "红壤与水稻土，山区土层偏薄",
    pestPriority: ["rice_blast", "rice_planthopper", "rapeseed_sclerotinia", "tea_leafhopper", "citrus_redmite"],
  },
  {
    code: "AH",
    name: "安徽省",
    short: "安徽",
    aliases: ["Anhui", "皖"],
    climateZone: "长江中下游与黄淮海过渡",
    croppingSystem: "一年两熟（稻麦/稻油）",
    seasons: [
      { label: "水稻季", crops: ["rice", "peanut"], months: [5, 6, 7, 8, 9] },
      { label: "冬小麦季", crops: ["wheat", "rapeseed"], months: [10, 11, 12, 1, 2, 3, 4] },
    ],
    overrides: { fieldCapacity: 0.34, wiltingPoint: 0.16, effectiveRainFactor: 0.78 },
    soilNote: "砂姜黑土与水稻土，淮北易涝",
    pestPriority: ["wheat_scab", "rice_blast", "rice_planthopper", "peanut_leafspot"],
  },
  {
    code: "FJ",
    name: "福建省",
    short: "福建",
    aliases: ["Fujian", "闽"],
    climateZone: "华南丘陵",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      { label: "水稻季", crops: ["rice", "tea", "citrus"], months: [3, 4, 5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["potato", "rapeseed"], months: [11, 12, 1, 2] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "红壤与水稻土，酸性偏粘",
    pestPriority: ["rice_planthopper", "rice_blast", "potato_blight", "tea_leafhopper", "citrus_canker"],
  },
  {
    code: "JX",
    name: "江西省",
    short: "江西",
    aliases: ["Jiangxi", "赣"],
    climateZone: "长江中下游南部",
    croppingSystem: "一年两熟至三熟（双季稻）",
    seasons: [
      { label: "双季稻季", crops: ["rice", "peanut", "tea", "citrus"], months: [4, 5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["rapeseed"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.34, wiltingPoint: 0.16, effectiveRainFactor: 0.75 },
    soilNote: "红壤与水稻土，丘陵梯田多",
    pestPriority: ["rice_blast", "rice_planthopper", "rapeseed_sclerotinia", "citrus_canker", "tea_leafhopper"],
  },
  {
    code: "SD",
    name: "山东省",
    short: "山东",
    aliases: ["Shandong", "鲁"],
    climateZone: "黄淮海平原",
    croppingSystem: "一年两熟",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      { label: "夏播季", crops: ["corn", "peanut", "soybean"], months: [6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.31, wiltingPoint: 0.14, effectiveRainFactor: 0.82 },
    soilNote: "潮土与棕壤，胶东丘陵偏砂",
    pestPriority: ["corn_borer", "wheat_aphid", "apple_moth", "cotton_bollworm", "peanut_leafspot"],
  },
  {
    code: "HA",
    name: "河南省",
    short: "河南",
    aliases: ["Henan", "豫"],
    climateZone: "黄淮海平原",
    croppingSystem: "一年两熟",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      {
        label: "夏播季",
        crops: ["corn", "peanut", "sesame", "sweetpotato", "soybean"],
        months: [6, 7, 8, 9],
      },
    ],
    overrides: { fieldCapacity: 0.31, wiltingPoint: 0.14, effectiveRainFactor: 0.82 },
    soilNote: "潮土与砂姜黑土，豫西丘陵偏旱",
    pestPriority: ["wheat_aphid", "corn_borer", "wheat_scab", "peanut_leafspot", "sesame_wilt"],
  },
  {
    code: "HB",
    name: "湖北省",
    short: "湖北",
    aliases: ["Hubei", "鄂"],
    climateZone: "长江中游",
    croppingSystem: "一年两熟（稻油/稻麦）",
    seasons: [
      { label: "水稻季", crops: ["rice", "peanut", "sesame"], months: [5, 6, 7, 8, 9] },
      { label: "冬作季", crops: ["rapeseed", "wheat"], months: [10, 11, 12, 1, 2, 3, 4] },
    ],
    overrides: { fieldCapacity: 0.34, wiltingPoint: 0.16, effectiveRainFactor: 0.78 },
    soilNote: "水稻土与黄棕壤，江汉平原壤质",
    pestPriority: ["rice_blast", "rapeseed_sclerotinia", "rice_planthopper", "peanut_leafspot", "sesame_wilt"],
  },
  {
    code: "HN",
    name: "湖南省",
    short: "湖南",
    aliases: ["Hunan", "湘"],
    climateZone: "长江中游南部",
    croppingSystem: "一年两熟至三熟（双季稻）",
    seasons: [
      { label: "双季稻季", crops: ["rice", "peanut", "citrus", "tea"], months: [4, 5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["rapeseed"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.34, wiltingPoint: 0.16, effectiveRainFactor: 0.75 },
    soilNote: "红壤与水稻土，丘陵区易渍",
    pestPriority: ["rice_planthopper", "rice_blast", "rapeseed_sclerotinia", "citrus_redmite", "tea_leafhopper"],
  },
  {
    code: "GD",
    name: "广东省",
    short: "广东",
    aliases: ["Guangdong", "粤"],
    climateZone: "华南",
    croppingSystem: "一年三熟",
    seasons: [
      { label: "早稻季", crops: ["rice", "peanut"], months: [3, 4, 5, 6, 7] },
      { label: "晚稻季", crops: ["rice", "citrus"], months: [7, 8, 9, 10, 11] },
      { label: "冬种季", crops: ["potato", "rapeseed"], months: [11, 12, 1, 2] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "砖红壤与水稻土，雨强径流大",
    pestPriority: ["rice_planthopper", "rice_blast", "potato_blight", "citrus_canker", "citrus_redmite"],
  },
  {
    code: "GX",
    name: "广西壮族自治区",
    short: "广西",
    aliases: ["Guangxi", "桂"],
    climateZone: "华南西部",
    croppingSystem: "一年三熟",
    seasons: [
      {
        label: "水稻季",
        crops: ["rice", "sugarcane", "citrus", "peanut"],
        months: [3, 4, 5, 6, 7, 8, 9, 10, 11],
      },
      { label: "冬种季", crops: ["potato", "rapeseed"], months: [11, 12, 1, 2] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.72 },
    soilNote: "红壤与石灰土，喀斯特区土层薄",
    pestPriority: ["sugarcane_borer", "rice_planthopper", "rice_blast", "sugarcane_smut", "citrus_canker"],
  },
  {
    code: "HI",
    name: "海南省",
    short: "海南",
    aliases: ["Hainan", "琼"],
    climateZone: "热带",
    croppingSystem: "一年三熟",
    seasons: [
      { label: "水稻季", crops: ["rice"], months: [3, 4, 5, 6, 7, 8, 9, 10] },
      { label: "冬种季", crops: ["potato"], months: [11, 12, 1, 2] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "砖红壤，台风与强降水频繁",
    pestPriority: ["rice_planthopper", "rice_blast"],
  },
  {
    code: "CQ",
    name: "重庆市",
    short: "重庆",
    aliases: ["Chongqing", "渝"],
    climateZone: "四川盆地东部",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      { label: "水稻季", crops: ["rice", "corn", "citrus"], months: [4, 5, 6, 7, 8, 9] },
      { label: "冬作季", crops: ["rapeseed", "wheat"], months: [10, 11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.15, effectiveRainFactor: 0.75 },
    soilNote: "紫色土与水稻土，丘陵坡耕地多",
    pestPriority: ["rice_blast", "rice_planthopper", "rapeseed_sclerotinia", "citrus_canker", "citrus_redmite"],
  },
  {
    code: "SC",
    name: "四川省",
    short: "四川",
    aliases: ["Sichuan", "川", "蜀"],
    climateZone: "四川盆地",
    croppingSystem: "一年两熟",
    seasons: [
      { label: "水稻季", crops: ["rice", "citrus", "peanut"], months: [4, 5, 6, 7, 8, 9] },
      { label: "冬作季", crops: ["wheat", "rapeseed"], months: [10, 11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.15, effectiveRainFactor: 0.78 },
    soilNote: "紫色土与水稻土，盆地日照少",
    pestPriority: ["rice_blast", "rapeseed_sclerotinia", "citrus_canker", "wheat_aphid", "citrus_redmite"],
  },
  {
    code: "GZ",
    name: "贵州省",
    short: "贵州",
    aliases: ["Guizhou", "黔", "贵"],
    climateZone: "云贵高原东部",
    croppingSystem: "一年两熟",
    seasons: [
      {
        label: "水稻与玉米季",
        crops: ["rice", "corn", "sweetpotato", "tobacco"],
        months: [4, 5, 6, 7, 8, 9, 10],
      },
      { label: "冬作季", crops: ["rapeseed", "potato", "tea"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.32, wiltingPoint: 0.15, effectiveRainFactor: 0.75 },
    soilNote: "黄壤与石灰土，坡地土层薄",
    pestPriority: ["rice_blast", "tobacco_blackshank", "potato_blight", "rapeseed_sclerotinia", "tea_leafhopper"],
  },
  {
    code: "YN",
    name: "云南省",
    short: "云南",
    aliases: ["Yunnan", "滇", "云"],
    climateZone: "云贵高原西部",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      {
        label: "水稻与玉米季",
        crops: ["rice", "corn", "tobacco", "sugarcane", "tea", "sweetpotato"],
        months: [4, 5, 6, 7, 8, 9, 10],
      },
      { label: "冬作季", crops: ["potato", "rapeseed"], months: [11, 12, 1, 2, 3] },
    ],
    overrides: { fieldCapacity: 0.32, wiltingPoint: 0.15, effectiveRainFactor: 0.75 },
    soilNote: "红壤与紫色土，干湿季分明",
    pestPriority: ["tobacco_blackshank", "potato_blight", "rice_blast", "sugarcane_borer", "tea_leafhopper"],
  },
  {
    code: "XZ",
    name: "西藏自治区",
    short: "西藏",
    aliases: ["Tibet", "Xizang", "藏"],
    climateZone: "青藏高原",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["wheat", "rapeseed"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.28, wiltingPoint: 0.12, effectiveRainFactor: 0.85 },
    soilNote: "高山草甸土与潮土，日照强、蒸发大",
    pestPriority: ["wheat_aphid", "rapeseed_aphid"],
  },
  {
    code: "SN",
    name: "陕西省",
    short: "陕西",
    aliases: ["Shaanxi", "陕", "秦"],
    climateZone: "黄土高原与关中平原",
    croppingSystem: "关中一年两熟，陕北一年一熟",
    seasons: [
      { label: "冬小麦季", crops: ["wheat"], months: [10, 11, 12, 1, 2, 3, 4, 5] },
      { label: "夏播季", crops: ["corn", "millet", "sorghum"], months: [6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.29, wiltingPoint: 0.13, effectiveRainFactor: 0.88 },
    soilNote: "黄土与塿土，渭北旱塬易旱",
    pestPriority: ["wheat_aphid", "corn_borer", "apple_moth", "millet_smut"],
  },
  {
    code: "GS",
    name: "甘肃省",
    short: "甘肃",
    aliases: ["Gansu", "甘", "陇"],
    climateZone: "西北干旱区",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["potato", "corn", "sunflower", "millet", "wheat"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.27, wiltingPoint: 0.11, effectiveRainFactor: 0.9 },
    soilNote: "灰钙土与黄绵土，灌溉依赖度高",
    pestPriority: ["potato_ladybird", "sunflower_sclerotinia", "potato_blight", "wheat_aphid"],
  },
  {
    code: "QH",
    name: "青海省",
    short: "青海",
    aliases: ["Qinghai", "青"],
    climateZone: "青藏高原东北部",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["rapeseed", "potato", "wheat"], months: [4, 5, 6, 7, 8, 9] },
    ],
    overrides: { fieldCapacity: 0.28, wiltingPoint: 0.12, effectiveRainFactor: 0.86 },
    soilNote: "栗钙土与高山土，无霜期短",
    pestPriority: ["rapeseed_aphid", "potato_ladybird"],
  },
  {
    code: "NX",
    name: "宁夏回族自治区",
    short: "宁夏",
    aliases: ["Ningxia", "宁"],
    climateZone: "西北干旱区",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["corn", "sunflower", "potato", "millet", "wheat"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.27, wiltingPoint: 0.11, effectiveRainFactor: 0.9 },
    soilNote: "灌淤土与灰钙土，引黄灌区为主",
    pestPriority: ["corn_borer", "sunflower_sclerotinia", "potato_ladybird", "wheat_aphid"],
  },
  {
    code: "XJ",
    name: "新疆维吾尔自治区",
    short: "新疆",
    aliases: ["Xinjiang", "新"],
    climateZone: "西北干旱区",
    croppingSystem: "一年一熟",
    seasons: [
      { label: "春播季", crops: ["cotton", "corn", "sunflower", "wheat"], months: [4, 5, 6, 7, 8, 9, 10] },
    ],
    overrides: { fieldCapacity: 0.26, wiltingPoint: 0.11, effectiveRainFactor: 0.9 },
    soilNote: "灰漠土与灌淤土，光热足、降水极少",
    pestPriority: ["cotton_bollworm", "cotton_aphid", "corn_borer", "sunflower_sclerotinia"],
  },
  {
    code: "TW",
    name: "台湾省",
    short: "台湾",
    aliases: ["Taiwan", "台", "臺"],
    climateZone: "华南与热带",
    croppingSystem: "一年两熟至三熟",
    seasons: [
      { label: "水稻季", crops: ["rice", "tea", "peanut"], months: [3, 4, 5, 6, 7, 8, 9, 10] },
      { label: "冬作季", crops: ["tomato", "potato"], months: [11, 12, 1, 2] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "冲积土与红壤，多雨、台风影响大",
    pestPriority: ["rice_planthopper", "rice_blast", "tea_leafhopper", "tomato_whitefly"],
  },
  {
    code: "HK",
    name: "香港特别行政区",
    short: "香港",
    aliases: ["Hong Kong", "港"],
    climateZone: "华南",
    croppingSystem: "以蔬果小规模生产为主",
    seasons: [
      { label: "蔬菜季", crops: ["tomato"], months: [3, 4, 5, 6, 7, 8, 9, 10, 11] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "坡地红壤，农地零散",
    pestPriority: ["tomato_whitefly", "tomato_mold"],
  },
  {
    code: "MO",
    name: "澳门特别行政区",
    short: "澳门",
    aliases: ["Macau", "Macao", "澳"],
    climateZone: "华南",
    croppingSystem: "以蔬果小规模生产为主",
    seasons: [
      { label: "蔬菜季", crops: ["tomato"], months: [3, 4, 5, 6, 7, 8, 9, 10, 11] },
    ],
    overrides: { fieldCapacity: 0.33, wiltingPoint: 0.16, effectiveRainFactor: 0.7 },
    soilNote: "坡地红壤，农地极少",
    pestPriority: ["tomato_whitefly", "tomato_mold"],
  },
];

/** 归一化地名：去空白与分隔符、统一小写，便于中英文与简写混匹配。 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_·.]+/g, "");
}

/**
 * 由 IP 定位或手动地名匹配省份。
 * 优先用 Cloudflare 的 regionCode（ISO 3166-2 短码，如 SD），
 * 失败再用省名/拼音/简称匹配；不做城市→省份推断（重名风险高）。
 */
export function matchRegion(sources: {
  regionCode?: string | null;
  region?: string | null;
}): RegionMatch | null {
  const code = sources.regionCode ? normalize(sources.regionCode) : "";
  if (code) {
    const byCode = REGIONS.find((region) => normalize(region.code) === code);
    if (byCode) return { region: byCode, matchedBy: "region_code" };
  }

  const name = sources.region ? normalize(sources.region) : "";
  if (name) {
    const exact = REGIONS.find(
      (region) =>
        normalize(region.name) === name ||
        normalize(region.short) === name ||
        region.aliases.some((alias) => normalize(alias) === name),
    );
    if (exact) return { region: exact, matchedBy: "region_name" };

    // "山东省潍坊市"这类带层级的地名，用包含匹配兜底；过短的别名（单字简称）不参与。
    const partial = REGIONS.find(
      (region) =>
        name.includes(normalize(region.name)) ||
        name.includes(normalize(region.short)) ||
        region.aliases.some((alias) => normalize(alias).length >= 3 && name.includes(normalize(alias))),
    );
    if (partial) return { region: partial, matchedBy: "region_name" };
  }

  return null;
}

/** 该地区在指定月份所处的季节窗口；若作物表未覆盖该月则返回 null。 */
export function seasonForMonth(region: RegionProfile, month: number): SeasonWindow | null {
  return region.seasons.find((season) => season.months.includes(month)) ?? null;
}

/** 自动选作物的推荐结果。 */
export interface CropRecommendation {
  season: SeasonWindow | null;
  /** 当季首选作物 id；无法判断当季时取该地区全年排序的首位作物。 */
  primary: string | null;
  /** 备选作物 id（去重，不含 primary）。 */
  alternatives: string[];
}

/**
 * 按地区 + 月份推荐作物：当季窗口内的作物优先，其后是该地区其它季节的作物。
 */
export function recommendCrops(region: RegionProfile, month: number, limit = 4): CropRecommendation {
  const season = seasonForMonth(region, month);
  const ordered: string[] = [];

  if (season) ordered.push(...season.crops);
  for (const other of region.seasons) {
    if (other === season) continue;
    for (const crop of other.crops) {
      if (!ordered.includes(crop)) ordered.push(crop);
    }
  }

  const primary = ordered[0] ?? null;
  return { season, primary, alternatives: ordered.slice(1, Math.max(1, limit)) };
}

/**
 * 用地区土壤水文参数覆盖作物档案里的全国经验假定值。
 * 只覆盖确实随土壤类型变化的量（田间持水量、凋萎点），
 * 作物自身的生理参数（基点温度、Kc、霜冻阈值）保持不变。
 */
export function applyRegion(crop: CropProfile, region: RegionProfile | null): CropProfile {
  if (!region) return crop;

  const fieldCapacity = region.overrides.fieldCapacity;
  const wiltingPoint = region.overrides.wiltingPoint;
  if (fieldCapacity === undefined && wiltingPoint === undefined) return crop;

  const nextFieldCapacity = fieldCapacity ?? crop.fieldCapacity;
  const nextWiltingPoint = wiltingPoint ?? crop.wiltingPoint;
  if (nextFieldCapacity === crop.fieldCapacity && nextWiltingPoint === crop.wiltingPoint) {
    return crop;
  }

  return {
    ...crop,
    fieldCapacity: nextFieldCapacity,
    wiltingPoint: nextWiltingPoint,
    assumptions: `${crop.assumptions}；已按${region.name}主要土类修正（${region.soilNote}）`,
  };
}

/** 有效降水系数：降水真正进入根区的比例，湿润区低于半干旱区。 */
export function rainFactorOf(region: RegionProfile | null): number {
  return region?.overrides.effectiveRainFactor ?? DEFAULT_RAIN_FACTOR;
}
