/* 农忙参谋 — 前端脚本
 * 原生 ES 模块，无构建、无第三方依赖。
 * 所有后端返回的文本都用 textContent 写入 DOM，不使用 innerHTML，避免 XSS。
 */

const STORAGE_KEYS = {
  location: "nmcm.location",
  crop: "nmcm.crop",
  sowing: "nmcm.sowing",
  lastForce: "nmcm.lastForce",
};

const CROP_DEFAULT = "auto";
/** 手动刷新冷却时间，避免用户连续点刷新消耗上游免费额度。 */
const FORCE_COOLDOWN_MS = 60 * 1000;

const LEVEL_LABELS = { ok: "平稳", watch: "关注", warn: "预警", alert: "警报" };

const els = {
  refresh: document.getElementById("refresh-btn"),
  cityBtn: document.getElementById("city-btn"),
  locationName: document.getElementById("location-name"),
  locationMeta: document.getElementById("location-meta"),
  cropSelect: document.getElementById("crop-select"),
  cropNote: document.getElementById("crop-note"),
  cropAlt: document.getElementById("crop-alt"),
  phenoBar: document.getElementById("pheno-bar"),
  sowingDate: document.getElementById("sowing-date"),
  sowingClear: document.getElementById("sowing-clear"),
  summary: document.getElementById("summary-panel"),
  conditions: document.getElementById("conditions-panel"),
  regionFacts: document.getElementById("region-facts"),
  forecastPanel: document.getElementById("forecast-panel"),
  notices: document.getElementById("notices"),
  cards: document.getElementById("cards"),
  state: document.getElementById("state"),
  sheet: document.getElementById("city-sheet"),
  sheetForm: document.getElementById("city-form"),
  sheetInput: document.getElementById("city-input"),
  sheetHint: document.getElementById("city-hint"),
  sheetResults: document.getElementById("city-results"),
  useIp: document.getElementById("use-ip"),
  useDevice: document.getElementById("use-device"),
  sources: document.getElementById("sources"),
  sourcesBody: document.getElementById("sources-body"),
  toast: document.getElementById("toast"),
};

const state = {
  /** 手动选择的城市；为 null 表示使用服务端 IP 粗定位。 */
  location: readStoredLocation(),
  crop: readStoredCrop(),
  /** 用户手动指定的播种日期（YYYY-MM-DD）；为 null 时由服务端按地区估算。 */
  sowing: readStoredSowing(),
  loading: false,
  data: null,
};

/** /api/crops 返回的作物目录与元数据（用于分组与多年生判断）。 */
let cropCatalog = [];
let cropMeta = new Map();

let searchToken = 0;
let toastTimer = 0;

/* ---------- 本地存储（隐私模式下会抛异常，全部吞掉并回退默认值） ---------- */

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略：不影响本次使用 */
  }
}

function readStoredLocation() {
  const value = readJson(STORAGE_KEYS.location);
  if (!value || typeof value !== "object") return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const device = value.source === "device";
  const accuracy = Number(value.accuracy);
  return {
    name: typeof value.name === "string" && value.name ? value.name : device ? "本机定位" : "手动位置",
    region: typeof value.region === "string" ? value.region : "",
    lat,
    lon,
    source: device ? "device" : "manual",
    accuracy: device && Number.isFinite(accuracy) ? accuracy : null,
  };
}

function readStoredCrop() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.crop);
    return value ? value : CROP_DEFAULT;
  } catch {
    return CROP_DEFAULT;
  }
}

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readStoredSowing() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.sowing);
    return isValidDateString(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSowing(value) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEYS.sowing, value);
    else window.localStorage.removeItem(STORAGE_KEYS.sowing);
  } catch {
    /* 忽略：不影响本次使用 */
  }
}

function readStoredNumber(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/* ---------- 主流程 ---------- */

async function load(options = {}) {
  const force = options.force === true;
  if (state.loading) return;
  state.loading = true;
  els.refresh.disabled = true;
  showLoading();

  const params = new URLSearchParams();
  if (state.location) {
    params.set("lat", state.location.lat.toFixed(4));
    params.set("lon", state.location.lon.toFixed(4));
    if (state.location.name) params.set("city", state.location.name);
    if (state.location.region) params.set("region", state.location.region);
    // 本机定位：坐标来自设备，服务端据此区分来源并保留省份兜底。
    if (state.location.source === "device") params.set("src", "device");
  }
  // 自动模式不传 crop：由服务端按所在省份与当前月份选取当季作物；手动选择时显式指定。
  if (state.crop && state.crop !== CROP_DEFAULT) params.set("crop", state.crop);
  // 手动输入过播种日期才传，否则由服务端按地区季节窗口估算。
  if (state.sowing) params.set("sowing", state.sowing);
  if (force) params.set("force", "1");
  const query = params.toString();

  try {
    const response = await fetch(query ? `/api/advisony?${query}` : "/api/advisony", {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (!data || data.ok !== true) {
      renderFailure(data || {});
      return;
    }
    state.data = data;
    render(data);
  } catch {
    renderFailure({
      ok: false,
      code: "network_error",
      message: "无法连接服务器，请检查网络后重试。",
      fallback: false,
    });
  } finally {
    state.loading = false;
    els.refresh.disabled = false;
  }
}

function showLoading() {
  // 已有内容时不清屏，避免刷新闪烁。
  if (state.data) return;
  els.state.hidden = false;
  els.state.className = "state";
  els.state.replaceChildren(
    el("p", "state__title", "正在获取位置与气象数据…"),
    el("p", "state__desc", "首次加载需要调用气象数据源，通常 1–3 秒完成。"),
  );
}

function render(data) {
  els.state.hidden = true;
  renderLocation(data);
  renderCropSelection(data);
  renderPhenologyBar(data);
  renderSummary(data);
  renderConditions(data);
  renderRegionFacts(data);
  renderForecast(data);
  renderNotices(data);
  renderSources(data);
  const focusId = data.summary && typeof data.summary.focusId === "string" ? data.summary.focusId : "";
  els.cards.replaceChildren(
    ...(Array.isArray(data.cards) ? data.cards.map((card) => renderCard(card, focusId)) : []),
  );
}

function renderFailure(data) {
  // 已经有数据时不清屏，只提示失败原因，避免用户丢失眼前的信息。
  if (state.data) {
    showToast(data.message || "刷新失败，请稍后重试");
    return;
  }

  els.summary.hidden = true;
  els.conditions.hidden = true;
  els.regionFacts.hidden = true;
  els.forecastPanel.hidden = true;
  els.phenoBar.hidden = true;
  els.notices.hidden = true;
  if (els.sources) els.sources.hidden = true;
  els.cards.replaceChildren();

  els.state.hidden = false;
  els.state.className = "state state--error";

  const locateFailed = data.code === "locate_failed";
  els.state.replaceChildren(
    el("p", "state__title", locateFailed ? "无法自动判断你的位置" : "暂时拿不到数据"),
    el(
      "p",
      "state__desc",
      data.message || "请稍后重试；如果持续失败，可以手动指定城市。",
    ),
  );

  const button = el("button", "btn", locateFailed ? "手动选择城市" : "重新加载");
  button.type = "button";
  button.addEventListener("click", () => {
    if (locateFailed) openCitySheet();
    else load({ force: true });
  });
  els.state.append(button);
}

/* ---------- 渲染 ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLocation(data) {
  const location = data.location || {};
  els.locationName.textContent = location.name || "当前位置";

  const parts = [];
  const regionInfo = data.region && typeof data.region === "object" ? data.region : null;
  const regionLabel =
    (typeof location.region === "string" && location.region) ||
    (regionInfo && typeof regionInfo.name === "string" ? regionInfo.name : "");
  if (regionLabel && regionLabel !== location.name) {
    // 坐标反查得到的省份标注来源，方便用户判断准不准。
    parts.push(regionInfo && regionInfo.matchedBy === "reverse_geocode" ? `${regionLabel}（按坐标识别）` : regionLabel);
  }

  const sourceLabel =
    location.source === "device" ? "本机定位" : location.source === "manual" ? "手动选择" : "网络定位";
  if (sourceLabel !== location.name) parts.push(sourceLabel);
  if (Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
    parts.push(`${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`);
  }
  const accuracy =
    state.location && state.location.source === "device" ? state.location.accuracy : null;
  if (typeof accuracy === "number" && Number.isFinite(accuracy)) {
    parts.push(`精度约 ${Math.round(accuracy)} 米`);
  }
  if (data.crop && data.crop.name) parts.push(data.crop.name);
  // 海拔与时区都能影响霜冻判断与“本地时间”的含义，摊出来便于用户核对。
  if (typeof data.elevation === "number" && Number.isFinite(data.elevation)) {
    parts.push(`海拔约 ${Math.round(data.elevation)} 米`);
  }
  if (typeof location.timezone === "string" && location.timezone) {
    parts.push(location.timezone);
  }
  els.locationMeta.textContent = parts.join(" · ");
}

/* ---------- 作物选取依据（地区自动选取 or 手动指定） ---------- */

function renderCropSelection(data) {
  const selection = data.selection && typeof data.selection === "object" ? data.selection : null;

  const notes = [];
  if (selection && selection.reason) notes.push(selection.reason);
  if (selection && selection.auto === false) notes.push("下拉框可切回「自动（按地区当季）」");
  if (selection && selection.auto === true && !data.region) {
    notes.push("未能识别省份：在「切换城市」里选择所在城市后，作物与地区参数会自动跟上");
  }
  if (selection && selection.sowingDate) {
    const source = selection.sowingSource === "user" ? "手动输入" : "按地区估算";
    notes.push(`播种期 ${selection.sowingDate}（${source}）`);
  }
  if (selection && selection.phenology) {
    const stage = selection.phenology;
    notes.push(
      `当前物候 ${stage.stageLabel}，Kc ${stage.kc}（生育进度 ${Math.round(stage.progress * 100)}%）`,
    );
  }

  if (notes.length > 0) {
    els.cropNote.textContent = notes.join(" · ");
    els.cropNote.hidden = false;
  } else {
    els.cropNote.hidden = true;
  }

  syncSowingInput(selection);

  const alternatives = selection && Array.isArray(selection.alternatives) ? selection.alternatives : [];
  const usable = alternatives.filter((item) => item && typeof item.id === "string");
  if (usable.length === 0) {
    els.cropAlt.hidden = true;
    els.cropAlt.replaceChildren();
    return;
  }

  const buttons = usable.map((item) => {
    const label = typeof item.name === "string" && item.name ? item.name : item.id;
    const button = el("button", "chip", label);
    button.type = "button";
    button.addEventListener("click", () => {
      selectCrop(item.id);
      showToast(`已切换到 ${label}`);
    });
    return button;
  });

  els.cropAlt.replaceChildren(el("span", "crop-alt__label", "同季作物"), ...buttons);
  els.cropAlt.hidden = false;
}

/** 手动切换作物：写入本机存储后重新加载，让服务端按新作物重算。 */
function selectCrop(cropId) {
  state.crop = cropId || CROP_DEFAULT;
  // 播种日期是作物相关的；切换作物时清除手动值，回到按地区估算。
  state.sowing = null;
  writeStoredSowing(null);
  try {
    window.localStorage.setItem(STORAGE_KEYS.crop, state.crop);
  } catch {
    /* 忽略：不影响本次使用 */
  }
  els.cropSelect.value = state.crop;
  load();
}

function renderSummary(data) {
  const summary = data.summary || {};
  const level = LEVEL_LABELS[summary.level] ? summary.level : "ok";

  els.summary.hidden = false;
  els.summary.className = `summary summary--${level}`;

  const head = el("div", "summary__head");
  head.append(el("span", undefined, "今日重点"), el("span", "badge", LEVEL_LABELS[level]));

  const text = el("p", "summary__text", summary.headline || "暂无结论");
  const source = data.source && typeof data.source === "object" ? data.source : {};
  // 变量完整度决定建议精度：降级时如实说明，避免用户把降级结果当作常规精度。
  const tierNote =
    source.variableTier === "core"
      ? " · 仅核心变量"
      : source.variableTier === "extended"
        ? " · 部分农业变量缺失"
        : "";
  const meta = el(
    "p",
    "summary__time",
    `更新于 ${formatDateTime(data.generatedAt, data.location && data.location.timezone)} · ` +
      `${source.cache === "HIT" ? "命中 1 小时缓存" : "实时获取"}${tierNote}`,
  );

  els.summary.replaceChildren(head, text, meta);
}

/** 数值格式化：缺测统一显示“—”，避免页面上出现 NaN。 */
function formatNumber(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** "2026-11-27" → "11月27日"。 */
function formatDay(iso) {
  if (typeof iso !== "string" || iso.length < 10) return "—";
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
}

/** "2026-11-27T06:00" → "11月27日 06:00"。 */
function formatHour(iso) {
  if (typeof iso !== "string" || iso.length < 13) return "—";
  return `${formatDay(iso)} ${iso.slice(11, 13)}:00`;
}

/** 生育进度条：只在能推算物候时出现，把 progress 变成可见的进度。 */
function renderPhenologyBar(data) {
  const selection = data.selection && typeof data.selection === "object" ? data.selection : null;
  const phenology = selection && selection.phenology ? selection.phenology : null;
  const progress = phenology ? Number(phenology.progress) : NaN;
  if (!phenology || !Number.isFinite(progress) || progress <= 0) {
    els.phenoBar.hidden = true;
    els.phenoBar.replaceChildren();
    return;
  }

  const ratio = Math.max(0, Math.min(1, progress));
  const percent = Math.round(ratio * 100);

  const head = el("div", "pheno__head");
  head.append(
    el("span", "pheno__label", "生育进度"),
    el("span", "pheno__stage", `${phenology.stageLabel || "—"} · Kc ${formatNumber(phenology.kc, 2)}`),
    el("span", "pheno__percent", `${percent}%`),
  );

  const track = el("div", "pheno__track");
  const fill = el("div", "pheno__fill");
  fill.style.width = `${percent}%`;
  track.append(fill);

  const foot = el("div", "pheno__foot");
  foot.append(
    el("span", undefined, `播种以来 ${formatNumber(phenology.gddSinceSowing, 0)} GDD`),
    el("span", undefined, `全生育期参考 ${formatNumber(phenology.gddToMaturity, 0)} GDD`),
    el("span", undefined, `播种 ${phenology.sowingDate || "—"}`),
  );

  els.phenoBar.replaceChildren(head, track, foot);
  els.phenoBar.hidden = false;
}

/** 省份是怎么认出来的，便于用户判断地区参数是否可信。 */
const MATCHED_BY_LABELS = {
  region_code: "网络定位省码",
  region_name: "地名匹配",
  reverse_geocode: "按坐标反查",
};

/** 地区参数口径：把建议里用到的地区假定值摊开，不只藏在提示条里。 */
function renderRegionFacts(data) {
  const region = data.region && typeof data.region === "object" ? data.region : null;
  if (!region) {
    els.regionFacts.hidden = true;
    els.regionFacts.replaceChildren();
    return;
  }

  const items = [
    ["数据参考地", region.placeName || region.name],
    ["气候区", region.climateZone],
    ["种植制度", region.croppingSystem],
    ["主要土类", region.soilNote],
    [
      "有效降水系数",
      typeof region.effectiveRainFactor === "number" && Number.isFinite(region.effectiveRainFactor)
        ? String(region.effectiveRainFactor)
        : null,
    ],
    ["地区识别", MATCHED_BY_LABELS[region.matchedBy] || null],
  ];

  const head = el("div", "region-facts__head");
  head.append(el("h2", "region-facts__title", "地区参数口径"));
  head.append(el("span", "region-facts__badge", region.name || ""));

  const list = el("dl", "region-facts__list");
  for (const [label, value] of items) {
    if (value === null || value === undefined || value === "") continue;
    const row = el("div", "region-facts__row");
    row.append(el("dt", undefined, label), el("dd", undefined, String(value)));
    list.append(row);
  }

  els.regionFacts.replaceChildren(head, list);
  els.regionFacts.hidden = false;
}

/** 未来 7 天逐日预报：天气现象、气温、降水概率、风向风速与水分盈亏。 */
function renderForecast(data) {
  const days = Array.isArray(data.forecast) ? data.forecast : [];
  if (days.length === 0) {
    els.forecastPanel.hidden = true;
    els.forecastPanel.replaceChildren();
    return;
  }

  const head = el("div", "forecast__head");
  head.append(
    el("h2", "forecast__title", `未来 ${days.length} 天（含今天）`),
    el("span", "forecast__hint", "盈亏 = 有效降水 − 作物蒸散 ETc"),
  );

  const grid = el("div", "forecast__days");
  for (const day of days) {
    const cell = el("div", "forecast__day");

    const top = el("div", "forecast__date");
    top.append(el("span", undefined, formatDay(day.date)));
    if (typeof day.weather === "string" && day.weather) {
      top.append(el("span", "forecast__weather", day.weather));
    }

    const temp = el("div", "forecast__temp");
    temp.append(
      el("span", "forecast__tmax", formatValue(day.tMax, "℃", 1)),
      el("span", "forecast__tmin", formatValue(day.tMin, "℃", 1)),
    );

    const rainText =
      day.precipitation === null || day.precipitation === undefined
        ? "—"
        : typeof day.precipProbability === "number" && Number.isFinite(day.precipProbability)
          ? `${formatValue(day.precipitation, "mm", 1)} · ${Math.round(day.precipProbability)}%`
          : formatValue(day.precipitation, "mm", 1);

    const rain = el("div", "forecast__rain");
    rain.append(el("span", "forecast__rain-label", "降水"), el("span", undefined, rainText));

    // 有效降水与 ET₀ 是盈亏公式的两端，逐日摊开才能自己核对那一行的正负。
    const effective = el("div", "forecast__rain");
    effective.append(
      el("span", "forecast__rain-label", "有效降水"),
      el("span", undefined, formatValue(day.effectivePrecipitation, "mm", 1)),
    );
    const et0 = el("div", "forecast__rain");
    et0.append(
      el("span", "forecast__rain-label", "ET₀"),
      el("span", undefined, formatValue(day.et0, "mm", 1)),
    );

    // 风向与风速、阵风一起给：喷洒建议要求核查下风向敏感作物，阵风则是硬性排除条件。
    const wind = el("div", "forecast__wind");
    const windNote =
      typeof day.windDirection === "string" && day.windDirection ? `${day.windDirection} ` : "";
    wind.append(
      el("span", "forecast__wind-label", "最大风"),
      el("span", undefined, `${windNote}${formatValue(day.windSpeedMax, "m/s", 1)}`),
    );
    const gust = el("div", "forecast__wind");
    gust.append(
      el("span", "forecast__wind-label", "阵风"),
      el("span", undefined, formatValue(day.windGustMax, "m/s", 1)),
    );

    // 盈亏是唯一带方向的量，正负决定配色，缺测时保持中性。
    const balanceText =
      typeof day.balance === "number" && Number.isFinite(day.balance)
        ? `${day.balance > 0 ? "+" : ""}${day.balance.toFixed(1)} mm`
        : "—";
    const balance = el("div", "forecast__balance");
    if (typeof day.balance === "number" && Number.isFinite(day.balance)) {
      balance.className = `forecast__balance forecast__balance--${day.balance >= 0 ? "surplus" : "deficit"}`;
    }
    balance.append(el("span", "forecast__balance-label", "盈亏"), el("span", undefined, balanceText));

    cell.append(top, temp, rain, effective, et0, wind, gust, balance);

    // 日出日落与昼长决定可作业时段与霜冻辐射降温窗口，逐日给出便于安排。
    if (day.sunrise || day.sunset) {
      const sun = el("div", "forecast__sun");
      sun.append(
        el("span", "forecast__sun-label", "日出/日落"),
        el("span", undefined, `${day.sunrise || "—"} / ${day.sunset || "—"}`),
      );
      cell.append(sun);
    }
    // 昼长单独一行：日落时刻本身已含昼长信息，但直接给出小时数更方便比较长短。
    if (typeof day.daylightHours === "number" && Number.isFinite(day.daylightHours)) {
      const daylight = el("div", "forecast__sun");
      daylight.append(
        el("span", "forecast__sun-label", "昼长"),
        el("span", undefined, `${day.daylightHours.toFixed(1)} h`),
      );
      cell.append(daylight);
    }

    grid.append(cell);
  }

  els.forecastPanel.replaceChildren(head, grid);
  els.forecastPanel.hidden = false;
}

function renderConditions(data) {
  const current = data.current || {};

  // 气温与露点、风速与风向阵风都是成对读才有意义，合成一项展示，避免格子铺得过散。
  const dewNote =
    typeof current.dewPoint === "number" && Number.isFinite(current.dewPoint)
      ? `露点 ${current.dewPoint.toFixed(1)} ℃`
      : null;
  const windParts = [];
  if (typeof current.windDirection === "string" && current.windDirection) {
    windParts.push(current.windDirection);
  }
  if (typeof current.windGust === "number" && Number.isFinite(current.windGust)) {
    windParts.push(`阵风 ${current.windGust.toFixed(1)} m/s`);
  }
  const sunText =
    current.sunrise && current.sunset
      ? `${current.sunrise} / ${current.sunset}`
      : current.sunrise || current.sunset || "—";

  const items = [
    ["天气现象", typeof current.weather === "string" && current.weather ? current.weather : "—"],
    ["观测时刻", typeof current.timeLabel === "string" && current.timeLabel ? current.timeLabel : "—"],
    ["气温", withNote(formatValue(current.temperature, "℃", 1), dewNote)],
    ["相对湿度", formatValue(current.humidity, "%", 0)],
    ["风速", withNote(formatValue(current.windSpeed, "m/s", 1), windParts.join(" · "))],
    ["降水概率", formatValue(current.precipProbability, "%", 0)],
    ["近 1 小时降水", formatValue(current.precipitation1h, "mm", 1)],
    ["今日 ET₀", formatValue(current.et0Today, "mm", 1)],
    ["云量", formatValue(current.cloudCover, "%", 0)],
    ["饱和水汽压差", formatValue(current.vpd, "kPa", 2)],
    ["地面气压", formatValue(current.pressure, "hPa", 1)],
    ["叶面湿润概率", formatValue(current.leafWetness, "%", 0)],
    ["根区土壤湿度", formatValue(current.soilMoisture, "%", 1)],
    ["土壤温度 6cm", formatValue(current.soilTemperature, "℃", 1)],
    ["日出 / 日落", sunText],
  ];

  const nodes = items.map(([label, value]) => {
    const box = el("div", "condition");
    box.append(el("div", "condition__label", label), el("div", "condition__value", value));
    return box;
  });

  // 墒情剖面：只展示有值的层，整组都缺测时连同标题一起隐藏。
  const profile = renderSoilProfile(current.soilProfile);
  if (profile) nodes.push(profile);

  els.conditions.hidden = false;
  els.conditions.replaceChildren(...nodes);
}

/**
 * 分层墒情剖面：把 0–1 / 3–9 / 9–27 / 27–81 cm 的土壤含水量按层画成横条，
 * 便于看出表层失水而深层仍有墒（或反之）——加权平均值看不出这件事。
 * 条形宽度按体积含水量百分比直接取，相对田间持水量的位置由刻度线标出。
 */
function renderSoilProfile(layers) {
  const usable = Array.isArray(layers)
    ? layers.filter(
        (item) =>
          item && typeof item.label === "string" && typeof item.value === "number" && Number.isFinite(item.value),
      )
    : [];
  if (usable.length === 0) return null;

  const box = el("div", "soil-profile");
  const head = el("div", "soil-profile__head");
  head.append(
    el("span", "soil-profile__title", "墒情剖面"),
    el("span", "soil-profile__hint", "体积含水量（按层）"),
  );

  const rows = usable.map((layer) => {
    const row = el("div", "soil-profile__row");
    const percent = Math.max(0, Math.min(100, layer.value));
    row.append(el("span", "soil-profile__depth", layer.label));
    const track = el("span", "soil-profile__track");
    const fill = el("span", "soil-profile__fill");
    fill.style.width = `${percent}%`;
    track.append(fill);
    row.append(track, el("span", "soil-profile__value", `${layer.value.toFixed(1)} %`));
    return row;
  });

  box.append(head, ...rows);
  return box;
}

/** 主值后附带补充说明；主值缺测时只保留“—”，不附加孤立的说明文字。 */
function withNote(main, note) {
  if (main === "—" || !note) return main;
  return `${main}（${note}）`;
}

function renderNotices(data) {
  const notices = Array.isArray(data.notices) ? data.notices : [];
  if (notices.length === 0) {
    els.notices.hidden = true;
    return;
  }
  const list = document.createElement("ul");
  for (const notice of notices) list.append(el("li", undefined, notice));
  els.notices.hidden = false;
  els.notices.replaceChildren(list);
}

/** 变量完整度 → 中文说明，用于「数据来源」区块。 */
const TIER_LABELS = {
  full: "全部变量（含叶面湿润、VPD、深层土壤湿度）",
  extended: "部分农业变量（缺叶面湿润、VPD、深层土壤湿度）",
  core: "仅核心变量",
};

/**
 * Open-Meteo 变量名 → 中文。清单里同时保留原始变量名，
 * 用户既能读懂"取了什么"，也能拿中文名去核对上游文档。
 */
const VARIABLE_LABELS = {
  temperature_2m: "气温",
  relative_humidity_2m: "相对湿度",
  dew_point_2m: "露点",
  precipitation: "降水",
  precipitation_probability: "降水概率",
  weather_code: "天气现象代码",
  wind_speed_10m: "风速",
  wind_direction_10m: "风向",
  wind_gusts_10m: "阵风",
  et0_fao_evapotranspiration: "参考蒸散 ET₀",
  soil_moisture_0_to_1cm: "土壤湿度 0–1 cm",
  soil_moisture_3_to_9cm: "土壤湿度 3–9 cm",
  soil_moisture_9_to_27cm: "土壤湿度 9–27 cm",
  soil_moisture_27_to_81cm: "土壤湿度 27–81 cm",
  soil_temperature_6cm: "土壤温度 6 cm",
  cloud_cover: "云量",
  leaf_wetness_probability: "叶面湿润概率",
  vapour_pressure_deficit: "饱和水汽压差 VPD",
  surface_pressure: "地面气压",
  temperature_2m_max: "最高气温",
  temperature_2m_min: "最低气温",
  precipitation_sum: "日降水量",
  precipitation_probability_max: "最大降水概率",
  wind_speed_10m_max: "最大风速",
  wind_gusts_10m_max: "最大阵风",
  wind_direction_10m_dominant: "主导风向",
  sunrise: "日出",
  sunset: "日落",
  daylight_duration: "昼长",
};

/** 一组变量清单：标题 + 中文名/原始名成对的 chip。 */
function renderVariableGroup(title, names) {
  if (names.length === 0) return null;
  const wrapper = el("div", "sources__group");
  wrapper.append(el("p", "sources__vars", `${title}（${names.length}）`));

  const list = el("ul", "sources__chips");
  for (const name of names) {
    if (typeof name !== "string" || !name) continue;
    const chip = el("li", "sources__chip");
    const label = VARIABLE_LABELS[name];
    if (label) chip.append(el("span", "sources__chip-label", label));
    chip.append(el("code", "sources__chip-name", name));
    list.append(chip);
  }
  wrapper.append(list);
  return wrapper;
}

/**
 * 数据来源与本次变量：把"建议到底用了哪些公开数据"摊开，供用户核对。
 * 缺字段时整块隐藏，避免出现空壳。
 */
function renderSources(data) {
  if (!els.sources || !els.sourcesBody) return;
  const source = data.source && typeof data.source === "object" ? data.source : null;
  const hourly = source && Array.isArray(source.hourlyVariables) ? source.hourlyVariables : [];
  const daily = source && Array.isArray(source.dailyVariables) ? source.dailyVariables : [];
  if (!source || (hourly.length === 0 && daily.length === 0)) {
    els.sources.hidden = true;
    els.sourcesBody.replaceChildren();
    return;
  }

  const facts = [
    ["气象与土壤数据", `${source.weather || "Open-Meteo"}（${source.license || "CC BY 4.0"}）`],
    ["本次取数方式", source.cache === "HIT" ? "命中 1 小时缓存" : "实时请求上游接口"],
    ["变量完整度", TIER_LABELS[source.variableTier] || source.variableTier || "—"],
    ["地区反查", "OpenStreetMap（Nominatim / Photon）"],
    ["城市检索", "Open-Meteo Geocoding API"],
    ["模型口径", "逐日与逐时数据为数值模式输出；past_days 为过去的模式预报，非气象站实测"],
  ];

  const list = el("dl", "sources__facts");
  for (const [label, value] of facts) {
    const row = el("div", "sources__row");
    row.append(el("dt", undefined, label), el("dd", undefined, value));
    list.append(row);
  }

  const groups = [
    renderVariableGroup("逐时变量", hourly),
    renderVariableGroup("逐日变量", daily),
  ].filter(Boolean);

  els.sourcesBody.replaceChildren(list, ...groups);
  els.sources.hidden = false;
}

function renderCard(card, focusId) {
  const level = LEVEL_LABELS[card.level] ? card.level : "ok";
  // summary.focusId 指明“今日重点”，高亮它，摘要里的结论才有对应的落点。
  const isFocus = typeof focusId === "string" && focusId !== "" && card.id === focusId;
  const article = el("article", `card card--${level}${isFocus ? " card--focus" : ""}`);
  if (isFocus) article.dataset.focus = "true";

  const head = el("div", "card__head");
  head.append(
    el("span", "card__category", card.category || ""),
    el("span", "badge", card.levelLabel || LEVEL_LABELS[level]),
  );
  if (isFocus) head.append(el("span", "card__focus-tag", "今日重点"));

  article.append(head);
  article.append(el("h2", "card__headline", card.headline || ""));
  article.append(el("p", "card__reason", card.reason || ""));

  // 作业窗口条：把决策层算出的候选时段画成时间轴，而不是只用文字罗列。
  const windows = Array.isArray(card.sprayWindows) ? card.sprayWindows : [];
  const usableWindows = windows.filter(
    (item) => item && typeof item.start === "string" && typeof item.end === "string",
  );
  if (usableWindows.length > 0) {
    article.append(el("p", "card__section-label", "候选作业时段"));
    const list = el("ul", "spray-list");
    for (const window of usableWindows) {
      const row = el("li", "spray-window");
      const score = typeof window.score === "number" && Number.isFinite(window.score) ? window.score : null;
      // 适宜度同时用文字与条形表达，避免只靠颜色传递信息。
      if (score !== null) row.className = `spray-window spray-window--${score >= 75 ? "good" : score >= 60 ? "fair" : "poor"}`;

      const time = el("span", "spray-window__time", `${formatHour(window.start)} – ${formatHour(window.end)}`);
      const meta = el("span", "spray-window__meta");
      meta.append(
        el("span", undefined, `${Number.isFinite(window.hours) ? window.hours : "—"} 小时`),
        el("span", undefined, score === null ? "适宜度 —" : `适宜度 ${score}`),
      );
      row.append(time, meta);
      if (score !== null) {
        const bar = el("span", "spray-window__bar");
        const fill = el("span", "spray-window__fill");
        fill.style.width = `${Math.max(0, Math.min(100, score))}%`;
        bar.append(fill);
        row.append(bar);
      }
      list.append(row);
    }
    article.append(list);
  }

  if (Array.isArray(card.actions) && card.actions.length > 0) {
    article.append(el("p", "card__section-label", "操作建议"));
    const list = el("ul", "card__actions");
    for (const action of card.actions) list.append(el("li", undefined, action));
    article.append(list);
  }

  if (Array.isArray(card.metrics) && card.metrics.length > 0) {
    const dl = document.createElement("dl");
    dl.className = "card__metrics";
    for (const metric of card.metrics) {
      const wrapper = document.createElement("div");
      wrapper.append(el("dt", undefined, metric.label || ""), el("dd", undefined, metric.value || ""));
      dl.append(wrapper);
    }
    article.append(dl);
  }

  return article;
}

function formatValue(value, unit, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} ${unit}`;
}

function formatDateTime(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const options = {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  try {
    return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: timeZone || undefined }).format(date);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  }
}

/* ---------- 城市选择 ---------- */

function openCitySheet() {
  els.sheet.hidden = false;
  els.sheetResults.replaceChildren();
  els.sheetHint.textContent = "定位不准时，可在此手动指定位置；选择结果会保存在本机浏览器中。";
}

function closeCitySheet() {
  els.sheet.hidden = true;
}

async function searchCity(query) {
  const token = (searchToken += 1);
  els.sheetHint.textContent = "搜索中…";
  els.sheetResults.replaceChildren();

  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json();
    if (token !== searchToken) return;

    if (!data || data.ok !== true) {
      els.sheetHint.textContent = (data && data.message) || "搜索失败，请稍后重试。";
      return;
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
      els.sheetHint.textContent = `没有找到「${query}」，试试加上省份或使用更完整的区县名称。`;
      return;
    }

    els.sheetHint.textContent = "点击选择要使用的位置：";
    els.sheetResults.replaceChildren(...results.map(renderSearchResult));
  } catch {
    if (token !== searchToken) return;
    els.sheetHint.textContent = "网络异常，搜索失败，请稍后重试。";
  }
}

function renderSearchResult(result) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";

  const name = typeof result.name === "string" && result.name ? result.name : "未知地点";
  button.append(document.createTextNode(name));

  const subParts = [];
  if (result.region && result.region !== name) subParts.push(result.region);
  if (result.country && result.country !== "中国") subParts.push(result.country);
  subParts.push(`${Number(result.latitude).toFixed(2)}, ${Number(result.longitude).toFixed(2)}`);

  button.append(el("span", "results__sub", subParts.join(" · ")));

  button.addEventListener("click", () => {
    state.location = {
      name,
      region: typeof result.region === "string" ? result.region : "",
      lat: Number(result.latitude),
      lon: Number(result.longitude),
    };
    writeJson(STORAGE_KEYS.location, state.location);
    closeCitySheet();
    showToast(`已切换到 ${name}`);
    load();
  });

  item.append(button);
  return item;
}

/* ---------- 本机定位（浏览器 Geolocation，WGS84，与气象数据同一坐标系） ---------- */

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 5 * 60 * 1000,
};

function useDeviceLocation() {
  if (!("geolocation" in navigator)) {
    els.sheetHint.textContent = "当前浏览器不支持本机定位，请手动搜索城市。";
    return;
  }
  els.sheetHint.textContent = "正在获取本机位置…首次使用浏览器会询问定位授权。";
  navigator.geolocation.getCurrentPosition(handleDevicePosition, handleDeviceError, GEO_OPTIONS);
}

function handleDevicePosition(position) {
  const coords = (position && position.coords) || {};
  const lat = Number(coords.latitude);
  const lon = Number(coords.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    els.sheetHint.textContent = "拿到的位置不完整，请手动搜索城市。";
    return;
  }

  const rawAccuracy = Number(coords.accuracy);
  const accuracy = Number.isFinite(rawAccuracy) ? Math.round(rawAccuracy) : null;
  state.location = { name: "本机定位", region: "", lat, lon, source: "device", accuracy };
  writeJson(STORAGE_KEYS.location, state.location);
  closeCitySheet();
  showToast(accuracy === null ? "已使用本机定位" : `已使用本机定位（精度约 ${accuracy} 米）`);
  load();
}

function handleDeviceError(error) {
  const code = error && typeof error.code === "number" ? error.code : 0;
  const messages = {
    1: "定位权限被拒绝：可在浏览器的站点权限里允许定位，或直接搜索城市。",
    2: "系统暂时无法给出位置，请手动搜索城市。",
    3: "定位超时，请重试或手动搜索城市。",
  };
  els.sheetHint.textContent = messages[code] || "本机定位不可用，请手动搜索城市。";
}

/* ---------- 交互绑定 ---------- */

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function bindEvents() {
  els.refresh.addEventListener("click", () => {
    const elapsed = Date.now() - readStoredNumber(STORAGE_KEYS.lastForce, 0);
    const remaining = FORCE_COOLDOWN_MS - elapsed;
    if (remaining > 0) {
      showToast(`刷新过于频繁，请 ${Math.ceil(remaining / 1000)} 秒后再试`);
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEYS.lastForce, String(Date.now()));
    } catch {
      /* 忽略 */
    }
    load({ force: true });
  });

  els.cityBtn.addEventListener("click", openCitySheet);

  els.cropSelect.addEventListener("change", () => {
    selectCrop(els.cropSelect.value || CROP_DEFAULT);
  });

  els.sowingDate.addEventListener("change", () => {
    const value = els.sowingDate.value;
    if (!isValidDateString(value)) {
      state.sowing = null;
      writeStoredSowing(null);
      showToast("播种日期格式不正确，已恢复按地区估算");
      load();
      return;
    }
    state.sowing = value;
    writeStoredSowing(value);
    load();
  });

  els.sowingClear.addEventListener("click", () => {
    state.sowing = null;
    writeStoredSowing(null);
    els.sowingDate.value = "";
    showToast("已恢复按地区估算播种期");
    load();
  });

  els.sheet.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && "sheetClose" in target.dataset) closeCitySheet();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.sheet.hidden) closeCitySheet();
  });

  els.sheetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = els.sheetInput.value.trim();
    if (query) searchCity(query);
  });

  els.useIp.addEventListener("click", () => {
    state.location = null;
    writeJson(STORAGE_KEYS.location, null);
    closeCitySheet();
    showToast("已恢复使用网络定位");
    load();
  });

  els.useDevice.addEventListener("click", useDeviceLocation);
}

/** 支持用 ?lat=&lon=&city=&sowing= 直接指定位置与播种期，方便测试与分享。 */
function applyUrlLocation() {
  const params = new URLSearchParams(window.location.search);
  const sowing = (params.get("sowing") || "").trim();
  if (isValidDateString(sowing)) state.sowing = sowing;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
  state.location = {
    name: (params.get("city") || "").trim() || "手动位置",
    region: (params.get("region") || "").trim(),
    lat,
    lon,
  };
}

/** 当前实际用于判断“是否多年生”的作物 id：自动模式取服务端返回的作物。 */
function currentCropId() {
  if (state.crop && state.crop !== CROP_DEFAULT) return state.crop;
  return state.data && state.data.crop && typeof state.data.crop.id === "string"
    ? state.data.crop.id
    : "";
}

function isPerennialCrop(cropId) {
  const meta = cropMeta.get(cropId);
  return !!(meta && meta.perennial);
}

/** 播种期输入：多年生作物隐藏；有手动值时显示清除按钮。 */
function syncSowingInput(selection) {
  if (!els.sowingDate) return;
  const container = els.sowingDate.closest(".location__item--sowing");
  const perennial = isPerennialCrop(currentCropId());
  if (container) container.hidden = perennial;
  if (perennial) return;

  const inferred =
    selection && typeof selection.sowingDate === "string" ? selection.sowingDate : "";
  const value = state.sowing || inferred;
  if (document.activeElement !== els.sowingDate && value) {
    els.sowingDate.value = value;
  }

  const today = new Date();
  els.sowingDate.max = today.toISOString().slice(0, 10);
  const oldest = new Date(today.getTime() - 400 * 86_400_000);
  els.sowingDate.min = oldest.toISOString().slice(0, 10);
  if (els.sowingClear) els.sowingClear.hidden = !state.sowing;
}

/** 拉取作物目录并动态生成分组下拉框，避免 HTML 与 crops.ts 双份维护。 */
async function loadCropCatalog() {
  try {
    const response = await fetch("/api/crops", { headers: { accept: "application/json" } });
    const data = await response.json();
    if (!data || data.ok !== true || !Array.isArray(data.crops)) return;
    cropCatalog = data.crops.filter((item) => item && typeof item.id === "string");
    cropMeta = new Map(cropCatalog.map((item) => [item.id, item]));
    renderCropOptions(Array.isArray(data.groups) ? data.groups : []);
  } catch {
    // 目录加载失败时保留“自动”选项，页面仍可用自动模式。
  }
}

function renderCropOptions(groups) {
  if (!els.cropSelect) return;
  const select = els.cropSelect;
  const previous = select.value || state.crop;
  select.replaceChildren(new Option("自动（按地区当季）", "auto"));

  const byGroup = new Map();
  for (const crop of cropCatalog) {
    const group = typeof crop.group === "string" && crop.group ? crop.group : "其他";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(crop);
  }

  const seen = new Set();
  const appendGroup = (group) => {
    const items = byGroup.get(group);
    if (!items || seen.has(group)) return;
    seen.add(group);
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    for (const crop of items) {
      optgroup.append(new Option(crop.name || crop.id, crop.id));
    }
    select.append(optgroup);
  };

  for (const group of groups) appendGroup(group);
  for (const group of byGroup.keys()) appendGroup(group);

  select.value = previous;
  if (!select.value) {
    select.value = CROP_DEFAULT;
    state.crop = CROP_DEFAULT;
  }
}

async function init() {
  applyUrlLocation();
  await loadCropCatalog();
  els.cropSelect.value = state.crop;
  if (!els.cropSelect.value) els.cropSelect.value = CROP_DEFAULT;
  state.crop = els.cropSelect.value;

  bindEvents();
  syncSowingInput(null);
  load();
}

init();
