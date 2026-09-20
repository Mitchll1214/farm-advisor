# 农忙参谋

按访问者所在位置自动生成中文农事建议的 Web 应用，部署在 **Cloudflare Pages**（静态页面 + Pages Functions），全站在 Cloudflare 与 Open-Meteo 免费额度内运行，仅用于个人 / 非商业用途。

网站只展示结论化的农事建议，不直接展示原始气象数据。

---

## 1. 功能

| 卡片 | 内容 |
| --- | --- |
| 灌溉 | 根区水量平衡，给出「需灌溉 / 等雨 / 不需灌溉」与建议灌溉量（mm） |
| 霜冻 / 热应激 | 扫描未来 48 小时最低/最高气温，判断霜冻与高温胁迫风险 |
| 生长度日 GDD | 近 14 天实测积温 + 未来 7 天预报积温与日均速率 |
| 干旱趋势 | 连续无有效降水天数、近 14 天降水/ET₀ 比值，并按降水预报调整 |
| 喷洒窗口 | 未来 48 小时逐小时打分，给出最佳作业时段与限制因素 |
| 水分盈亏 | 未来 7 天「有效降水 − 作物 ETc」累计盈亏与亏缺天数 |
| 病虫害风险 | 气象驱动的发生条件推断（可选模块，等级上限为「预警」） |

其他：

- **自动定位**：读取 Cloudflare `request.cf` 的城市与经纬度（IP 粗定位）。
- **手动切换城市**：`/api/geocode` 代理 Open-Meteo Geocoding，选择结果只存在本机 localStorage。
- **10 种作物档案**：通用大田作物、玉米、冬小麦、水稻、大豆、马铃薯、番茄、油菜、棉花、苹果。
- **缓存 1 小时**：Cache API 按「作物 + 坐标格网 + 小时」缓存，同一位置 1 小时内只调用一次 Open-Meteo。
- **降级提示**：定位失败引导手动选城市；数据源失败提示重试；土壤湿度缺测时退化为水量平衡估算并在页面上标注。
- **免责声明与隐私说明**：页面底部常驻。

---

## 2. 目录结构

```
farm-advisor/
├── public/                      # 静态资源（Pages 输出目录）
│   ├── index.html               # 移动端优先的单页界面
│   ├── style.css                # 含深色模式，无外部字体/图标依赖
│   └── app.js                   # 原生 ES 模块，无构建、无第三方依赖
├── functions/
│   └── api/
│       ├── advisony.ts          # GET /api/advisony：定位 → 缓存 → 取数 → 决策
│       └── geocode.ts           # GET /api/geocode：城市检索代理
├── src/
│   ├── lib/
│   │   ├── types.ts             # 共享类型（也是接口响应契约）
│   │   ├── util.ts              # NaN 安全的数值与格式化工具
│   │   ├── crops.ts             # 作物参数档案
│   │   ├── http.ts              # Pages Functions 助手（JSON/Cache/cf 解析）
│   │   └── openmeteo.ts         # Open-Meteo 客户端与数据规范化
│   └── decision/
│       ├── irrigation.ts        # 灌溉
│       ├── frost.ts             # 霜冻 / 热应激
│       ├── gdd.ts               # 生长度日
│       ├── drought.ts           # 干旱趋势
│       ├── spray.ts             # 喷洒窗口
│       ├── waterBalance.ts      # 水分盈亏
│       ├── pest.ts              # 病虫害风险
│       └── index.ts             # 编排：卡片汇总、摘要、当前条件
├── wrangler.toml
├── package.json
├── tsconfig.json
└── functions/tsconfig.json
```

`functions/api/advisony.ts` 通过相对路径 `../../src/decision/index` 引入共享决策模块。这是 Cloudflare 官方支持的用法（参见 [Module support](https://developers.cloudflare.com/pages/functions/module-support/)），`functions/` 目录下的 `.ts` 会由 wrangler 用 esbuild 自动打包，**不需要额外的构建步骤**；共享代码放在 `functions/` 之外，也避免被文件路由当成接口。

---

## 3. 本地开发

前置：Node.js 18+ 与 npm。

```bash
npm install
npm run dev          # 等价于 wrangler pages dev public
```

打开 http://localhost:8787 。

> 本地预览时 `request.cf` 没有真实地理数据，自动定位会失败并提示手动选择城市。
> 想直接看到建议，可用 URL 参数指定坐标：
> `http://localhost:8787/?lat=36.71&lon=119.10&city=潍坊`

类型检查（可选，仓库没有构建产物）：

```bash
npm run check        # tsc --noEmit
```

---

## 4. 部署

任选其一。

**方式 A：wrangler 直传（最快）**

```bash
npm install
npx wrangler login
npm run deploy       # 等价于 wrangler pages deploy public
```

首次执行会提示创建 Pages 项目，项目名取 `wrangler.toml` 中的 `farm-advisor`。

**方式 B：Git 集成**

把仓库推到 GitHub，在 Cloudflare Dashboard → Workers & Pages → 创建 Pages 项目 → 连接仓库：

- 构建命令：留空（`public/` 已是静态资源，`functions/` 由 Pages 编译）
- 构建输出目录：`public`

**自定义域（可选）**：Pages 项目 → 自定义域 → 绑定域名。

部署后在 Dashboard 的 Pages 概览页可以看到请求数与 Functions 调用量，用于监控免费额度。

---

## 5. 接口

### `GET /api/advisony`

| 参数 | 说明 |
| --- | --- |
| `lat`、`lon` | 手动指定坐标；两者同时合法时优先于 IP 定位 |
| `city`、`region` | 手动指定的地名，仅用于展示 |
| `crop` | 作物 id（见 `src/lib/crops.ts`），默认 `general` |
| `force=1` | 跳过缓存读取，强制重新取数（前端有 60 秒冷却） |

成功响应（`ok: true`）主要字段：

```jsonc
{
  "ok": true,
  "generatedAt": "2026-09-20T06:12:33.000Z",
  "location": { "name": "潍坊", "region": "山东省", "lat": 36.71, "lon": 119.1,
                "source": "ip", "timezone": "Asia/Shanghai" },
  "crop": { "id": "corn", "name": "玉米" },
  "current": { "timeLabel": "9月20日 14:00", "temperature": 24.3, "humidity": 62,
               "windSpeed": 2.1, "soilMoisture": 21.4, "soilTemperature": 22.8,
               "precipitation1h": 0, "et0Today": 3.4 },
  "summary": { "level": "warn", "headline": "根区水分偏低，建议灌溉约 18 mm", "focusId": "irrigation" },
  "cards": [
    {
      "id": "irrigation", "category": "灌溉", "level": "warn", "levelLabel": "预警",
      "headline": "根区水分偏低，建议灌溉约 18 mm",
      "reason": "判断依据……",
      "actions": ["建议灌溉量约 18 mm，分次给水……"],
      "metrics": [{ "label": "根区土壤湿度", "value": "18.2 %" }]
    }
  ],
  "notices": ["……"],
  "source": { "weather": "Open-Meteo", "cache": "MISS" }
}
```

失败响应（`ok: false`，HTTP 仍为 200，便于前端统一处理）：

```jsonc
{ "ok": false, "code": "locate_failed", "message": "无法根据网络位置判断你所在的地区，请手动选择城市。",
  "fallback": true }
```

`code` 取值：`locate_failed`（定位失败，可引导手动选城市）、`upstream_error`（气象数据源失败）、`bad_request`、`internal_error`。

### `GET /api/geocode?q=潍坊`

返回 `{ ok: true, query, results: [{ name, region, country, latitude, longitude, timezone }] }`，结果缓存 24 小时。

---

## 6. 决策模型与已知局限

各模块的算法与阈值都写在对应源文件顶部的注释里，要点：

- **数据源**：Open-Meteo Forecast API，一次请求取回逐小时气温/湿度/露点/降水/降水概率/风速/阵风/ET₀/分层土壤湿度/土壤温度，以及逐日最高最低气温/降水/ET₀。`past_days=14` 提供历史序列（注意这是**过去的模式预报**，不是气象站观测）。
- **灌溉**：ETc = ET₀ × Kc；有效降水按 80%；根区土壤湿度取 0–1 / 3–9 / 9–27 cm 按层厚加权；剩余有效水低于 TAW × 触发比例时建议灌溉，灌溉量按灌溉水利用系数 0.8 折算并限幅。
- **霜冻 / 热应激**：用 2 m 气温判定，阈值以上 2 ℃ 区间记为「关注」（晴夜地表温度还会更低）。
- **GDD**：截断法 `max(0, clamp(日均温, 基温, 上限) − 基温)`；**没有播种日期，因此不推断生育阶段**，只报告积温收支。
- **喷洒窗口**：风速 ≤ 5 m/s、阵风 ≤ 9 m/s、无降水且未来 6 小时雨量 < 1 mm、气温 5–32 ℃、降水概率 ≤ 70%、作业时段 5:00–19:00 为硬条件，其余按权重扣分。
- **病虫害**：只用近 3 天温湿与降水条件推断「有利于发生」，未接入田块虫情与区域测报，**等级上限为「预警」，不作为施药依据**。

已知局限（页面上也会如实提示）：

1. 土壤水文参数（田间持水量、凋萎点、根区深度）是作物档案里的经验假定值。**未接入 SoilGrids**，所以灌溉建议是量级正确的参考值，不能替代土壤检测。
2. 水稻以田面水层管理为主，土壤湿度判据对其参考性有限。
3. IP 定位精度约为城市级，且受运营商出口影响，可能落在相邻地市；请用「切换城市」修正。
4. 建议基于公开模式数据，仅供参考，不替代实地农艺指导。

---

## 7. 免费额度与缓存

| 资源 | 免费额度 | 本项目的用法 |
| --- | --- | --- |
| Pages 静态资源 | 无限 | 单页 + CSS + JS，无外部依赖 |
| Pages Functions | 100,000 请求/天 | 仅 `/api/advisony` 与 `/api/geocode` |
| Open-Meteo | 10,000 调用/天 | 缓存 1 小时 + 边缘 `cacheTtl` 600 秒 |
| KV / D1 | — | **不使用**，缓存只用运行时 Cache API |

缓存策略：

- 缓存 key 为 `作物 id + 定位来源 + 纬度(2 位小数) + 经度(2 位小数) + 小时分桶`，同一格网内的用户共享同一份**决策结果**。
  需求文档建议把城市名也放进 key，这里去掉了：坐标相同即同一地点，去掉城市名可提高命中率（自动定位与手动选择常给出同一坐标但不同写法）。
- **缓存体里不含任何请求者相关信息**：只存气象派生的卡片、摘要、当前条件与地块时区；城市名、经纬度、定位来源在每次响应时按当前请求者重新组装。否则同一格网内后到的用户会看到前一个用户的 IP 定位城市名与坐标。
- IP 定位的响应下发 `Cache-Control: private, max-age=300` 并额外加 `CDN-Cache-Control: no-store`：这类请求的 URL 对所有用户都一样，必须阻止 CDN 按 URL 缓存，否则不同地区会串味。手动指定坐标的 URL 自带参数，可 `public, max-age=3600`。
- 前端「刷新」按钮带 60 秒冷却，避免连续点击消耗上游配额。
- 写缓存失败只记 `console.warn`，不影响响应；可用 `npx wrangler pages deployment tail` 观察。

---

## 8. 与需求文档的差异

实现基本按清单执行，以下几处有意做了调整：

1. **入口文件是 `functions/api/advisony.ts`（不是 `.js`）**：Pages Functions 原生支持 TypeScript（wrangler 用 esbuild 编译），因此全站零构建步骤，无需 ts 编译产物。路由 `/api/advisony` 与文档一致。
2. **决策模块放在 `src/decision/`**（与文档第 9 节一致），由 `functions/api/advisony.ts` 相对导入；`src/lib/` 存放共享类型、数据客户端与工具。
3. **未接入 SoilGrids**：改用 Open-Meteo 的土壤湿度/土壤温度，一次请求取全，避免 SoilGrids 的异步轮询与数 MB 响应拖慢首屏；土壤水文参数改用作物档案中的假定值并在卡片上标明。
4. **建议类型做了 7 类**（文档要求至少 3–5 类），把「水分盈亏」与「病虫害」一并实现。
5. **新增 `/api/geocode`**：文档要求「手动切换城市」，需要一个城市检索接口。
6. **缓存 key 不含城市名**，理由见上一节。
7. `functions/tsconfig.json` 是为了避免根 `tsconfig.json` 干扰 Pages 的函数打包（Cloudflare 官方建议做法）。

---

## 9. 扩展：新增作物

在 `src/lib/crops.ts` 的 `CROPS` 数组里追加一份档案（基点温度、上限温度、作物系数 Kc、霜冻/热应激阈值、土壤水文假定、根区深度、灌溉触发比例、病虫害模型），再把 id 与中文名同步到 `public/index.html` 的 `#crop-select` 下拉框即可。

---

## 10. 许可与声明

- 本项目代码仅供个人 / 非商业用途；Open-Meteo 免费层同样限非商业使用，商业用途需另行申请许可或更换数据源。
- 气象数据来源 [Open-Meteo](https://open-meteo.com/)，遵循 CC BY 4.0。
- 网站输出的一切建议仅供参考，不构成农艺指导，不替代实地查勘与当地农技部门的意见。
