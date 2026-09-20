/* 农忙参谋 — 前端脚本
 * 原生 ES 模块，无构建、无第三方依赖。
 * 所有后端返回的文本都用 textContent 写入 DOM，不使用 innerHTML，避免 XSS。
 */

const STORAGE_KEYS = {
  location: "nmcm.location",
  crop: "nmcm.crop",
  lastForce: "nmcm.lastForce",
};

const CROP_DEFAULT = "general";
/** 手动刷新冷却时间，避免用户连续点刷新消耗上游免费额度。 */
const FORCE_COOLDOWN_MS = 60 * 1000;

const LEVEL_LABELS = { ok: "平稳", watch: "关注", warn: "预警", alert: "警报" };

const els = {
  refresh: document.getElementById("refresh-btn"),
  cityBtn: document.getElementById("city-btn"),
  locationName: document.getElementById("location-name"),
  locationMeta: document.getElementById("location-meta"),
  cropSelect: document.getElementById("crop-select"),
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
  toast: document.getElementById("toast"),
};

const state = {
  /** 手动选择的城市；为 null 表示使用服务端 IP 粗定位。 */
  location: readStoredLocation(),
  crop: readStoredCrop(),
  loading: false,
  data: null,
};

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
  return {
    name: typeof value.name === "string" && value.name ? value.name : "手动位置",
    region: typeof value.region === "string" ? value.region : "",
    lat,
    lon,
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
  }
  if (state.crop && state.crop !== CROP_DEFAULT) params.set("crop", state.crop);
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
  if (location.region && location.region !== location.name) parts.push(location.region);
  parts.push(location.source === "manual" ? "手动选择" : "网络定位");
  if (Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
    parts.push(`${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`);
  }
  if (data.crop && data.crop.name) parts.push(data.crop.name);
  els.locationMeta.textContent = parts.join(" · ");
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
    state.crop = els.cropSelect.value || CROP_DEFAULT;
    try {
      window.localStorage.setItem(STORAGE_KEYS.crop, state.crop);
    } catch {
      /* 忽略 */
    }
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
}

/** 支持用 ?lat=&lon=&city= 直接指定位置，方便测试与分享。 */
function applyUrlLocation() {
  const params = new URLSearchParams(window.location.search);
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

function init() {
  applyUrlLocation();
  els.cropSelect.value = state.crop;
  if (!els.cropSelect.value) els.cropSelect.value = CROP_DEFAULT;
  state.crop = els.cropSelect.value;

  bindEvents();
  load();
}

init();
