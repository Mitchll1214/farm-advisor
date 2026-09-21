/**
 * 农忙参谋 — 坐标 → 省级行政区（反向地理编码）。
 *
 * 为什么需要它：浏览器本机定位只给坐标、不给行政区，而 IP 定位的省份来自
 * **访问者网络出口**（代理、蜂窝网络、企业出口下常与真实位置不同省），
 * 于是会出现"经纬度是对的、地区却错了"（例如设备在河南南阳、IP 出口在上海，
 * 参数却按上海取）。因此凡是"坐标可信、行政区不明"的请求，一律按坐标反查省份。
 *
 * 数据源（均免费、无需 key，依次尝试）：
 *   1) Nominatim（OpenStreetMap 官方）—— 用真实几何做判定，准确性更高；
 *      要求可识别 UA 与 ≤1 req/s，这里用 UA + 24h 缓存满足
 *   2) Photon（Komoot，基于 OpenStreetMap）—— 作为备用：响应更快、限流更宽松，
 *      但它只存要素包围盒，精度弱于 Nominatim
 * 两个源都只取省级字段；同一坐标格网（2 位小数）的结果缓存 24 小时，
 * 既省配额也避免触发对方的限流策略。任一源失败都返回 null，
 * 由调用方降级为"未识别地区 + 提示手动选择城市"，**绝不回退到 IP 省份**。
 */

import type { CacheLike } from "./http";

const CACHE_HOST = "https://advisony.internal";
const CACHE_VERSION = "rev1";
const CACHE_TTL_SECONDS = 86400;
const REQUEST_TIMEOUT_MS = 3500;

/** 可识别的 UA：两个数据源的使用政策都要求标明来源与用途。 */
const USER_AGENT =
  "farm-advisor/0.1 (Cloudflare Pages Function; non-commercial farm advisory tool)";

export interface ReverseRegion {
  /** 省级名称，如"河南省"或 "Henan"；拿不到省级字段时为空串。 */
  region: string;
  /** 更细的地名，用于展示与二次匹配，如"河南省南阳市宛城区"。 */
  detail: string;
  /** 实际命中的数据源。 */
  source: "photon" | "nominatim";
}

/**
 * 按坐标反查省级行政区。失败（超时、限流、字段缺失）时返回 null。
 */
export async function reverseRegion(input: {
  lat: number;
  lon: number;
  cache: CacheLike | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<ReverseRegion | null> {
  const cacheKey = `${CACHE_HOST}/revgeo/${CACHE_VERSION}/${input.lat.toFixed(2)}/${input.lon.toFixed(2)}`;

  if (input.cache) {
    const cached = await readCached(input.cache, cacheKey);
    if (cached) return cached;
  }

  const fresh = await requestReverse(input.lat, input.lon);
  if (!fresh) return null;

  if (input.cache && input.waitUntil) {
    try {
      const copy = new Response(JSON.stringify(fresh), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      input.waitUntil(input.cache.put(new Request(cacheKey), copy).catch(() => undefined));
    } catch {
      // 缓存不可用不影响本次结果。
    }
  }

  return fresh;
}

async function requestReverse(lat: number, lon: number): Promise<ReverseRegion | null> {
  // 先 Nominatim（几何更准），失败再试 Photon（更宽容）。
  const nominatim = await fetchNominatim(lat, lon);
  if (nominatim) return nominatim;
  return fetchPhoton(lat, lon);
}

async function fetchPhoton(lat: number, lon: number): Promise<ReverseRegion | null> {
  const url = `https://photon.komoot.io/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&limit=1`;
  const payload = await getJson(url);
  return payload ? parsePhoton(payload) : null;
}

async function fetchNominatim(lat: number, lon: number): Promise<ReverseRegion | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10` +
    `&accept-language=zh-CN,zh&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const payload = await getJson(url);
  return payload ? parseNominatim(payload) : null;
}

/** 解析 Photon 的 GeoJSON-FeatureCollection 响应。 */
export function parsePhoton(payload: Record<string, unknown>): ReverseRegion | null {
  const features = Array.isArray(payload.features) ? payload.features : [];
  const first = features[0];
  if (!first || typeof first !== "object") return null;
  const props = (first as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;

  const record = props as Record<string, unknown>;
  const state = pickText(record.state);
  const city = pickText(record.city);
  const county = pickText(record.county);
  const district = pickText(record.district) || pickText(record.name);

  // 省级字段缺失时退回上一级可用地名（仍交给 matchRegion 做名称匹配）。
  const region = state || county || city;
  if (!region) return null;

  return {
    region,
    detail: [state, city, county, district].filter(Boolean).join(""),
    source: "photon",
  };
}

/** 解析 Nominatim 的 jsonv2 响应。 */
export function parseNominatim(payload: Record<string, unknown>): ReverseRegion | null {
  const address = payload.address;
  if (!address || typeof address !== "object") return null;
  const record = address as Record<string, unknown>;

  const state = pickText(record.state) || pickText(record.province) || pickText(record.region);
  const city = pickText(record.city) || pickText(record.town);
  const county = pickText(record.county);
  const district = pickText(record.city_district) || pickText(record.suburb) || pickText(record.district);

  const region = state || city || county;
  if (!region) return null;

  return {
    region,
    detail: [state, city, county, district].filter(Boolean).join("") || pickText(payload.display_name),
    source: "nominatim",
  };
}

function pickText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // cf 是 Cloudflare 专有的 fetch 选项，不属于标准 RequestInit。
  const init: RequestInit & { cf?: { cacheTtl: number } } = {
    signal: controller.signal,
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    cf: { cacheTtl: 600 },
  };

  try {
    const response = await fetch(url, init);
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCached(cache: CacheLike, cacheKey: string): Promise<ReverseRegion | null> {
  try {
    const hit = await cache.match(new Request(cacheKey));
    if (!hit) return null;
    const parsed = (await hit.json()) as Partial<ReverseRegion> | null;
    if (!parsed || typeof parsed.region !== "string" || typeof parsed.source !== "string") return null;
    return {
      region: parsed.region,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      source: parsed.source === "nominatim" ? "nominatim" : "photon",
    };
  } catch {
    return null;
  }
}
