/**
 * 农忙参谋 — Open-Meteo 数据客户端。
 *
 * 数据源：Open-Meteo Forecast API（免费层，非商业使用，署名 CC BY 4.0）。
 * 一次请求同时取回天气、土壤湿度、土壤温度与 FAO-56 参考蒸散 ET₀，
 * 上游响应额外用 Cloudflare 边缘缓存（cacheTtl）兜一层，压缩免费额度消耗。
 *
 * 注意：past_days 返回的是"过去的模式预报"而非站点实测，用于干旱趋势判断足够，
 * 但不等同于气象站观测值。
 */

import type { DailySeries, HourlySeries, WeatherBundle } from "./types";
import { toNum } from "./util";

const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 8000;
/** 边缘缓存上游响应的秒数：Open-Meteo 数据按小时更新，10 分钟足够新鲜。 */
const UPSTREAM_CACHE_TTL = 600;

const FULL_HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
  "et0_fao_evapotranspiration",
  "soil_moisture_0_to_1cm",
  "soil_moisture_3_to_9cm",
  "soil_moisture_9_to_27cm",
  "soil_moisture_27_to_81cm",
  "soil_temperature_6cm",
  "cloud_cover",
  "leaf_wetness_probability",
  "vapour_pressure_deficit",
];

/**
 * 次级变量集：去掉叶面湿润、VPD 与深层土壤湿度这三个较新的农业变量。
 * 某些区域或模型组合对它们返回 400 时，保留其余农业变量降级一次，
 * 而不是直接掉到只剩核心变量。
 */
const EXTENDED_HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
  "et0_fao_evapotranspiration",
  "soil_moisture_0_to_1cm",
  "soil_moisture_3_to_9cm",
  "soil_moisture_9_to_27cm",
  "soil_temperature_6cm",
  "cloud_cover",
];

const FULL_DAILY = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "et0_fao_evapotranspiration",
  "precipitation_probability_max",
  "wind_speed_10m_max",
];

/** 精简变量集：万一上游对某些农业变量返回 400，用它降级重试，保证页面仍有建议。 */
const CORE_HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "wind_speed_10m",
  "et0_fao_evapotranspiration",
];

const CORE_DAILY = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"];

export class WeatherError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "WeatherError";
    this.code = code;
    this.detail = detail;
  }
}

export interface FetchWeatherOptions {
  pastDays?: number;
  forecastDays?: number;
  timeoutMs?: number;
}

interface RequestConfig {
  pastDays: number;
  forecastDays: number;
  hourly: string[];
  daily: string[];
  timeoutMs: number;
}

/**
 * 拉取并规范化指定坐标的气象与土壤数据。
 * @throws WeatherError 网络失败、超时或上游返回非 2xx。
 */
export async function fetchWeather(
  latitude: number,
  longitude: number,
  options: FetchWeatherOptions = {},
): Promise<WeatherBundle> {
  const config: RequestConfig = {
    pastDays: options.pastDays ?? 14,
    forecastDays: options.forecastDays ?? 7,
    hourly: FULL_HOURLY,
    daily: FULL_DAILY,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  };

  const tiers: { hourly: string[]; daily: string[]; tier: WeatherBundle["variableTier"] }[] = [
    { hourly: FULL_HOURLY, daily: FULL_DAILY, tier: "full" },
    { hourly: EXTENDED_HOURLY, daily: FULL_DAILY, tier: "extended" },
    { hourly: CORE_HOURLY, daily: CORE_DAILY, tier: "core" },
  ];

  let lastError: unknown = null;
  for (const tier of tiers) {
    try {
      const payload = await requestForecast(latitude, longitude, {
        ...config,
        hourly: tier.hourly,
        daily: tier.daily,
      });
      return normalize(payload, latitude, longitude, tier.tier);
    } catch (error) {
      lastError = error;
      const rejectable =
        error instanceof WeatherError && (error.code === "http_400" || error.code === "http_422");
      if (!rejectable) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new WeatherError("network", "Open-Meteo 请求失败");
}

async function requestForecast(
  latitude: number,
  longitude: number,
  config: RequestConfig,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    timezone: "auto",
    past_days: String(config.pastDays),
    forecast_days: String(config.forecastDays),
    wind_speed_unit: "ms",
    hourly: config.hourly.join(","),
    daily: config.daily.join(","),
  });
  const url = `${FORECAST_ENDPOINT}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  // cf 是 Cloudflare 专有的 fetch 选项，不属于标准 RequestInit。
  const init: RequestInit & { cf?: { cacheTtl: number } } = {
    signal: controller.signal,
    headers: { accept: "application/json" },
    cf: { cacheTtl: UPSTREAM_CACHE_TTL },
  };

  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new WeatherError(`http_${response.status}`, `Open-Meteo 返回 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object") {
      throw new WeatherError("parse", "Open-Meteo 返回内容不是合法 JSON 对象");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WeatherError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeatherError("timeout", `请求 Open-Meteo 超时（>${config.timeoutMs} ms）`);
    }
    throw new WeatherError("network", error instanceof Error ? error.message : "网络请求失败");
  } finally {
    clearTimeout(timer);
  }
}

function normalize(
  payload: Record<string, unknown>,
  latitude: number,
  longitude: number,
  variableTier: WeatherBundle["variableTier"],
): WeatherBundle {
  const hourlyRaw = asRecord(payload.hourly);
  const dailyRaw = asRecord(payload.daily);

  const hourlyTime = asStringArray(hourlyRaw.time);
  const hourlyLength = hourlyTime.length;
  const dailyTime = asStringArray(dailyRaw.time);
  const dailyLength = dailyTime.length;

  const hourly: HourlySeries = {
    time: hourlyTime,
    temperature: column(hourlyRaw, "temperature_2m", hourlyLength),
    humidity: column(hourlyRaw, "relative_humidity_2m", hourlyLength),
    dewPoint: column(hourlyRaw, "dew_point_2m", hourlyLength),
    precipitation: column(hourlyRaw, "precipitation", hourlyLength),
    precipProbability: column(hourlyRaw, "precipitation_probability", hourlyLength),
    windSpeed: column(hourlyRaw, "wind_speed_10m", hourlyLength),
    windGust: column(hourlyRaw, "wind_gusts_10m", hourlyLength),
    et0: column(hourlyRaw, "et0_fao_evapotranspiration", hourlyLength),
    soilMoisture0to1: column(hourlyRaw, "soil_moisture_0_to_1cm", hourlyLength),
    soilMoisture3to9: column(hourlyRaw, "soil_moisture_3_to_9cm", hourlyLength),
    soilMoisture9to27: column(hourlyRaw, "soil_moisture_9_to_27cm", hourlyLength),
    soilMoisture27to81: column(hourlyRaw, "soil_moisture_27_to_81cm", hourlyLength),
    soilTemperature6: column(hourlyRaw, "soil_temperature_6cm", hourlyLength),
    cloudCover: column(hourlyRaw, "cloud_cover", hourlyLength),
    leafWetness: column(hourlyRaw, "leaf_wetness_probability", hourlyLength),
    vpd: column(hourlyRaw, "vapour_pressure_deficit", hourlyLength),
  };

  const daily: DailySeries = {
    time: dailyTime,
    tMax: column(dailyRaw, "temperature_2m_max", dailyLength),
    tMin: column(dailyRaw, "temperature_2m_min", dailyLength),
    precipitation: column(dailyRaw, "precipitation_sum", dailyLength),
    et0: column(dailyRaw, "et0_fao_evapotranspiration", dailyLength),
    precipProbabilityMax: column(dailyRaw, "precipitation_probability_max", dailyLength),
    windSpeedMax: column(dailyRaw, "wind_speed_10m_max", dailyLength),
  };

  const rawOffset = toNum(payload.utc_offset_seconds);
  const utcOffsetSeconds = Number.isFinite(rawOffset) ? rawOffset : 0;
  const shifted = new Date(Date.now() + utcOffsetSeconds * 1000);
  const localStamp = shifted.toISOString();

  return {
    latitude,
    longitude,
    elevation: toNum(payload.elevation),
    timezone: typeof payload.timezone === "string" ? payload.timezone : "UTC",
    utcOffsetSeconds,
    localDate: localStamp.slice(0, 10),
    localHour: shifted.getUTCHours(),
    nowIndex: findNowIndex(hourlyTime, localStamp.slice(0, 13)),
    hourly,
    daily,
    fetchedAt: new Date().toISOString(),
    degradedVariables: variableTier !== "full",
    variableTier,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : ""));
}

/** 把某一列数值变量抽成与 time 等长的数组，缺失位置填 NaN。 */
function column(source: Record<string, unknown>, name: string, length: number): number[] {
  const out: number[] = new Array<number>(length).fill(NaN);
  const raw = source[name];
  if (!Array.isArray(raw)) return out;
  const limit = Math.min(length, raw.length);
  for (let i = 0; i < limit; i += 1) {
    out[i] = toNum(raw[i]);
  }
  return out;
}

/** 找到最后一个不晚于当前本地小时的时刻下标（即"当前小时"）。 */
function findNowIndex(times: string[], localHourStamp: string): number {
  let index = 0;
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i];
    if (typeof time !== "string" || time.length < 13) continue;
    if (time.slice(0, 13) <= localHourStamp) index = i;
    else break;
  }
  return index;
}
