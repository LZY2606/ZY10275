# MPEG-TS 审阅台（浏览器内）

播出链路排障用：一段可能丢包、重复、乱序、中途切表的 MPEG transport stream，
在浏览器里逐 packet 审阅 **188/192/204 封装、PSI 代次、PID 映射、PCR 时钟与缺口归属**。

所有分析按**文件中的原始 packet 序号**进行，从不按 PID 重排——节目切换、section
跨包、错 CRC、PCR 回绕都保留在真实时间线上。

## 安装

```sh
corepack pnpm install --frozen-lockfile
```

运行环境：Node.js ≥ 22（使用内置 `node:sqlite`，无需原生编译）。

## 自动化测试

```sh
corepack pnpm test -- --run
```

20 个用例覆盖：188/192/204 封装检测、PAT/PMT 代次边界（含版本回滚）、跨三包
section 重组、重复包与真实丢包区分、discontinuity 只影响单个 PID、PCR 33 位回绕
展开、错 CRC section 不污染上一代映射、未知 stream_type/descriptor 原值保留、SQLite
迁移与往返持久化。

## 演示

```sh
corepack pnpm dev --host 127.0.0.1 --port 5975
```

打开 <http://127.0.0.1:5975>，页面顶部即“**节目时钟图**”。默认自动加载内置样例，
也可用“打开 TS 文件”上传任意 `.ts/.m2ts`。点击时钟图 / PID 时间线 / 事件表任意位置，
右侧显示该 packet 当刻生效的 PID→节目映射与 packet 头详情。

生成样例二进制（可选）：

```sh
corepack pnpm fixture data/sample.ts
```

## 样例包含的场景（23 个 packet，序号固定）

| packet | 内容 |
| --- | --- |
| 0 | PAT v0：节目 1 → PMT `0x0100` |
| 1 | PMT v0：PCR/视频 `0x0101`(0x1B)、音频 `0x0102`(0x0F)、未知类型 `0x81` on `0x0103`（含 descriptor） |
| 2 | 纯 adaptation 包，携带 PCR（不推进 CC） |
| 3,5,7,10 | 视频 PES/数据，CC=0,1,3,4（**6 是 1 的合法重复**，**7 前丢了 CC=2**） |
| 6 | 合法重复 payload |
| 8 | 音频纯 adaptation + discontinuity indicator |
| 9 | 音频 CC=7（因 discontinuity 合法重置；视频 CC 不受影响） |
| 11 | PCR，33 位 base 回绕前 5 秒 |
| 12–14 | PMT v1 section **跨三个包**（完成处生效，新增 0x03/`0x0104`） |
| 15 | PMT v2 但 **CRC 损坏**：拒绝，不产生代次，上一代映射继续可用 |
| 16 | PMT **版本回滚**到 v0：仍开新一代（按到达顺序，不按版本号大小） |
| 17 | PCR，回绕后 5 秒（展开时钟单调递增） |
| 18 | PAT v1：节目切到 PMT `0x0200` |
| 19–20 | 新 PMT、新 PCR PID `0x0201`，PCR 归属到当刻节目 |
| 22 | 纯 adaptation 包携带 OPCR |

## 关键实现约定

- **CC 规则**：只有携带 payload（AFC=1/3）的 packet 递增并校验 CC；同值为合法重复
  (`duplicate`)，跳号为真实缺口 (`gap`，含丢失数）；adaptation-only 包不触碰 CC；
  某 PID 的 discontinuity 只豁免该 PID 下一 payload 包，不重置其他 PID。
- **PSI**：按 PID 独立重组 section，校验 pointer field 边界、section_length 上限与
  MPEG-2 CRC32；CRC 错的 section 直接丢弃。
- **代次**：`current_next=1` 且内容（含版本）变化即开新代，生效点取 section 完成包。
- **PCR**：按 PID 独立展开 33 位 base × 300 + ext 的 27MHz 时钟（半周阈值判回绕）。
- **未知类型**：`stream_type` 数值与 ES descriptor 原始字节原样保留。

## 结构

- `src/core/` — 纯 TypeScript 解析核心（封装检测、包头、CRC、section 重组、代次/CC/PCR 分析）
- `src/fixtures/sampleStream.ts` — 内置样例构造器
- `src/server/` — `node:sqlite` 存储 + Vite dev-server API 插件（`migrations/` 下 SQL 迁移）
- `src/ui/` — Canvas 前端（节目时钟图、PID 时间线、事件表、当刻映射检查器）
- `tests/` — Vitest 用例
