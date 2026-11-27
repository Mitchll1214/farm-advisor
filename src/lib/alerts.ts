/**
 * 农忙参谋 — 官方气象灾害预警信号（中央气象台公开接口）。
 *
 * 为什么需要它：本站原有的「病虫害风险」等卡片是**由气象条件反推的可能性**，
 * 等级上限刻意压到「预警」。而省/市/县气象台发布的预警信号是**官方已经作出的
 * 判断**，带有明确的等级（蓝/黄/橙/红）与发布单位，用户可以直接据此决定盖膜、
 * 灌水、抢收或暂停打药。两者口径不同，不能混在同一张卡片里，因此单独成区。
 *
 * 数据源：`https://www.nmc.cn/rest/findAlarm`（中央气象台「预警信号」列表接口，
 * 公开、免密钥）。实测要点：
 *   - `pageSize` 上限 200，返回体带 `page.count`（全国在效总数）与 `totalPage`；
 *   - 该接口**不支持**按省份/等级过滤（带 `province`、`signallevel` 会返回 417），
 *     只能拉全量再本地筛选 —— 全国约 900 条、5 页，并发抓取实测 < 0.5 s；
 *   - 每条只有 `alertid` / `issuetime` / `title` / `url` / `pic`，
 *     等级与类型需从标题解析；`alertid` 前 6 位是发布单位的行政区划代码
 *     （如 411727 = 河南省驻马店市汝南县），前 2 位即省级码。
 *
 * 分级口径（scope，严重程度与展示优先级一致）：
 *   local    —— 发布台站地名命中本次「数据参考地」（县/市/区）；
 *   province —— 省气象台发布，覆盖全省，对本地同样生效；
 *   region   —— 同省其它市县的信号，仅作参考，排在最后。
 *
 * 缓存：按「省级码 + 10 分钟」存 Cache API。缓存体只含省维度结果（与请求者无关），
 * scope 依赖请求者的参考地名，每次请求现算。
 *
 * 降级：上游失败时返回 `error` 非空的空集合。前端必须据此显示「没查到」而不是
 * 「当前无预警」—— 把故障说成安全，是这类功能最危险的错误。
 */

import type { CacheLike } from "./http";
import type { AlertBundle, AlertScope, AlertSeverity, OfficialAlert, RegionProfile } from "./types";

const ENDPOINT = "https://www.nmc.cn/rest/findAlarm";
const CACHE_HOST = "https://advisony.internal";
const CACHE_VERSION = "alerts1";
const CACHE_TTL_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 6000;
const DETAIL_BASE = "https://www.nmc.cn/publish/alarm/";

/** 接口单页上限（实测传 200 正常，再大会被静默截断）。 */
const PAGE_SIZE = 200;
/** 页数上限：预警按发布时间倒序，取 6 页已远超 24 小时有效期。 */
const MAX_PAGES = 6;
/** 一次最多展示几条，避免同省几十条蓝色大风把页面淹没。 */
const MAX_ALERTS = 8;
/** 其中「同省参考」最多占几条，保证本地/全省信号始终有位置。 */
const MAX_REGION_ALERTS = 3;
/** 预警有效期按 24 小时计；更早的信号视为失效，不再展示。 */
const ALERT_VALIDITY_MS = 24 * 3_600_000;
/** 允许的上游时钟偏差：超过 1 小时的「未来时间」视为脏数据。 */
const CLOCK_SKEW_MS = 3_600_000;

const SOURCE_LABEL = "中央气象台预警信号（www.nmc.cn）";

/** 省级短码 → 行政区划前 2 位。与 src/lib/regions.ts 的 RegionProfile.code 一一对应。 */
const ADCODE_PREFIX: Record<string, string> = {
  BJ: "11",
  TJ: "12",
  HE: "13",
  SX: "14",
  NM: "15",
  LN: "21",
  JL: "22",
  HL: "23",
  SH: "31",
  JS: "32",
  ZJ: "33",
  AH: "34",
  FJ: "35",
  JX: "36",
  SD: "37",
  HA: "41",
  HB: "42",
  HN: "43",
  GD: "44",
  GX: "45",
  HI: "46",
  CQ: "50",
  SC: "51",
  GZ: "52",
  YN: "53",
  XZ: "54",
  SN: "61",
  GS: "62",
  QH: "63",
  NX: "64",
  XJ: "65",
  TW: "71",
  HK: "81",
  MO: "82",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  blue: "蓝色",
  yellow: "黄色",
  orange: "橙色",
  red: "红色",
};
const SEVERITY_OF_LABEL: Record<string, AlertSeverity> = {
  蓝色: "blue",
  黄色: "yellow",
  橙色: "orange",
  红色: "red",
};
/** 展示排序：红 → 蓝。 */
const SEVERITY_RANK: Record<AlertSeverity, number> = { red: 0, orange: 1, yellow: 2, blue: 3 };
/** 展示排序：本地 → 省级 → 同省其它。 */
const SCOPE_RANK: Record<AlertScope, number> = { local: 0, province: 1, region: 2 };

/**
 * 信号类型 → 农事关联。按顺序匹配解析出的类型关键字；
 * cardId 指向本站建议卡片的 id，便于用户从官方信号跳到对应操作建议。
 * 与露天农事关系弱的（森林火险、道路结冰）也如实保留并说明，不擅自隐藏。
 */
const RELEVANCE: { keys: string[]; cardId: string | null; text: string }[] = [
  // 更具体的类型必须排在「大风」这类泛化关键字之前：
  // 判定用 includes，"海上大风" 同样包含 "大风"，顺序错了就会归错类。
  { keys: ["道路结冰", "道路冰雪", "海上大风", "海区大风"], cardId: null, text: "进田与运销道路湿滑或通行受限，注意运输安全。" },
  { keys: ["森林火险", "草原火险"], cardId: null, text: "火险等级高，田间与果园禁止用火。" },
  { keys: ["霜冻", "寒潮"], cardId: "frost", text: "低温可能伤苗或影响开花，按霜冻建议覆盖、熏烟或提前灌水保温。" },
  { keys: ["高温"], cardId: "frost", text: "高温热害风险，按热应激建议灌水降温、避开正午作业。" },
  { keys: ["干旱"], cardId: "drought", text: "旱情已由官方确认，优先安排灌溉，并核对干旱趋势卡片。" },
  { keys: ["暴雨", "暴雪", "台风"], cardId: "waterBalance", text: "强降水易致渍涝，提前清沟排水、暂停施肥并加固设施。" },
  { keys: ["大风", "雷电", "冰雹", "大雾", "霾", "沙尘暴"], cardId: "spray", text: "不利于喷药作业与授粉，参照喷洒窗口卡片择时。" },
];

/** 行政区划后缀：把「汝南县」与「河南省驻马店市汝南县」对齐到同一个地名核心。 */
const AREA_SUFFIX = /(特别行政区|自治区|自治州|自治县|自治旗|地区|省|市|县|区|盟|旗)$/;
/** 台站后缀，解析发布单位时先剥离。 */
const STATION_SUFFIX = /(气象台|气象站|气象中心|气象局)$/;

/** 缓存体：只含省维度结果，与请求者无关。 */
interface CachedAlerts {
  fetchedAt: string;
  /** 全国在效信号总数，用于说明这是一次全量筛选。 */
  nationalCount: number;
  /** 该省在效信号（已解析、已按有效期过滤）。 */
  items: OfficialAlert[];
}

/** 接口返回的单条原始记录。 */
interface RawAlert {
  alertid?: unknown;
  issuetime?: unknown;
  title?: unknown;
}

/** 抓取结果：成功带数据，失败带原因，不用异常打断主链路。 */
type FetchOutcome = { ok: true; data: CachedAlerts } | { ok: false; error: string };

/**
 * 抓取并筛选指定省份的官方预警信号。
 *
 * region 为 null 时返回 null（不知道该查哪个省，交给前端提示）；
 * 上游失败时返回 `error` 非空的空集合 —— 预警不是主链路的必要条件，
 * 不能因为它让整页建议失败。
 */
export async function fetchAlerts(input: {
  region: RegionProfile | null;
  /** 「数据参考地」地名（市/县级），用于区分本地信号与同省其它信号。 */
  placeName: string;
  cache: CacheLike | null;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: number;
}): Promise<AlertBundle | null> {
  const { region } = input;
  if (!region) return null;

  const prefix = ADCODE_PREFIX[region.code];
  if (!prefix) return null;

  const now = input.now ?? Date.now();
  const bucket = Math.floor(now / (CACHE_TTL_SECONDS * 1000));
  const cacheKey = `${CACHE_HOST}/${CACHE_VERSION}/${prefix}/${bucket}`;

  let cached = input.cache ? await readCached(input.cache, cacheKey) : null;

  if (!cached) {
    const outcome = await fetchProvince(prefix, now);
    if (!outcome.ok) {
      return {
        source: SOURCE_LABEL,
        items: [],
        provinceCount: 0,
        localCount: 0,
        nationalCount: 0,
        fetchedAt: new Date(now).toISOString(),
        error: outcome.error,
      };
    }
    cached = outcome.data;
    writeCached(input.cache, cacheKey, cached, input.waitUntil);
  }

  return buildBundle(cached, region, input.placeName);
}

/** 把省维度结果按本次请求的参考地名分级、排序并截断。 */
function buildBundle(cached: CachedAlerts, region: RegionProfile, placeName: string): AlertBundle {
  const placeCore = normalizeArea(placeName);
  const provinceCore = normalizeArea(region.name);
  const provinceShort = normalizeArea(region.short);

  const scored = cached.items
    .map((alert) => ({ ...alert, scope: scopeOf(alert, placeCore, provinceCore, provinceShort) }))
    .sort(compareAlerts);

  // 限额分配：本地/全省信号优先占位，同省参考单独限流。
  // 否则当地没有信号时，同省几十条蓝色大风会把整块填满，用户容易读成"本地有预警"。
  const items: OfficialAlert[] = [];
  let regionUsed = 0;
  for (const alert of scored) {
    if (items.length >= MAX_ALERTS) break;
    if (alert.scope === "region") {
      if (regionUsed >= MAX_REGION_ALERTS) continue;
      regionUsed += 1;
    }
    items.push(alert);
  }

  // 覆盖到本地的信号 = 本地市县 + 省级台；同省其它市县只作参考。
  const localCount = scored.filter((alert) => alert.scope !== "region").length;

  return {
    source: SOURCE_LABEL,
    items,
    provinceCount: cached.items.length,
    localCount,
    nationalCount: cached.nationalCount,
    fetchedAt: cached.fetchedAt,
    error: null,
  };
}

/**
 * 判定一条信号与本次地块的关系。
 * 省级台（发布单位只到省）→ province；发布台地名命中参考地 → local；其余 → region。
 */
function scopeOf(
  alert: OfficialAlert,
  placeCore: string,
  provinceCore: string,
  provinceShort: string,
): AlertScope {
  const issuerCore = normalizeArea(alert.issuer);
  if (!issuerCore) return "region";

  // 省级台：去掉「气象台」后只剩省名本身。
  if (issuerCore === provinceCore || issuerCore === provinceShort) return "province";

  // 参考地只精确到省（或缺失）时，无法再细分，省级信号之外一律视为同省参考。
  if (!placeCore || placeCore === provinceCore || placeCore === provinceShort) return "region";

  // 发布台地名包含参考地核心即认为覆盖本地（「河南省南阳市」包含「南阳」）。
  if (placeCore.length >= 2 && issuerCore.includes(placeCore)) return "local";
  return "region";
}

/** 排序：本地 > 省级 > 同省；同级按等级红→蓝；再按发布时间新→旧。 */
function compareAlerts(a: OfficialAlert, b: OfficialAlert): number {
  const byScope = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
  if (byScope !== 0) return byScope;

  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;

  return b.issuedAt.localeCompare(a.issuedAt);
}

/** 信号类型 → 农事关联说明与对应卡片 id。 */
function relevanceOf(kind: string): { relevance: string | null; cardId: string | null } {
  for (const rule of RELEVANCE) {
    if (rule.keys.some((key) => kind.includes(key))) {
      return { relevance: rule.text, cardId: rule.cardId };
    }
  }
  return { relevance: null, cardId: null };
}

/** 去掉台站后缀与行政区划后缀，得到可比较的地名核心。 */
function normalizeArea(name: string): string {
  return stripSuffix(name.replace(STATION_SUFFIX, "").replace(/发布$/, "").trim());
}

function stripSuffix(name: string): string {
  return name.replace(AREA_SUFFIX, "");
}

/* ---------- 抓取 ---------- */

async function fetchProvince(prefix: string, now: number): Promise<FetchOutcome> {
  const first = await fetchPage(1);
  if (!first) return { ok: false, error: "中央气象台预警接口暂时不可用" };

  const pages = Math.min(first.totalPage, MAX_PAGES);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) => fetchPage(index + 2)),
  );

  const raw: RawAlert[] = [...first.list];
  for (const page of rest) {
    // 单页失败不影响其它页：预警是尽力而为的数据，宁可少几条也不要整块缺失。
    if (page) raw.push(...page.list);
  }

  // 省码过滤是硬条件（alertid 前 2 位即省），不依赖标题里的地名文字是否完整。
  const items: OfficialAlert[] = [];
  for (const entry of raw) {
    const alert = parseAlert(entry, now);
    if (alert && alert.areaCode.startsWith(prefix)) items.push(alert);
  }

  return {
    ok: true,
    data: { fetchedAt: new Date(now).toISOString(), nationalCount: first.count, items },
  };
}

interface PageResult {
  list: RawAlert[];
  count: number;
  totalPage: number;
}

async function fetchPage(pageNo: number): Promise<PageResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const init: RequestInit & { cf?: { cacheTtl: number } } = {
    signal: controller.signal,
    headers: {
      accept: "application/json",
      "user-agent": "farm-advisor/0.1 (Cloudflare Pages Function; non-commercial farm advisory)",
    },
    cf: { cacheTtl: CACHE_TTL_SECONDS },
  };

  try {
    const response = await fetch(`${ENDPOINT}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}`, init);
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      code?: unknown;
      data?: { page?: { list?: unknown; count?: unknown; totalPage?: unknown } };
    };
    if (payload.code !== 0 || !payload.data || !payload.data.page) return null;

    const page = payload.data.page;
    const list = Array.isArray(page.list) ? (page.list as RawAlert[]) : [];
    return {
      list,
      count: typeof page.count === "number" ? page.count : list.length,
      totalPage: typeof page.totalPage === "number" ? page.totalPage : 1,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 解析 ---------- */

/**
 * 解析一条原始记录。任何字段不合规（alertid 格式异常、缺标题、时间无法解析、
 * 超出有效期）都直接丢弃。alertid 用来拼详情链接，格式不受控就等于开放重定向，
 * 因此这里用白名单正则严格校验。
 */
export function parseAlert(entry: RawAlert, now: number): OfficialAlert | null {
  const id = typeof entry.alertid === "string" ? entry.alertid.trim() : "";
  // 格式：{14 位区划+站点码}_{14 位时间戳}，如 41172741600000_20261127150443。
  if (!/^\d{6,16}_\d{14}$/.test(id)) return null;

  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (!title) return null;

  const issuedRaw = typeof entry.issuetime === "string" ? entry.issuetime.trim() : "";
  const issuedMs = parseIssueTime(issuedRaw);
  if (!Number.isFinite(issuedMs)) return null;
  // 超过 24 小时的信号视为已失效（预警续期会重新发布，不会因此漏掉在效的）。
  if (now - issuedMs > ALERT_VALIDITY_MS) return null;
  // 未来时间（上游时钟偏差或误读）丢弃，避免出现「未来发布的预警」。
  if (issuedMs - now > CLOCK_SKEW_MS) return null;

  const parsed = parseTitle(title);
  if (!parsed) return null;

  return {
    id,
    title,
    kind: parsed.kind,
    severity: parsed.severity,
    severityLabel: SEVERITY_LABEL[parsed.severity],
    areaCode: id.slice(0, 6),
    issuer: parsed.issuer,
    issuedAt: issuedRaw,
    scope: "region",
    ...relevanceOf(parsed.kind),
    url: `${DETAIL_BASE}${id}.html`,
  };
}

/**
 * 从标题解析发布单位、类型与等级。
 * 标准格式为「{地名}气象台发布{类型}{颜色}预警信号」，也有「{地名}发布…」的简写。
 */
export function parseTitle(
  title: string,
): { issuer: string; kind: string; severity: AlertSeverity } | null {
  const match = title.match(/^(.+?)(?:气象台|气象站|气象中心)?发布(.+?)(蓝色|黄色|橙色|红色)预警/);
  if (!match) return null;

  const issuer = match[1].trim();
  const kind = match[2].trim().replace(/信号$/, "");
  const severity = SEVERITY_OF_LABEL[match[3]];
  if (!issuer || !kind || !severity) return null;

  return { issuer, kind, severity };
}

/** "2026/11/27 15:03"（北京时间）→ 毫秒时间戳。 */
export function parseIssueTime(raw: string): number {
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute] = match;
  // issuetime 是北京时间（UTC+8），显式换算，避免运行时区差异导致有效期误判。
  return (
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) -
    8 * 3_600_000
  );
}

/* ---------- 缓存 ---------- */

function writeCached(
  cache: CacheLike | null,
  cacheKey: string,
  data: CachedAlerts,
  waitUntil: (promise: Promise<unknown>) => void,
): void {
  if (!cache) return;
  try {
    const copy = new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    waitUntil(
      cache.put(new Request(cacheKey), copy).catch((error: unknown) => {
        console.warn("[alerts] 写入缓存失败:", error instanceof Error ? error.message : String(error));
      }),
    );
  } catch (error) {
    console.warn("[alerts] 构造缓存副本失败:", error instanceof Error ? error.message : String(error));
  }
}

async function readCached(cache: CacheLike, cacheKey: string): Promise<CachedAlerts | null> {
  try {
    const hit = await cache.match(new Request(cacheKey));
    if (!hit) return null;
    const parsed = (await hit.json()) as Partial<CachedAlerts> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.fetchedAt !== "string" ||
      typeof parsed.nationalCount !== "number" ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }
    return parsed as CachedAlerts;
  } catch {
    return null;
  }
}