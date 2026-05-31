# Phase 0 — 冻结契约 (Frozen Contracts) · v0.2

> 项目 `assay` / 照妖镜 的 Phase 0「免基准地板」。本文件是**契约**:Go 数据面与 Python 分析面只通过这里定义的 schema 通信;实现以此为准。
>
> **v0.2** = 把 6 路设计红队的 15 blocker / 30 major 全部折叠进来。每条关键修订标注来源 `[RT:lens]`。范围标注 **[MVP]**(本期必做)/ **[DEFER]**(记录在案,后续)。背景见 [DESIGN.md](DESIGN.md)。

## 0. v0.2 相对 v0.1 的关键变更(red-team 折叠)

1. **[RT:streaming]** 上游请求**剥离 `Accept-Encoding`**,使响应为 identity 编码 → 捕获到的就是干净 UTF-8,所有分析器可直接用。新增 `response.raw_encoding`(utf8|base64)兜底。
2. **[RT:streaming/fail-open]** 捕获**不用 `io.TeeReader`**。显式 copy-loop:**先 flush 给 client,再**把副本**非阻塞**塞进有界 channel,由**单独 writer goroutine**消费。过载时**丢证据,绝不拖慢用户**。
3. **[RT:fail-open]** 哈希链**完全离开请求路径**:请求 goroutine 只交出**未链接**的记录;writer goroutine 串行分配 `seq`、算 `prev_hash`/`hash`、落盘。
4. **[RT:evidence-integrity]** **弃用 JCS**,改用**自定义长度前缀类型化 digest**(见 §4),跨语言可复现。时延一律存**整数微秒**,杜绝浮点哈希分歧。
5. **[RT:detection/api]** `token_recount` 必须处理 **reasoning tokens / prompt caching / tools / images**:这些情形 → `estimate_only` 或 `skip`,**绝不硬判作弊**。按 path+provider+模型白名单路由。
6. **[RT:detection]** `cache_replay` 重定义为「**不同请求 → 雷同长响应**」,用 SQLite 索引 + 滚动窗口;降级为弱启发式。
7. **[RT:detection]** `throughput` 在 Phase 0 仅作 **info/telemetry**,不独立判定。
8. **[RT:detection]** 评分卡**必须醒目声明:Phase 0 只验 token 诚实度 + 朴素缓存,绝不验模型身份(那是 Phase 1)**。
9. **[RT:fail-open]** 上游用自定义 `Transport` 配超时;流式不设 `Client.Timeout`。
10. **[RT:evidence-integrity]** 诚实:本地哈希链是**防误改(tamper-evident)**,**非**对持有者防篡改;dispute 级需外部锚定(§4 [DEFER])。

## 1. 范围 / 非目标

**[MVP]**:零可信上游即可用——透传式 OpenAI 兼容审计代理(fail-open)、`token_recount`、`provenance`(Phase 0.5)、`cache_replay`、`throughput`、哈希链 append-only 证据 + 可复现校验。

**[DEFER]**:LLMmap 主动指纹、MMD 分布检验、社区指纹库、new-api DB 对账、Claude/Gemini 用量重算、外部时间戳锚定、body 加密静存、保留/轮转、Web 看板。

## 2. 数据流 + 并发模型(fail-open 的工程化,非口号)

```
client ─req─▶ [request goroutine] ───────────────▶ upstream(中转站)
                │ 1. 剥离 Accept-Encoding 转发上游(→identity)
                │ 2. copy-loop:每读一块 → 先 write+Flush 给 client
                │ 3. 再把"副本块"非阻塞塞进 cap chan(满则丢+计数)
                ▼ (client 路径到此为止,绝不依赖下面任何一步)
        [capture chan, 有界] ──▶ [单 writer goroutine]
                                   分配 seq → 脱敏 → 算 prev_hash/hash → 缓冲写 evidence.jsonl
                                          │
                                          ▼
                                   evidence.jsonl (append-only, 哈希链, flock 单写者)
                                          │ seq-checkpoint tail
                                          ▼
                                   [assay-analyzer : Python] → verdicts.jsonl
```

**铁律 [RT:streaming/fail-open]**:
- client 的 request/response 路径**只**依赖「转发 + flush」。捕获、脱敏、哈希、落盘**全部**在 client 路径之外。
- 请求 goroutine 向 capture chan **非阻塞** send:`select { case ch<-rec: default: dropped++; tee_ok=false }`。**过载丢证据,不丢用户**。
- 任何捕获/分析失败 → 该记录 `capture.tee_ok=false`,继续服务。

## 3. EvidenceRecord(`evidence.jsonl`,每行一条)

```jsonc
{
  "v": 1,                         // 行首,便于预路由 [RT:contract-ops]
  "seq": 0,                       // 单调递增 int,从 0;由 writer goroutine 分配
  "id": "<uuidv7>",
  "ts_start": "<RFC3339Nano>",    // proxy 收到 client 请求的时刻
  "prev_hash": "<64 hex>",        // 上一条的 hash;创世 = 64 个 '0'
  "hash": "<64 hex>",             // = sha256(canon(record))  见 §4

  "route": {
    "method": "POST",
    "path": "/v1/chat/completions",
    "upstream": "https://relay.example.com",
    "claimed_model": "gpt-4o",          // 解析自 request body.model;可能为 null
    "provider": "openai",               // openai|anthropic|gemini|unknown  [RT:api]
    "api_surface": "chat.completions"   // chat.completions|responses|embeddings|messages|generateContent|other
  },

  "request": {
    "headers": { },               // 脱敏后(见 §10);key 小写
    "raw": "<请求体原始字符串>",    // identity 编码,UTF-8
    "raw_encoding": "utf8",        // utf8|base64(非 UTF-8 时 base64 兜底)
    "bytes": 1234,                 // 真实总字节(即使被截断也是真值)
    "truncated": false
  },

  "response": {
    "status": 200,
    "headers": { },
    "stream": true,
    "content_encoding": null,      // 上游回的 Content-Encoding(剥离 AE 后应为空/identity);仅记录,不可信
    "raw": "<响应体或拼接后的 SSE 文本>",
    "raw_encoding": "utf8",        // [RT:streaming] 兜底字段
    "bytes": 5678,                 // 真实总字节
    "truncated": false,            // [RT:streaming] 仅截断"捕获副本",client 流永不截断
    // 派生、不可信,仅便利(同样进 hash):
    "claimed_usage": {             // 流式仅当 include_usage 才有;否则 null [RT:api]
      "prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33,
      "completion_tokens_details": { "reasoning_tokens": 0 },   // 若上游提供 [RT:detection]
      "prompt_tokens_details": { "cached_tokens": 0 }
    },
    "claimed_model": "gpt-4o",
    "system_fingerprint": "fp_xxx"
  },

  "timing": {                      // [RT:streaming] 整数微秒,杜绝浮点
    "ttft_us": 412300,             // 见 §3.1 精确定义;非流式 = null
    "total_us": 1875000,
    "stream_chunks": 23,           // 仅计 choices 非空的 data 事件(排除 [DONE] 与 usage-only)
    "conn_reused": false,
    "upstream_connect_us": 84000   // TLS+TCP;复用为 0;httptrace 采集
  },

  "capture": {
    "tee_ok": true,                // false = 捕获不完整(过载丢弃/脱敏失败/解码失败)
    "client_disconnected": false,  // [RT:streaming] drain-mode 见 §3.2
    "note": null
  }
}
```

### 3.1 TTFT 精确定义 [RT:streaming]
`ttft_us` = 从「最后一个请求字节写入上游」到「**首个携带非空 `delta.content` 的 SSE 事件**」(非流式:首个非空白响应体字节)。**非流式响应 `ttft_us = null`**(否则等于 total,无意义)。用 `httptrace.ClientTrace`(`WroteRequest`/`GotConn`/`GotFirstResponseByte`)分解。TTFT 是**弱/上下文信号**,分析器不得据此硬判。

### 3.2 client 断连 → drain-mode [RT:streaming] **[MVP-SHOULD]**
client 中途断开时,**解耦上游读与 client context**:切到 drain 模式,用后台 context(带超时 + `max_body_bytes` 上限)把上游读到 EOF,以便捕获完整响应**与尾部 usage 事件**;记 `capture.client_disconnected=true`。这本身也是欺诈信号(中转站在断连后仍生成/计费?)。

### 3.3 max_body_bytes 语义 [RT:streaming]
cap **只**作用于「捕获副本」,**client 流永不被 cap 截断**。副本超 cap 后:停止追加但**继续计数**(`bytes` 为真值),置 `truncated=true`。分析器对 `truncated=true` 一律 **skip**(转写不完整 → 非证据)。注:usage 事件在 SSE **末尾**,故纯头部截断会丢它 → MVP 把默认 cap 调大(8 MiB),尾部保留为 [DEFER]。

## 4. 哈希:自定义类型化 digest(可复现取证根基)[RT:evidence-integrity]

**弃用 JCS**(浮点/NFC/键序跨语言不可靠)。改用显式长度前缀编码 `canon`,Go/Python 各实现一份并由**共享测试向量**(`testdata/digest_vectors.json`)在双语 CI 互测。

编码原语(大端):
- `u64(n)` = 8 字节大端无符号。
- `b(x)` = `u64(len(x)) || x`(x 为字节串)。
- `s(str)` = `b(utf8(str))`。
- `opt_u64(n?)` = `\x00` 若 null,否则 `\x01 || u64(n)`。
- `opt_s(str?)` = `\x00` 若 null,否则 `\x01 || s(str)`。
- `u8(bool)` = `\x00`/`\x01`。
- `hmap(headers)` = `u64(n) || 对 key 升序: s(lower(key)) || s(value_join_by_"\n")`。

`canon(record)` = 按**固定顺序**拼接(域分隔符开头):
```
s("assay-evidence-v1")
u64(seq) || s(id) || s(ts_start) || s(prev_hash)          // prev_hash 用其 64-hex 字符串
// route
s(method)||s(path)||s(upstream)||opt_s(claimed_model)||s(provider)||s(api_surface)
// request
hmap(req.headers)||s(req.raw)||s(req.raw_encoding)||u64(req.bytes)||u8(req.truncated)
// response
u64(status)||hmap(resp.headers)||u8(stream)||opt_s(content_encoding)
||s(resp.raw)||s(resp.raw_encoding)||u64(resp.bytes)||u8(resp.truncated)
||canon_usage(claimed_usage)||opt_s(resp.claimed_model)||opt_s(system_fingerprint)
// timing
opt_u64(ttft_us)||opt_u64(total_us)||u64(stream_chunks)||u8(conn_reused)||opt_u64(upstream_connect_us)
// capture
u8(tee_ok)||u8(client_disconnected)||opt_s(note)
```
`canon_usage(u?)` = `\x00` 若 null,否则 `\x01 || opt_u64(prompt)||opt_u64(completion)||opt_u64(total)||opt_u64(reasoning_tokens)||opt_u64(cached_tokens)`。

`record.hash = hex(sha256(canon(record)))`。`prev_hash` 已在 canon 内 → 链被强制。创世 `seq=0` 的 `prev_hash="0"*64`。

**为何可复现**:无浮点(时延整数 µs)、无 JSON 再序列化歧义(直接哈希存储字节)、无 unicode 规范化(哈希存储的原始 UTF-8)。JSON 仅需无损往返整数/字符串/null(天然成立)。

**校验** `assay verify`:逐条重算 hash,检查 `rec[n].prev_hash == rec[n-1].hash`,把结果分三类 [RT:evidence-integrity/fail-open]:`VALID` / `TORN_TAIL`(末行残缺=崩溃,可恢复)/ `BREAK@seq`(中段断裂=篡改)。

### 4.1 外部锚定 [DEFER,但 MVP 留钩子]
本地链可被有写权者整体重算 → **非** dispute 级铁证。**[MVP-SHOULD]**:可选 Ed25519,对周期性「链头」签名,并把链头 hash 同时 emit 到独立 `anchors.log` + stdout(抬高篡改成本)。**[DEFER]**:RFC3161 TSA / OpenTimestamps→Bitcoin。文档须如实说明本地链证明边界。

## 5. VerdictRecord(`verdicts.jsonl`,派生、可复现,**不**入证据链)

```jsonc
{
  "v": 1,
  "record_id": "<evidence id>", "record_seq": 0,
  "record_hash": "<64 hex>",      // 绑定确切证据 → 可复现
  "check": "token_recount" | "cache_replay" | "throughput",
  "analyzer_version": "0.1.0",
  "ts": "<RFC3339Nano>",
  "status": "ok" | "flag" | "skip" | "error",
  "severity": "info" | "warn" | "critical",
  "summary": "...",
  "detail": { /* §6 */ }
}
```

## 6. 各 check 规则(red-team 重写)

### 6.1 token_recount —— 仅对**真·OpenAI** chat 给强结论 [RT:detection/api]
**先判可重算性(elig),不可算就 `skip`,绝不臆测**:
- `provider=="openai"` 且 `api_surface=="chat.completions"`;模型经**前缀表**(§6.4)解析到 encoding;**否则 skip**(`reason:"non-openai/unsupported surface"`)。注:中转站声称 `gpt-4o` **可能是任何东西** → prompt_token 吻合只是弱证据,**不吻合也可能是 framing 而非欺诈**。
- 流式且无 `claimed_usage`(未开 include_usage)→ `skip`(`reason:"no usage in stream"`)。可选 [MVP-SHOULD] 配置项 `inject_include_usage` 向上游注入(破坏纯透明,默认关)。
- `truncated==true` → `skip`。
- **reasoning / 多模态 / 缓存 → `estimate_only=true`,抑制 headline delta,severity 封顶 `info`,绝不 warn/critical**:
  - `completion_tokens_details.reasoning_tokens>0`(或模型在 reasoning 白名单):recomputed 完成数加上 reasoning_tokens 才比;无 breakdown → skip。
  - 请求含 tools/functions、image、audio:set estimate_only;vision tiling 公式 [DEFER]。
  - `prompt_tokens_details.cached_tokens>0`:只比 prompt 总和,不据 prompt_tokens 单独判。
- 重算复刻 Chat framing:`tokens_per_message=3`/`tokens_per_name=1`/回复 `+3`(旧 `gpt-3.5-turbo-0301`=`4`/`-1`)。constants 非永恒,按模型版本维护表。
- **自适应容差**:`max(5 tokens, tolerance_pct%)`,吸收 framing 噪声。仅 `status:"flag"` 当超容差且非 estimate_only。

detail:`{provider,encoding,api_surface,eligible,estimate_only,claimed{...},recomputed{...},delta{...},delta_pct{...},tolerance,reason}`

### 6.2 cache_replay —— 弱启发式,重定义 [RT:detection]
只判「**请求实质不同、却给出雷同长响应**」:
- `req_fingerprint = sha256(normalize(request))`;`resp_fingerprint = sha256(normalize(response_text))`。
- 同一 `resp_fingerprint` 对应**≥2 个不同 `req_fingerprint`** 且 `normalized_len ≥ min_normalized_len` → `flag`。
- 同 prompt → 同输出(尤其 temp=0)是**正常**,不报。temp>0 下不同请求得雷同输出最可疑(记录温度加权)。
- 索引落 **SQLite**(§8),滚动窗口 = 检测视野(文档写明)。near-dup(minhash)[DEFER]。

detail:`{resp_fingerprint,normalized_len,distinct_request_count,first_seen_record_id,window,temperature,reason}`

### 6.2.5 provenance —— 上游来源核验(Phase 0.5,真实测试催生)
**动机**:`token_recount` 只对 OpenAI 强,对 Claude/Gemini/DeepSeek 一律 skip——而这些恰是中转站主流。`provenance` 填这个洞:**被动**读已捕获的响应头 + body 标记,评估"这家是否真的代理到了它声称的上游"。
**真实证据来源**(某 new-api 中转站实测):即便 new-api 把 body 重包成 OpenAI 格式,真·Anthropic 上游仍透出 `anthropic-ratelimit-*`、`anthropic-organization-id`、`request-id: req_...`、body `id: msg_...`;new-api 自身漏出 `x-new-api-version`、`x-oneapi-request-id`、`usage.usage_source=anthropic`。
**评分**:每个 provider 一组带权签名(见 `provenance.py`),`score >= strong_floor` → ok;`0 < score` → 弱 provenance warn;`score == 0` → 无任何原生标记 warn(疑似套壳)。
**诚实边界(必须进 verdict)**:① 标记**可伪造**,故"pass" = "与真上游一致",**绝非**"已证明为真";② 缺标记是**怀疑非定罪**(中转站可能自行 strip 头);③ 它**不说哪个模型**服务了你(真 Anthropic 端点照样能拿 haiku 冒充 opus)——模型身份是 Phase 1。
**隐私**:`set-cookie` 已加入默认脱敏(上游经 Cloudflare 会下发 `_cfuvid` 会话 cookie,是 secret 非 provenance 信号)。

### 6.3 throughput —— 仅 telemetry [RT:detection]
计 `tokens_per_s = completion_tokens_used / gen_us`、`ttft`。Phase 0 **默认 `status:"info"`**,只对**物理不可能**(超极保守硬上限)才 `flag`。建每端点自身基线用于异常对比 [DEFER],不与绝对 ceiling 死磕。

detail:`{completion_tokens_used,gen_us,tokens_per_s,ttft_us,model_class_ceiling_tps,flag,reason}`

### 6.4 tiktoken 模型→encoding 前缀表 [RT:api]
有序前缀匹配 + 安全兜底:`o1*/o3*/o4*/gpt-4o*/gpt-4.1*/gpt-5* → o200k_base`;`gpt-4*/gpt-3.5* → cl100k_base`;`text-embedding-3* → cl100k_base`。**未知模型 → skip(不臆测)**。pin tiktoken 版本;`encoding_for_model` KeyError → skip。表集中、数据驱动、单测。

## 7. proxy 配置(`assay.yaml`)

```yaml
listen: ":8080"
fail_open: true                    # 恒 true,列出以示明确
upstreams:
  - path_prefix: "/"               # MVP:单上游;多上游/模型路由 [DEFER]
    target: "https://your-relay.example.com"   # 见 §9 path-join 语义
    forward_auth: true             # 原样透传 client 的 Authorization
strip_accept_encoding: true        # [RT] 让上游回 identity,便于捕获
inject_include_usage: false        # [RT][MVP-SHOULD] 向流式上游注入 stream_options.include_usage
timeouts:                          # [RT:fail-open] 自定义 Transport;流式不设整体 Client.Timeout
  dial_ms: 10000
  tls_handshake_ms: 10000
  response_header_ms: 60000
  stream_idle_ms: 120000           # 每收到一块就重置
capture:
  max_body_bytes: 8388608          # 8 MiB;仅截断捕获副本
  channel_size: 4096               # 有界;满则丢证据(非阻塞)
  drain_on_disconnect: true
evidence:
  path: "./data/evidence.jsonl"
  flush_every_records: 64
  flush_every_ms: 500
  fsync: false                     # 速度优先;true 更耐久
  file_mode: "0600"                # [RT:privacy]
  redact_headers: ["authorization", "x-api-key", "api-key", "cookie", "proxy-authorization"]
  redact_query_keys: ["key", "api_key", "access_token"]   # [RT] Gemini ?key=
  anchor_log: "./data/anchors.log" # [MVP-SHOULD] 链头
  # signing_key: "./data/anchor.ed25519"   # 可选
analyzer:
  verdicts_path: "./data/verdicts.jsonl"
  index_db: "./data/analyzer.sqlite"        # cache_replay 索引 + checkpoint(last seq)
  cache_replay: { min_normalized_len: 64, window_days: 7 }
  token_recount: { tolerance_pct: 4.0, min_abs_tokens: 5, reasoning_models: ["o1","o3","o4","gpt-5"] }
  throughput: { model_class_ceiling_tps: { default: 2000 } }   # 极保守硬上限
```

## 8. Go↔Python 交接 [RT:contract-ops]

- Go append `evidence.jsonl`(**flock 单写者**;O_APPEND;每记录一次缓冲写;启动时截断残缺末行并从最后完好行恢复 `seq`/`prev_hash`)。
- Python analyzer **tail**:只处理**以 `\n` 结尾**的完整行;边读边校验 `prev_hash` 链;**轮转感知**(inode/size 变化则重开),按 **seq** 续(非字节偏移);单分析器(verdicts 上 lockfile)。
- 有状态的 `cache_replay` 索引落 **SQLite**(crash-safe);`replay` 子命令**清库重建**,保证与 live 逐条一致。
- checkpoint = last-processed **seq**(存 SQLite)。

## 9. 命令 & 部署 [RT:contract-ops]

| 命令 | 作用 |
|---|---|
| `assay proxy --config assay.yaml` | 数据面;启动自检:用一次廉价 upstream 调用打印 OK/401 |
| `assay verify --evidence evidence.jsonl` | 链校验,分类 VALID/TORN_TAIL/BREAK@seq |
| `assay-analyzer run --config assay.yaml` | tail + 实时分析 |
| `assay-analyzer replay --evidence evidence.jsonl` | 清库**从零重算全部 verdict**(任何人可复现) |
| `assay report --verdicts verdicts.jsonl` | 评分卡 |

**path-join 语义(MVP)**:`target` **不含** `/v1`;client 发 `/v1/chat/completions`,proxy 转发到 `target + 原始 path`。文档与启动校验都明确这一条,避免双 `/v1/` 与 401。

**评分卡覆盖声明(强制)[RT:detection]**:report 顶部必须印——
> ⚠️ Phase 0 只验证 **token 计数诚实度** 与 **朴素缓存重放**。它 **不验证模型身份**(模型是否被降级/套壳是 Phase 1:LLMmap/MMD)。"全绿" **不代表**你拿到的是正品模型。

**docker-compose [RT:contract-ops]**:analyzer 对 `./data` 只读(verdicts 走单独卷或由 proxy 代写)、同一非 root uid、`umask 0077`、镜像/日志大小限制、`.dockerignore` 含 `data/` 与 `assay.yaml`。

## 10. 隐私 [RT:evidence-integrity/privacy]

- `evidence.jsonl` 含**明文 prompt 与输出**——最敏感数据。默认**仅本地** + `file_mode 0600`。
- 脱敏在 **writer goroutine**(热路径之外),**默认拒绝**式:header 名大小写不敏感匹配;值层 scrub `Bearer `/`sk-` 前缀;**URL query**(`?key=` 等)也 scrub。脱敏出错则丢该记录 body(`tee_ok=false`),**绝不冒泄露风险**。须有「无已知密钥模式残留」测试。
- **[DEFER]**:body 加密静存(age/NaCl secretbox)、PII 正则、保留 TTL、元数据/body 分离存储(使链+verdict 可在不泄明文下分享)。这些是「必须自托管、不能做 SaaS」的延伸。

## 11. 版本 [RT:contract-ops]

两类记录带 `v`(置于行首便于预路由)。analyzer 处理所有 `v ≤ 自身上限`;遇到更高 `v` **响亮告警(健康降级)而非静默 skip**。仅加可选字段时不 bump `v`;破坏性变更才 bump,旧 `v` 永远可读。
