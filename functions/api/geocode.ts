/**
 * GET /api/geocode?q=城市名 —— 手动切换城市时的城市检索（Open-Meteo Geocoding API 代理）。
 *
 * 为什么走服务端代理：避免浏览器直连的 CORS 与配额不可控问题，
 * 同时可以用 Cache API 把热搜城市结果缓存一天，几乎不消耗上游配额。
 */

import type { PagesContext } from "../../src/lib/http";
import { getDefaultCache, jsonResponse, sanitizeText } from "../../src/lib/http";

const GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const CACHE_HOST = "https://advisony.internal";
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 86400;
const REQUEST_TIMEOUT_MS = 6000;
const MAX_RESULTS = 8;

interface GeoResult {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** /api/geocode 的响应契约，前端 public/app.js 依赖 results[].{name,region,country,latitude,longitude}。 */
interface GeocodeSuccess {
  ok: true;
  query: string;
  results: GeoResult[];
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  let url: URL;
  try {
    url = new URL(context.request.url);
  } catch {
    return jsonResponse(
      { ok: false, message: "请求地址不合法。" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const query = sanitizeText(url.searchParams.get("q"), 40);
  if (!query) {
    return jsonResponse(
      { ok: false, message: "请输入要查询的城市名称。" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const cacheKey = `${CACHE_HOST}/geo/${CACHE_VERSION}/${encodeURIComponent(query.toLowerCase())}`;
  const cache = getDefaultCache();

  if (cache) {
    try {
      const hit = await cache.match(new Request(cacheKey));
      if (hit) {
        const response = new Response(hit.body, hit);
        response.headers.set("x-advisony-cache", "HIT");
        return response;
      }
    } catch {
      // 缓存不可用时直接查询上游
    }
  }

  const params = new URLSearchParams({
    name: query,
    count: String(MAX_RESULTS),
    language: "zh",
    format: "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let results: GeoResult[] = [];
  try {
    const init: RequestInit & { cf?: { cacheTtl: number } } = {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cf: { cacheTtl: 3600 },
    };
    const response = await fetch(`${GEOCODE_ENDPOINT}?${params.toString()}`, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { results?: unknown };
    const raw = Array.isArray(payload.results) ? payload.results : [];
    results = raw
      .map((item) => normalizeResult(item))
      .filter((item): item is GeoResult => item !== null);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      { ok: false, message: "城市检索服务暂时不可用，请稍后重试或直接使用网络定位。", detail },
      { headers: { "cache-control": "no-store" } },
    );
  } finally {
    clearTimeout(timer);
  }

  const payload: GeocodeSuccess = { ok: true, query, results };
  const body = JSON.stringify(payload);

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
        console.warn("[geocode] 写入缓存失败:", error instanceof Error ? error.message : String(error));
      });
      context.waitUntil(put);
    } catch (error) {
      console.warn("[geocode] 构造缓存副本失败:", error instanceof Error ? error.message : String(error));
    }
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

function normalizeResult(item: unknown): GeoResult | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const latitude = typeof record.latitude === "number" ? record.latitude : NaN;
  const longitude = typeof record.longitude === "number" ? record.longitude : NaN;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    name: typeof record.name === "string" ? record.name : "",
    region: typeof record.admin1 === "string" ? record.admin1 : "",
    country: typeof record.country === "string" ? record.country : "",
    latitude,
    longitude,
    timezone: typeof record.timezone === "string" ? record.timezone : "",
  };
}
