/**
 * GET /api/crops —— 作物目录，供前端动态渲染作物下拉框。
 *
 * 为什么单独做成接口：作物档案在 src/lib/crops.ts 一处维护，
 * 前端不再需要把 30 多个 option 硬编码进 index.html，避免新增作物时漏同步。
 * 目录变化很慢，缓存一天即可。
 */

import { CROPS } from "../../src/lib/crops";
import type { PagesContext } from "../../src/lib/http";
import { getDefaultCache } from "../../src/lib/http";

const CACHE_HOST = "https://advisony.internal";
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 86400;

interface CropOption {
  id: string;
  name: string;
  group: string;
  perennial: boolean;
}

interface CropCatalogSuccess {
  ok: true;
  groups: string[];
  crops: CropOption[];
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const cacheKey = `${CACHE_HOST}/crops/${CACHE_VERSION}`;
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
      // 缓存不可用时直接构造响应
    }
  }

  const groups: string[] = [];
  for (const crop of CROPS) {
    const group = crop.group ?? "其他";
    if (!groups.includes(group)) groups.push(group);
  }

  const payload: CropCatalogSuccess = {
    ok: true,
    groups,
    crops: CROPS.map((crop) => ({
      id: crop.id,
      name: crop.name,
      group: crop.group ?? "其他",
      perennial: crop.perennial === true,
    })),
  };
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
        console.warn("[crops] 写入缓存失败:", error instanceof Error ? error.message : String(error));
      });
      context.waitUntil(put);
    } catch (error) {
      console.warn("[crops] 构造缓存副本失败:", error instanceof Error ? error.message : String(error));
    }
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "x-advisony-cache": "MISS",
    },
  });
}
