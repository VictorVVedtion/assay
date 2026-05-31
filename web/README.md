# assay · 照妖镜 — Live Audit Console

> 本地直读 `../data` 的取证仪表台:实时显示审计代理记录的每一笔 LLM 请求/响应(证据)与派生裁决。**零外呼**——只读本机的两个 append-only JSONL 文件,不连任何网络。
>
> *A local-only forensic console for the assay audit proxy. It tails two append-only JSONL files on **this machine** and shows, in real time, every proxied LLM request/response (evidence) and the derived verdicts. **Zero external calls.***

这是仓库根 [README.md](../README.md) / [PHASE0.md](../PHASE0.md) 里"分析面 → `verdicts.jsonl`"那一步的可视化前端。它本身不做网络请求,也不调用上游——只把本机已有的证据与裁决渲染出来,并在浏览器里**独立重算**每条记录的哈希(`lib/digest.ts`,与 Go/Python 实现字节一致)。

---

## 快速开始 · Getting started

```bash
# 从仓库根:
make dashboard            # = cd web && npm install && npm run dev

# 或在 web/ 内:
npm install
npm run dev               # http://localhost:3000
```

打开 http://localhost:3000。**默认进入 Demo 模式**——内置一份确定性、符合 schema 的样例数据,无需任何后端即可讲完整故事:

- token_recount **CRITICAL**(可见输出 > 计费)与 **WARN**(计费 ≫ 可见,充值膨胀)
- provenance **WARN**(套壳 / masquerade,score 0)
- exposure **WARN**(请求体里泄露的 `sk-` 密钥,按"下界"计数)
- cache_replay **FLAG**(同一长响应服务了两个不同请求)
- token_recount **SKIP**(Claude `/v1/messages` 与 Gemini `:generateContent`——无公开分词器,skip 属正常)
- 一条流式 SSE 记录 + 一条非流式记录,全部用同一套 TS canon 正确哈希链接
- TopBar 里的 **BREAK 注入开关**:在某个 seq 上篡改一条已哈希的记录 → 链校验为 `BREAK` → 整个 UI 进入醒目的 **TAMPER** 状态

> Open it and you land in **Demo mode** by default — a bundled, deterministic, schema-faithful dataset that tells the whole story with zero setup. A toggle injects an evidence-chain BREAK to demonstrate the tamper state. Every demo record is hash-chained with the same TypeScript `canon()` the Go data plane uses, so the in-browser digest recompute shows VALID.

---

## Live 模式 · reading real `../data`

仪表台从 **`ASSAY_DATA_DIR`**(默认 `../data`,即仓库根的 `/data`)读取两个文件:

| 文件 | 内容 |
|------|------|
| `evidence.jsonl` | 每行一条 `EvidenceRecord`(哈希链,不可变) |
| `verdicts.jsonl` | 每行一条 `VerdictRecord`(派生,不入哈希链) |

**自动选源**:`evidence.jsonl` 存在且非空 → **Live**(直接读它们);否则 → **Demo**。TopBar 的 Demo/Live 开关可强制任一来源(强制 Live 而文件为空时,会诚实地显示 `EMPTY` 链 + 零行,而非偷偷回退到 Demo)。

要看真实数据,先让数据面 + 分析面在写这两个文件(见仓库根 README 的 `make build` / `make e2e`),然后:

```bash
# 默认:web/../data == 仓库根 /data
npm run dev

# 或显式指定一个数据目录(绝对路径,或相对 web/ 即 process.cwd())
ASSAY_DATA_DIR=/abs/path/to/data npm run dev
ASSAY_DATA_DIR=../some/other/data npm run dev
```

`/api/stream`(SSE)会 **tail** 这两个文件并实时推送新行;`/api/snapshot` 给出首屏全量;`/api/verify` 用 Web Crypto 在 **TypeScript 里**重算整条链(不 shell 调 Go 二进制)。三个路由都 `runtime = "nodejs"` + `force-dynamic`,只读本机文件。

> **Live mode** auto-activates when `../data/evidence.jsonl` is non-empty. `ASSAY_DATA_DIR` overrides the directory (absolute, or relative to `web/` i.e. `process.cwd()`). The SSE route tails the files for new lines; `/api/verify` recomputes the whole hash chain in TypeScript with Web Crypto — never shelling out to Go.

---

## 构建 · Build

```bash
make dashboard-build      # = cd web && npm install && npm run build
# 或：
npm run build && npm run start   # 生产构建 + 启动 (PORT 可改端口)
```

其他脚本:

```bash
npm run typecheck         # tsc --noEmit（类型检查在 next build 里也会跑)
npm run digest:check      # 用 testdata/digest_vectors.json 校验 TS digest 端口
npm test                  # node --test：digest 向量的黄金对比(canon + hash)
```

---

## 零外呼 / 本地优先 · Zero external calls

这是产品的诚实底线,也是技术约束:

- **不取任何 webfont**——字体用纯 CSS 字体栈(`globals.css`),没有构建期或运行期的网络请求。
- **不连上游、不连遥测**——浏览器端唯一的网络是到本应用同源的 `/api/*`,服务端只 `fs.read` 本机的 JSONL。
- ScopeBanner(诚实边界横幅)**始终可见、不可移除**:Phase 0 只验 token 诚实度 + 朴素缓存 + 泄露下界 + 上游来源;**不验模型身份**。"无 flag" ≠ "正品 / 安全"。

> The console makes **zero external calls** by design — pure-CSS font stacks (no webfont fetch), no upstream/telemetry, the only network is same-origin `/api/*` reading local JSONL. The always-on ScopeBanner states the honest limits: Phase 0 does NOT verify model identity, and "no flags" is not a clean bill of health.

---

## 这不是你熟悉的 Next.js · Note

本工程用 **Next.js 16 (Turbopack)**,与训练数据里的约定可能不同(详见 `web/AGENTS.md`)。其中两点值得知道:Next 16 已把 ESLint 从 `next build` 解耦(`next lint` 移除,lint 只在独立 `eslint .` 里跑),所以 lint 不会阻断构建;TypeScript 类型检查仍**开启**(`next.config.ts` 里 `typescript.ignoreBuildErrors: false`)。
