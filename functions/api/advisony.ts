/**
 * GET /api/advisony —— 农忙参谋的核心接口。
 *
 * 流程：读取 request.cf 的 IP 粗定位（或 query 中手动指定的坐标）
 *   → 查 Cache API（1 小时，按作物 + 坐标格网 + 小时分桶）
 *   → 拉取 Open-Meteo 数据
 *   → 跑 src/decision 的决策模块
 *   → 返回中文建议卡片 JSON，并写回缓存。
 *
 * 缓存体的设计要点：**只缓存与请求者无关的内容**（气象派生的卡片与摘要），
 * 定位结果（城市名、经纬度、来源）在每次请求里按当前请求者重新组装。
 * 否则同一坐标格网内的用户会共享同一个缓存条目，后到的用户会看到别人的
 * IP 定位城市名与坐标 —— 既是可见的错误，也是不必要的定位信息泄漏。
 *
 * 降级策略：
 *   - 定位失败    → ok:false, code=locate_failed, fallback=true（前端引导手动选城市）
 *   - 上游数据源失败 → ok:false, code=upstream_error（前端提示稍后重试）
 *   - 缓存不可用   → 直接跳过缓存，请求照常返回
 */

import { generateAdvisory, buildCurrentConditions } from "../../src/decision/index";
import { resolveCrop } from "../../src/lib/crops";
import type { CacheLike, PagesContext } from "../../src/lib/http";
import { getDefaultCache, jsonResponse, parseCoord, readCfGeo, sanitizeText } from "../../src/lib/http";
import { fetchWeather, WeatherError } from "../../src/lib/openmeteo";
import type {
  AdviceCard,
  AdvisoryErrorCode,
  AdvisoryFailure,
  AdvisorySummary,
  AdvisorySuccess,
  CurrentConditions,
  ResolvedLocation,
} from "../../src/lib/types";
import { round } from "../../src/lib/util";

/** 缓存版本：调整响应结构或决策逻辑时递增，即可让旧缓存立即失效。 */
const CACHE_VERSION = "v2";
const CACHE_TTL_SECONDS = 3600;
/** 仅用于 Cache API 的内部 key，不对外暴露。 */
const CACHE_HOST = "https://advisony.internal";
/** IP 定位的响应只允许浏览器短时缓存；同时显式禁止 CDN 按 URL 缓存。 */
const IP_CLIENT_MAX_AGE = 300;
const WEATHER_SOURCE = "Open-Meteo";

/** 缓存体：不含任何请求者相关信息。 */
interface CachedAdvisony {
  generatedAt: string;
  crop: { id: string; name: string };
  /** 地块时区，由坐标决定，与请求者无关。 */
  timezone: string;
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

  // 1. 定位：query 参数优先（用户手动切换城市），否则用 Cloudflare 的 IP 粗定位。
  const queryLat = parseCoord(params.get("lat"), -90, 90);
  const queryLon = parseCoord(params.get("lon"), -180, 180);
  const manual = queryLat !== null && queryLon !== null;
  const cf = readCfGeo(request);

  const lat = manual ? queryLat : parseCoord(cf.latitude, -90, 90);
  const lon = manual ? queryLon : parseCoord(cf.longitude, -180, 180);

  if (lat === null || lon === null) {
    return failure("locate_failed", "无法根据网络位置判断你所在的地区，请手动选择城市。", true);
  }

  const queryCity = sanitizeText(params.get("city"), 40);
  const queryRegion = sanitizeText(params.get("region"), 40);
  const city = queryCity || sanitizeText(cf.city, 40) || sanitizeText(cf.region, 40) || "当前位置";
  const region = queryRegion || sanitizeText(cf.region, 40);

  const locationBase: LocationBase = {
    name: city,
    region,
    lat: round(lat, 4),
    lon: round(lon, 4),
    source: manual ? "manual" : "ip",
  };

  const crop = resolveCrop(params.get("crop"));
  const force = params.get("force") === "1";

  // 客户端缓存指令：手动坐标在 URL 里，可被 CDN 按 URL 缓存；
  // IP 定位的 URL 对所有用户都一样，必须阻止 CDN 缓存，否则不同地区会串味。
  const clientHeaders: Record<string, string> = manual
    ? { "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` }
    : {
        "cache-control": `private, max-age=${IP_CLIENT_MAX_AGE}`,
        "CDN-Cache-Control": "no-store",
      };

  // 2. 缓存：同一坐标格网（2 位小数）+ 同一作物在同一小时内共用一份决策结果。
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const cacheKey = `${CACHE_HOST}/${CACHE_VERSION}/${crop.id}/${locationBase.source}/${lat.toFixed(2)}/${lon.toFixed(2)}/${hourBucket}`;
  const cache = getDefaultCache();

  if (cache && !force) {
    const cached = await readCached(cache, cacheKey);
    if (cached) {
      return respond(cached, { ...locationBase, timezone: cached.timezone }, "HIT", clientHeaders, crop.id);
    }
  }

  // 3. 取数
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

  // 4. 决策
  const location: ResolvedLocation = { ...locationBase, timezone: weather.timezone };
  const ctx = { location, crop, weather };
  const { summary, cards, notices } = generateAdvisory(ctx);

  const bundle: CachedAdvisony = {
    generatedAt: new Date().toISOString(),
    crop: { id: crop.id, name: crop.name },
    timezone: weather.timezone,
    current: buildCurrentConditions(ctx),
    summary,
    cards,
    notices,
  };
  const body = JSON.stringify(bundle);

  // 5. 写缓存：单独构造一份 public 响应，Cache API 不接受 private 响应。
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

  return respond(bundle, location, "MISS", clientHeaders, crop.id);
}

/** 把缓存体 + 当前请求者的定位信息组装成响应。 */
function respond(
  bundle: CachedAdvisony,
  location: ResolvedLocation,
  cacheState: "HIT" | "MISS",
  clientHeaders: Record<string, string>,
  cropId: string,
): Response {
  const payload: AdvisorySuccess = {
    ok: true,
    generatedAt: bundle.generatedAt,
    location,
    crop: bundle.crop,
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
      "x-advisony-crop": cropId,
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
      !parsed.current
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
