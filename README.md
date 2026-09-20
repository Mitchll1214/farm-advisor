# 农忙参谋

**打开网页就知道今天该不该浇水、会不会下霜、什么时候打药。**

> **它是什么** · 部署在 Cloudflare Pages 上的中文农事建议网站，静态页面 + Pages Functions。
> **它做什么** · 按访问者 IP 粗定位，给出灌溉、霜冻、积温、干旱、喷洒窗口等 7 类结论化建议。
> **它不做什么** · 不展示原始气象数字，不替代实地农艺指导，不用于商业用途。

`Cloudflare Pages` · `TypeScript` · `无构建步骤` · `运行时零依赖` · `免费额度内运行`

---

## 它长什么样

每张卡片都是 **结论 → 原因 → 操作建议**，原因里带上判断所依据的数值，而不是只说"注意防范"。

下面是示例输出（玉米地块，数值随位置、作物与时间变化）：

> ### 灌溉 · 预警
>
> **根区水分偏低，建议灌溉约 45 mm**
>
> 根区土壤体积含水量 19.0 %（假定田间持水量 32 %、凋萎点 14 %……）；剩余有效水 40 mm，
> 灌溉触发阈值 72 mm。未来 24 小时作物蒸散 ETc 4.8 mm、有效降水 0.4 mm。
> 建议灌溉量按灌溉水利用系数 0.8 折算。剩余有效水仅占可利用水 28 %，低于触发阈值，需及时补水。
>
> **操作建议**
> - 建议灌溉量约 45 mm，分次给水，避免大水漫灌造成深层渗漏
> - 选择清晨或傍晚灌溉，减少蒸发损失
> - 灌溉后 2–3 天复查根区湿度，砂性土应少量多次
>
> `根区土壤湿度 19.0 %` `假定田间持水量 32 %` `根区可利用水 40 mm / 144 mm`
> `灌溉触发阈值 72 mm` `未来 24h 作物蒸散 ETc 4.8 mm` `未来 24h 有效降水 0.4 mm`

> ### 喷洒窗口 · 平稳
>
> **适宜作业：9月21日 06:00 起 3 小时（88 分）**
>
> 判定条件：风速 ≤ 5 m/s、阵风 ≤ 9 m/s、无降水且未来 6 小时雨量 < 1 mm、气温 5–32 ℃、
> 降水概率 ≤ 70 %，作业时段限 5:00–19:00。未来 48 小时筛出 4 个候选窗口，推荐时段：
> 9月21日 06:00–09:00（88 分）、9月20日 18:00–19:00（84 分）。首选窗口平均风速 3.2 m/s、
> 气温 18.6 ℃、相对湿度 74 %。
>
> **操作建议**
> - 选择清晨露水干后或傍晚作业，此时风速低、蒸发损失小
> - 核查下风向 100 m 内有无敏感作物、水源、蜂场与居民点
> - 按标签推荐剂量与用水量配药，避免重喷、漏喷
> - 施药后 6 小时内如遇降雨，视药剂耐冲刷性决定是否补喷

页面上这些卡片按建议等级从高到低排列，移动端单列、桌面端多列。

---

## 提供哪些建议

| 卡片 | 内容 |
| --- | --- |
| 灌溉 | 根区水量平衡，给出「需灌溉 / 等雨 / 不需灌溉」与建议灌溉量（mm） |
| 霜冻 / 热应激 | 扫描未来 48 小时最低/最高气温，判断霜冻与高温胁迫风险 |
| 生长度日 GDD | 近 14 天积温 + 未来 7 天预报积温与日均速率 |
| 干旱趋势 | 连续无有效降水天数、近 14 天降水/ET₀ 比值，并按降水预报调整等级 |
| 喷洒窗口 | 未来 48 小时逐小时打分，给出最佳作业时段与主要限制因素 |
| 水分盈亏 | 未来 7 天「有效降水 − 作物 ETc」累计盈亏与亏缺天数 |
| 病虫害风险 | 气象驱动的发生条件推断（等级上限为「预警」，不作为施药依据） |

另外：**10 种作物档案**（通用大田作物、玉米、冬小麦、水稻、大豆、马铃薯、番茄、油菜、棉花、苹果）、**手动切换城市**、**1 小时缓存**、**定位或数据源失败时的降级提示**、页脚常驻的**免责声明与隐私说明**。

---

## 数据从哪来，怎么变成建议

```text
浏览器（移动端优先的静态页面，无框架、无外部字体）
   │  GET /api/advisony
   ▼
Pages Function  functions/api/advisony.ts
   ├─ 1 定位   request.cf 的省/市与经纬度；URL 带 lat/lon 时优先用手动坐标
   ├─ 2 缓存   Cache API（作物 + 坐标格网 + 小时分桶），命中就直接返回
   ├─ 3 取数   Open-Meteo：一次请求拿全逐时气象、逐日摘要、分层土壤湿度与 ET₀
   ├─ 4 决策   src/decision/*.ts 的七个纯函数模块
   └─ 5 响应   中文建议卡片 JSON，并写回缓存
```

数据源只有 **Open-Meteo**（Forecast API 与 Geocoding API），没有其它外部服务。

### 缓存与免费额度

| 资源 | 免费额度 | 本项目的用法 |
| --- | --- | --- |
| Pages 静态资源 | 无限 | 单页 + CSS + JS，无外部依赖 |
| Pages Functions | 100,000 请求/天 | 仅 `/api/advisony` 与 `/api/geocode` |
| Open-Meteo | 10,000 调用/天 | 缓存 1 小时 + 边缘 `cacheTtl` 600 秒 |
| KV / D1 | — | **不使用**，缓存只用运行时 Cache API |

- 缓存 key 为 `作物 + 定位来源 + 纬度(2 位小数) + 经度(2 位小数) + 小时分桶`，同一格网内的用户共享同一份**决策结果**。
- **缓存体里不含任何请求者相关信息**：只存气象派生的卡片、摘要与地块时区；城市名、经纬度、定位来源在每次响应时按当前请求者重新组装。否则同一格网内后到的用户会看到前一个用户的 IP 定位城市名与坐标。
- IP 定位的请求 URL 对所有用户都一样：响应下发 `Cache-Control: private, max-age=300`，并额外加 `CDN-Cache-Control: no-store`，阻止 CDN 按 URL 缓存造成地区串味。手动指定坐标的 URL 自带参数，可用 `public, max-age=3600`。
- 页面「刷新」按钮带 60 秒冷却，避免连续点击消耗上游配额。

---

## 快速开始

需要 Node.js 18+ 与 npm。

```bash
npm install
npm run dev          # = wrangler pages dev public
```

打开 <http://localhost:8787>。本地预览时 `request.cf` 没有真实地理数据，自动定位会失败并引导手动选择城市；想直接看到建议，用 URL 参数指定坐标：

```text
http://localhost:8787/?lat=36.71&lon=119.10&city=潍坊
```

类型检查（可选，仓库里没有编译产物）：

```bash
npm run check        # = tsc --noEmit
```

### 部署到 Cloudflare Pages

**方式 A · wrangler 直传**

```bash
npx wrangler login
npm run deploy       # = wrangler pages deploy public
```

首次执行会提示创建 Pages 项目，名称取 `wrangler.toml` 里的 `farm-advisor`。

**方式 B · Git 集成**

推到 GitHub 后在 Cloudflare Dashboard → Workers & Pages → 创建 Pages 项目 → 连接仓库：构建命令留空，构建输出目录填 `public`。

两种方式都不需要额外的构建步骤：`functions/` 下的 `.ts` 由 wrangler 用 esbuild 自动编译打包，`public/` 就是静态资源目录。部署后可在 Pages 概览页查看请求数与 Functions 调用量，用于监控免费额度。

---

## 接口

### `GET /api/advisony`

| 参数 | 说明 |
| --- | --- |
| `lat`、`lon` | 手动指定坐标；两者同时合法时优先于 IP 定位 |
| `city`、`region` | 手动指定的地名，仅用于展示 |
| `crop` | 作物 id（见 `src/lib/crops.ts`），默认 `general` |
| `force=1` | 跳过缓存读取，强制重新取数（前端有 60 秒冷却） |

<details>
<summary>成功响应示例（<code>ok: true</code>）</summary>

```jsonc
{
  "ok": true,
  "generatedAt": "2026-09-20T06:12:33.000Z",
  "location": { "name": "潍坊", "region": "山东省", "lat": 36.71, "lon": 119.1,
                "source": "ip", "timezone": "Asia/Shanghai" },
  "crop": { "id": "corn", "name": "玉米" },
  "current": { "timeLabel": "9月20日 14:00", "temperature": 24.3, "humidity": 62,
               "windSpeed": 2.1, "soilMoisture": 19.0, "soilTemperature": 22.8,
               "precipitation1h": 0, "et0Today": 3.4 },
  "summary": { "level": "warn", "headline": "根区水分偏低，建议灌溉约 45 mm", "focusId": "irrigation" },
  "cards": [
    {
      "id": "irrigation", "category": "灌溉", "level": "warn", "levelLabel": "预警",
      "headline": "根区水分偏低，建议灌溉约 45 mm",
      "reason": "根区土壤体积含水量 19.0 %……",
      "actions": ["建议灌溉量约 45 mm，分次给水，避免大水漫灌造成深层渗漏", "……"],
      "metrics": [{ "label": "根区土壤湿度", "value": "19.0 %" }]
    }
  ],
  "notices": ["当前按「通用大田作物」阈值计算，在页面上选择具体作物后建议会更贴合。"],
  "source": { "weather": "Open-Meteo", "cache": "MISS" }
}
```

`cards` 按建议等级从高到低排序，第一张就是最需要先处理的事情；`level` 取 `ok` / `watch` / `warn` / `alert`。

</details>

失败时返回 `ok: false`，HTTP 状态仍为 200，便于前端统一处理：

```jsonc
{ "ok": false, "code": "locate_failed",
  "message": "无法根据网络位置判断你所在的地区，请手动选择城市。", "fallback": true }
```

`code` 取值：`locate_failed`（定位失败，引导手动选城市）、`upstream_error`（气象数据源失败）、`bad_request`、`internal_error`。

### `GET /api/geocode?q=潍坊`

城市检索代理，返回 `{ ok: true, query, results: [{ name, region, country, latitude, longitude, timezone }] }`，结果缓存 24 小时。

---

## 决策口径与已知局限

每个模块的完整算法与阈值都写在对应源文件的头部注释里，要点如下：

- **灌溉**：`ETc = ET₀ × Kc`；有效降水按 80 %；根区土壤湿度取 0–1 / 3–9 / 9–27 cm 三层按层厚加权；剩余有效水低于 `TAW × 触发比例` 时建议灌溉，灌溉量按灌溉水利用系数 0.8 折算并限幅。
- **霜冻 / 热应激**：用 2 m 气温判定，阈值外扩 2 ℃ 作为「关注」档 —— 晴夜地表温度通常比 2 m 气温再低 1–2 ℃。
- **生长度日**：截断法 `max(0, clamp(日均温, 基温, 上限) − 基温)`。**没有播种日期，因此不推断生育阶段**，只报告积温收支。
- **干旱趋势**：连续无有效降水天数（单日 < 1 mm 记为无效）+ 近 14 天降水/ET₀ 比值；未来 7 天降水能覆盖同期蒸散 80 % 以上时下调一级。
- **喷洒窗口**：风速 5 m/s、阵风 9 m/s、未来 6 小时雨量 1 mm、气温 5–32 ℃、降水概率 70 %、时段 5:00–19:00 是硬性排除条件，其余按权重扣分。
- **病虫害**：只用近 3 天温湿与降水条件推断「是否有利于发生」，未接入田块虫情与区域测报，**等级上限为「预警」**。
- **历史数据**：`past_days=14` 取的是**过去的模式预报**，不是气象站实测，用于趋势判断足够，但不能当作观测值。

已知局限（页面上也会如实提示）：

1. 土壤水文参数（田间持水量、凋萎点、根区深度）来自作物档案里的经验假定值，**没有接入 SoilGrids 等土壤数据库**，因此灌溉建议是量级正确的参考值，不能替代土壤检测。
2. 水稻以田面水层管理为主，土壤湿度判据对它的参考性有限。
3. IP 定位精度约为城市级，且受运营商出口影响，可能落在相邻地市；用页面上的「切换城市」修正。
4. 所有建议基于公开模式数据自动生成，仅供参考，不构成农艺指导，不替代实地查勘与当地农技部门的意见。

---

## 项目结构

<details>
<summary>展开目录树</summary>

```text
farm-advisor/
├── public/                      # Pages 静态输出目录
│   ├── index.html               # 移动端优先的单页界面
│   ├── style.css                # 含深色模式，无外部字体与图标
│   └── app.js                   # 原生 ES 模块，无构建、无第三方依赖
├── functions/api/
│   ├── advisony.ts              # GET /api/advisony：定位 → 缓存 → 取数 → 决策
│   └── geocode.ts               # GET /api/geocode：城市检索代理
├── src/lib/
│   ├── types.ts                 # 共享类型，也是接口响应契约
│   ├── util.ts                  # NaN 安全的数值与格式化工具
│   ├── crops.ts                 # 作物参数档案
│   ├── http.ts                  # Pages Functions 助手（JSON / Cache / cf 解析）
│   └── openmeteo.ts             # Open-Meteo 客户端与数据规范化
├── src/decision/
│   ├── irrigation.ts  frost.ts  gdd.ts  drought.ts
│   ├── spray.ts  waterBalance.ts  pest.ts
│   └── index.ts                 # 编排：卡片汇总、摘要、当前条件
├── wrangler.toml · package.json · tsconfig.json
└── functions/tsconfig.json
```

`functions/api/advisony.ts` 用相对路径 `../../src/decision/index` 引入共享决策模块 —— 这是 Cloudflare 官方支持的用法（[Module support](https://developers.cloudflare.com/pages/functions/module-support/)），把共享代码放在 `functions/` 之外也避免它被文件路由当成接口。`functions/tsconfig.json` 是 Cloudflare 建议的做法，防止根 `tsconfig.json` 干扰函数打包。

</details>

### 新增一种作物

在 `src/lib/crops.ts` 的 `CROPS` 数组里追加一份档案（基点温度、上限温度、作物系数 Kc、霜冻与热应激阈值、土壤水文假定、根区深度、灌溉触发比例、病虫害模型），再把 id 与中文名同步到 `public/index.html` 的 `#crop-select` 下拉框即可。

---

## 隐私、免责与许可

**隐私** 本站不设账号、不使用追踪 Cookie，也不收集个人身份信息。为实现自动定位，服务端读取 Cloudflare 提供的访问者 IP 粗定位信息（省/市与经纬度，精度约城市级），仅用于向气象数据源请求对应位置的天气；该信息不会写入数据库，也不会随响应返回给其他用户。手动选择的城市只保存在本机浏览器的 localStorage 中，点「切换城市 → 使用我的网络位置」即可清除。

**免责** 页面输出的一切建议由公开气象与土壤模式数据自动生成，仅供参考，不构成农艺指导，请结合田间实际情况判断后使用。

**许可** 代码仅供个人 / 非商业用途；Open-Meteo 免费层同样限非商业使用，商业用途需另行申请许可或更换数据源。气象数据来源 [Open-Meteo](https://open-meteo.com/)，遵循 CC BY 4.0。
