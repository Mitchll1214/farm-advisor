/**
 * GET /api/advisony —— 农忙参谋的核心接口。
 *
 * 流程：读取 request.cf 的 IP 粗定位（或 query 中手动指定的坐标）
 *   → 识别省级地区档案（regionCode 优先，其次省名）
 *   → 按地区 + 当前月份自动选取当季作物（用户显式传 crop 时以用户为准）
 *   → 用地区土壤参数覆盖作物档案 → 查 Cache API（1 小时）
 *   → 拉取 Open-Meteo 数据 → 跑 src/decision 的决策模块
 *   → 返回中文建议卡片 JSON，并写回缓存。
 *
 * 缓存体的设计要点：**只缓存与请求者无关的内容**（气象派生的卡片与摘要）。
 * 定位结果（城市名、经纬度、来源）在每次请求里按当前请求者重新组装。
 * 否则同一坐标格网内的用户会共享同一个缓存条目，后到的用户会看到别人的
 * IP 定位城市名与坐标 —— 既是可见的错误，也是不必要的定位信息泄漏。
 * 地区与作物选取结果与坐标格网一一对应（key 里已含省码与 auto/fixed 维度），
 * 因此可以随缓存体一起缓存。
 *
 * 降级策略：
 *   - 定位失败    → ok:false, code=locate_failed, fallback=true（前端引导手动选城市）
 *   - 未识别省份   → 不报错：按通用大田作物 + 作物档案全国经验值计算，并在 notices 里说明
 *   - 上游数据源失败 → ok:false, code=upstream_error（前端提示稍后重试）
 *   - 缓存不可用   → 直接跳过缓存，请求照常返回
 */

import { generateAdvisory, buildCurrentConditions } from "../../src/decision/index";
import { resolveCrop } from "../../src/lib/crops";
import { applyRegion, matchRegion, rainFactorOf, recommendCrops } from "../../src/lib/regions";
import { reverseRegion } from "../../src/lib/reverseGeo";
import type { CacheLike, PagesContext } from "../../src/lib/http";
import { getDefaultCache, jsonResponse, parseCoord, readCfGeo, sanitizeText } from "../../src/lib/http";
import { fetchWeather, WeatherError } from "../../src/lib/openmeteo";
import type {
  AdviceCard,
  AdvisoryErrorCode,
  AdvisoryFailure,
  AdvisorySummary,
  AdvisorySuccess,
  CropProfile,
  CropSelection,
  CurrentConditions,
  RegionInfo,
  RegionProfile,
  ResolvedLocation,
} from "../../src/lib/types";
import { round } from "../../src/lib/util";

/** 缓存版本：调整响应结构或决策逻辑时递增，即可让旧缓存立即失效。 */
const CACHE_VERSION = "v3";
const CACHE_TTL_SECONDS = 3600;
/** 仅用于 Cache API 的内部 key，不对外暴露。 */
const CACHE_HOST = "https://advisony.internal";
/** IP 定位的响应只允许浏览器短时缓存；同时显式禁止 CDN 按 URL 缓存。 */
const IP_CLIENT_MAX_AGE = 300;
const WEATHER_SOURCE = "Open-Meteo";
/** 自动选取作物时最多回传几个备选。 */
const MAX_ALTERNATIVES = 3;

/** 缓存体：不含任何请求者相关信息。 */
interface CachedAdvisony {
  generatedAt: string;
  crop: { id: string; name: string };
  /** 地块时区，由坐标决定，与请求者无关。 */
  timezone: string;
  /** 省级地区口径；未识别到省份时为 null。 */
  region: RegionInfo | null;
  /** 作物选取依据（自动或手动）。 */
  selection: CropSelection | null;
  current: CurrentConditions;
  summary: AdvisorySummary;
  cards: AdviceCard[];
  notices: string[];
}

/** 与请求者相关、因此不进缓存的定位部分。 */
type LocationBase = Omit<ResolvedLocation, "timezone">;

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request } = context;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return failure("bad_request", "请求地址不合法。", false);
  }
  const params = url.searchParams;

  // 1. 定位：query 参数优先（手动切换城市或浏览器本机定位），否则用 Cloudflare 的 IP 粗定位。
  const queryLat = parseCoord(params.get("lat"), -90, 90);
  const queryLon = parseCoord(params.get("lon"), -180, 180);
  const manual = queryLat !== null && queryLon !== null;
  /** 浏览器本机定位：坐标来自设备（精度远高于 IP），行政区仍借用网络定位的省份兜底。 */
  const device = manual && sanitizeText(params.get("src"), 12).toLowerCase() === "device";
  const cf = readCfGeo(request);

  const lat = manual ? queryLat : parseCoord(cf.latitude, -90, 90);
  const lon = manual ? queryLon : parseCoord(cf.longitude, -180, 180);

  if (lat === null || lon === null) {
    return failure("locate_failed", "无法根据网络位置判断你所在的地区，请手动选择城市。", true);
  }

  const queryCity = sanitizeText(params.get("city"), 40);
  const queryRegion = sanitizeText(params.get("region"), 40);
  const cfCity = sanitizeText(cf.city, 40);
  const cfRegion = sanitizeText(cf.region, 40);

  // 本机定位时不展示网络定位推断出的城市名，避免"地点显示在 A、坐标却在 B"的误导。
  const city = queryCity || (device ? "本机定位" : cfCity || cfRegion || "当前位置");
  const displayRegion = queryRegion || (device ? "" : cfRegion);

  const locationBase: LocationBase = {
    name: city,
    region: displayRegion,
    lat: round(lat, 4),
    lon: round(lon, 4),
    source: manual ? (device ? "device" : "manual") : "ip",
  };

  // 2. 地区：手动地名 > IP 行政区（仅网络定位时可信）> 坐标反查。
  //    本机定位与手动坐标的省份**不能**取自 IP —— 设备位置与网络出口经常不同省
  //    （代理、蜂窝网络、企业出口），这正是"坐标对、地区错"的根因。
  const cache = getDefaultCache();
  const resolvedRegion = await resolveRegion({
    queryRegion,
    cfRegionCode: cf.regionCode,
    cfRegion,
    manual,
    lat,
    lon,
    cache,
    waitUntil: (promise) => context.waitUntil(promise),
  });
  const regionProfile: RegionProfile | null = resolvedRegion?.profile ?? null;
  const month = localMonth(lon, regionProfile);

  // 3. 作物：默认按地区当季自动选取；显式传 crop 时以用户选择为准。
  const requestedCrop = sanitizeText(params.get("crop"), 24).toLowerCase();
  const auto = requestedCrop === "" || requestedCrop === "auto";
  const { crop, selection } = resolveCropForRequest({
    auto,
    requestedCrop,
    regionProfile,
    month,
  });

  const force = params.get("force") === "1";

  // 客户端缓存指令：手动坐标在 URL 里，可被 CDN 按 URL 缓存；
  // IP 定位的 URL 对所有用户都一样，必须阻止 CDN 缓存，否则不同地区会串味。
  const clientHeaders: Record<string, string> = manual
    ? { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` }
    : {
        "cache-control": `private, max-age=${IP_CLIENT_MAX_AGE}`,
        "CDN-Cache-Control": "no-store",
      };

  const regionInfo = buildRegionInfo(regionProfile, resolvedRegion?.matchedBy);

  // 4. 缓存：同一坐标格网（2 位小数）+ 同一作物 + 同一地区 + 同一选取方式在同一小时内共用结果。
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const cropMode = auto ? "auto" : "fixed";
  const regionKey = regionProfile ? regionProfile.code : "none";
  const cacheKey = `${CACHE_HOST}/${CACHE_VERSION}/${crop.id}/${cropMode}/${regionKey}/${locationBase.source}/${lat.toFixed(2)}/${lon.toFixed(2)}/${hourBucket}`;

  if (cache && !force) {
    const cached = await readCached(cache, cacheKey);
    if (cached) {
      return respond(cached, { ...locationBase, timezone: cached.timezone }, "HIT", clientHeaders);
    }
  }

  // 5. 取数
  let weather;
  try {
    weather = await fetchWeather(lat, lon);
  } catch (error) {
    const detail =
      error instanceof WeatherError
        ? `${error.code}: ${error.detail}`
        : error instanceof Error
          ? error.message
          : String(error);
    return failure("upstream_error", "气象数据源暂时不可用，请稍后重试。", false, detail);
  }

  // 6. 决策（ctx.crop 已按地区土壤参数覆盖，ctx.region 供病虫害加权与水文系数使用）
  const location: ResolvedLocation = { ...locationBase, timezone: weather.timezone };
  const ctx = { location, region: regionProfile, crop, weather };
  const { summary, cards, notices } = generateAdvisory(ctx);

  const bundle: CachedAdvisony = {
    generatedAt: new Date().toISOString(),
    crop: { id: crop.id, name: crop.name },
    timezone: weather.timezone,
    region: regionInfo,
    selection,
    current: buildCurrentConditions(ctx),
    summary,
    cards,
    notices,
  };
  const body = JSON.stringify(bundle);

  // 7. 写缓存：单独构造一份 public 响应，Cache API 不接受 private 响应。
  if (cache) {
    try {
      const cacheCopy = new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      const put = cache.put(new Request(cacheKey), cacheCopy).catch((error: unknown) => {
        // 写缓存失败不致命，但要让 wrangler pages deployment tail 能看到。
        console.warn("[advisony] 写入缓存失败:", error instanceof Error ? error.message : String(error));
      });
      context.waitUntil(put);
    } catch (error) {
      console.warn("[advisony] 构造缓存副本失败:", error instanceof Error ? error.message : String(error));
    }
  }

  return respond(bundle, location, "MISS", clientHeaders);
}

/**
 * 解析本次请求要用的作物档案与选取依据。
 * 自动模式下先按地区 + 月份取当季首选作物，再叠加地区土壤参数；
 * 手动模式下只叠加地区土壤参数，不改变用户选的作物。
 */
function resolveCropForRequest(input: {
  auto: boolean;
  requestedCrop: string;
  regionProfile: RegionProfile | null;
  month: number;
}): { crop: CropProfile; selection: CropSelection | null } {
  const { auto, requestedCrop, regionProfile, month } = input;
  const picked = regionProfile ? recommendCrops(regionProfile, month) : null;

  const alternatives = (picked?.alternatives ?? [])
    .slice(0, MAX_ALTERNATIVES)
    .map((id) => ({ id, name: resolveCrop(id).name }));

  if (!auto) {
    const crop = applyRegion(resolveCrop(requestedCrop), regionProfile);
    const selection: CropSelection = {
      auto: false,
      reason: regionProfile
        ? `已手动指定作物；土壤参数仍按${regionProfile.name}修正`
        : "已手动指定作物；未识别到省份，按作物档案的全国经验值计算",
      seasonLabel: picked?.season?.label ?? null,
      alternatives,
    };
    return { crop, selection };
  }

  if (!regionProfile) {
    return {
      crop: resolveCrop(null),
      selection: {
        auto: true,
        reason: "未能识别所在省份，按通用大田作物计算",
        seasonLabel: null,
        alternatives: [],
      },
    };
  }

  const primaryId = picked?.primary ?? null;
  const seasonLabel = picked?.season?.label ?? null;
  const crop = applyRegion(resolveCrop(primaryId), regionProfile);

  return {
    crop,
    selection: {
      auto: true,
      reason: seasonLabel
        ? `按${regionProfile.name}（${regionProfile.croppingSystem}）${month} 月当季「${seasonLabel}」自动选用`
        : `按${regionProfile.name}（${regionProfile.croppingSystem}）常年主要作物自动选用`,
      seasonLabel,
      alternatives: alternatives.filter((item) => item.id !== crop.id),
    },
  };
}

/**
 * 解析省级地区档案。链路：
 *   1) 用户手输/手选的行政区名（最可信）
 *   2) Cloudflare 的 IP 行政区（仅"网络定位"时可信）
 *   3) 按坐标反查（本机定位与手动坐标的主路径）
 *   4) 全部失败 → null（按通用作物计算，前端提示手动选择城市）
 *
 * 刻意**不**在第 3 步失败后回退到 IP 省份：IP 省份与真实坐标可能不同省，
 * 那会把"未识别"变成"识别错"，比不识别更糟（这正是线上报回来的问题）。
 */
async function resolveRegion(input: {
  queryRegion: string;
  cfRegionCode?: string;
  cfRegion: string;
  manual: boolean;
  lat: number;
  lon: number;
  cache: CacheLike | null;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ profile: RegionProfile; matchedBy: RegionInfo["matchedBy"] } | null> {
  if (input.queryRegion) {
    const byName = matchRegion({ region: input.queryRegion });
    if (byName) return { profile: byName.region, matchedBy: byName.matchedBy };
  }

  if (!input.manual) {
    const byIp = matchRegion({ regionCode: input.cfRegionCode, region: input.cfRegion });
    if (byIp) return { profile: byIp.region, matchedBy: byIp.matchedBy };
  }

  const reversed = await reverseRegion({
    lat: input.lat,
    lon: input.lon,
    cache: input.cache,
    waitUntil: input.waitUntil,
  });
  if (reversed) {
    const byReverse =
      matchRegion({ region: reversed.region }) ?? matchRegion({ region: reversed.detail });
    if (byReverse) return { profile: byReverse.region, matchedBy: "reverse_geocode" };
  }

  return null;
}

/** 组装响应里的地区信息；识别失败时为 null。 */
function buildRegionInfo(
  region: RegionProfile | null,
  matchedBy: RegionInfo["matchedBy"] | undefined,
): RegionInfo | null {
  if (!region) return null;
  return {
    code: region.code,
    name: region.name,
    climateZone: region.climateZone,
    croppingSystem: region.croppingSystem,
    soilNote: region.soilNote,
    effectiveRainFactor: rainFactorOf(region),
    matchedBy: matchedBy ?? "region_name",
  };
}

/**
 * 估算访问者所在地的当前月份。
 * 识别到中国省份时固定按东八区（全境同一时区）；否则按经度粗算（每 15° 一小时）。
 */
function localMonth(lon: number, region: RegionProfile | null): number {
  const offsetHours = region ? 8 : Math.round(lon / 15);
  const shifted = new Date(Date.now() + offsetHours * 3_600_000);
  return shifted.getUTCMonth() + 1;
}

/** 把缓存体 + 当前请求者的定位信息组装成响应。 */
function respond(
  bundle: CachedAdvisony,
  location: ResolvedLocation,
  cacheState: "HIT" | "MISS",
  clientHeaders: Record<string, string>,
): Response {
  const payload: AdvisorySuccess = {
    ok: true,
    generatedAt: bundle.generatedAt,
    location,
    crop: bundle.crop,
    region: bundle.region,
    selection: bundle.selection,
    current: bundle.current,
    summary: bundle.summary,
    cards: bundle.cards,
    notices: bundle.notices,
    source: { weather: WEATHER_SOURCE, cache: cacheState },
  };

  return jsonResponse(payload, {
    headers: {
      ...clientHeaders,
      "x-advisony-cache": cacheState,
      "x-advisony-crop": bundle.crop.id,
      "x-advisony-region": bundle.region ? bundle.region.code : "none",
    },
  });
}

/** 读取并校验缓存体；结构不符（例如版本升级遗留）时按未命中处理。 */
async function readCached(cache: CacheLike, cacheKey: string): Promise<CachedAdvisony | null> {
  try {
    const hit = await cache.match(new Request(cacheKey));
    if (!hit) return null;

    const parsed = (await hit.json()) as Partial<CachedAdvisony> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.generatedAt !== "string" ||
      typeof parsed.timezone !== "string" ||
      !parsed.crop ||
      !Array.isArray(parsed.cards) ||
      !Array.isArray(parsed.notices) ||
      !parsed.summary ||
      !parsed.current ||
      !("region" in parsed) ||
      !("selection" in parsed)
    ) {
      return null;
    }
    return parsed as CachedAdvisony;
  } catch {
    return null;
  }
}

function failure(
  code: AdvisoryErrorCode,
  message: string,
  fallback: boolean,
  detail?: string,
): Response {
  const payload: AdvisoryFailure = { ok: false, code, message, fallback };
  if (detail) payload.detail = detail;
  return jsonResponse(payload, { headers: { "cache-control": "no-store" } });
}
