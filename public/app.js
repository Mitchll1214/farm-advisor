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
  sowingDate: document.getElementById("sowing-date"),
  sowingClear: document.getElementById("sowing-clear"),
  summary: document.getElementById("summary-panel"),
  conditions: document.getElementById("conditions-panel"),
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
  renderSummary(data);
  renderConditions(data);
  renderNotices(data);
  els.cards.replaceChildren(...(Array.isArray(data.cards) ? data.cards.map(renderCard) : []));
}

function renderFailure(data) {
  // 已经有数据时不清屏，只提示失败原因，避免用户丢失眼前的信息。
  if (state.data) {
    showToast(data.message || "刷新失败，请稍后重试");
    return;
  }

  els.summary.hidden = true;
  els.conditions.hidden = true;
  els.notices.hidden = true;
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
  const meta = el(
    "p",
    "summary__time",
    `更新于 ${formatDateTime(data.generatedAt, data.location && data.location.timezone)} · ` +
      `${data.source && data.source.cache === "HIT" ? "命中 1 小时缓存" : "实时获取"}`,
  );

  els.summary.replaceChildren(head, text, meta);
}

function renderConditions(data) {
  const current = data.current || {};
  const items = [
    ["气温", formatValue(current.temperature, "℃", 1)],
    ["相对湿度", formatValue(current.humidity, "%", 0)],
    ["风速", formatValue(current.windSpeed, "m/s", 1)],
    ["根区土壤湿度", formatValue(current.soilMoisture, "%", 1)],
    ["土壤温度 6cm", formatValue(current.soilTemperature, "℃", 1)],
    ["近 1 小时降水", formatValue(current.precipitation1h, "mm", 1)],
    ["今日 ET₀", formatValue(current.et0Today, "mm", 1)],
  ];

  els.conditions.hidden = false;
  els.conditions.replaceChildren(
    ...items.map(([label, value]) => {
      const box = el("div", "condition");
      box.append(el("div", "condition__label", label), el("div", "condition__value", value));
      return box;
    }),
  );
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

function renderCard(card) {
  const level = LEVEL_LABELS[card.level] ? card.level : "ok";
  const article = el("article", `card card--${level}`);

  const head = el("div", "card__head");
  head.append(
    el("span", "card__category", card.category || ""),
    el("span", "badge", card.levelLabel || LEVEL_LABELS[level]),
  );

  article.append(head);
  article.append(el("h2", "card__headline", card.headline || ""));
  article.append(el("p", "card__reason", card.reason || ""));

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
