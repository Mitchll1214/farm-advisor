/**
 * 农忙参谋 — Pages Functions 通用助手。
 *
 * 这里不依赖 @cloudflare/workers-types：Pages 运行时只按导出名识别处理函数
 * （onRequest / onRequestGet …），类型可以由我们自己声明，从而保持零运行时依赖。
 */

/** Pages Functions 的 context 最小子集。 */
export interface PagesContext<E = Record<string, unknown>> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next(input?: Request | string, init?: RequestInit): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
}

/** Cloudflare 在 request.cf 上提供的定位字段（IP 粗定位）。 */
export interface CfGeo {
  latitude?: string | number;
  longitude?: string | number;
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
  timezone?: string;
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** 统一的 JSON 响应。 */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

/** 取运行时默认 Cache（本地预览或异常环境下可能不可用，此时返回 null 并跳过缓存）。 */
export function getDefaultCache(): CacheLike | null {
  const candidate = (globalThis as unknown as { caches?: { default?: unknown } }).caches?.default;
  if (
    candidate &&
    typeof (candidate as CacheLike).match === "function" &&
    typeof (candidate as CacheLike).put === "function"
  ) {
    return candidate as CacheLike;
  }
  return null;
}

/** 读取 request.cf 的定位信息，忽略缺失字段。 */
export function readCfGeo(request: Request): CfGeo {
  const cf = (request as unknown as { cf?: CfGeo }).cf;
  return cf && typeof cf === "object" ? cf : {};
}

/** 解析坐标字符串，越界或非法返回 null。 */
export function parseCoord(value: unknown, min: number, max: number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/** 清洗来自 query 的短文本（限长、去控制字符）。 */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, maxLength);
}
