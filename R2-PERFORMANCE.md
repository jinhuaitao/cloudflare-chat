# R2 读写性能分析报告

> 对象：`cloudflare-chat` v7.19.0（Cloudflare Worker + R2，Telegram / 微信 / 网页三端共用一条 Agent 链路）
> 目标：在不改变功能与数据格式的前提下，降低每轮对话与每次入库的 R2 往返次数与串行等待。

---

## 一、R2 在这个项目里承担了什么

| Key / 前缀 | 内容 | 读写频率 | 代码位置 |
| :--- | :--- | :--- | :--- |
| `tg_hist_<chatId>` | 对话历史（整对象 JSON，每轮重写） | 每轮 1 读 1 写 | `src/tg-history.js` |
| `kb/mem3/work/<id>.json` | L1 工作记忆 | 每轮 1 读 1 写 | `src/memory/working.js` |
| `kb/mem3/long/<id>.json` | L2 长期记忆（含 `file` 指向 md 镜像） | 每轮 1 读，写少 | `src/memory/longterm.js` |
| `kb/mem3/archive/<id>.json` | L3 归档 | 每轮 1 读，写少 | `src/memory/archive.js` |
| `kb/docs/registry.json` | 知识库注册表（**整表读-改-写**） | 每轮 1 读（30s 缓存），保存时读写 | `src/kb/registry.js` |
| `kb/docs/<标题>.md` | 文档正文（可达 20 万字符） | 检索/阅读时读 | `src/kb/doc-tools.js` |
| `kb/mem/<id>/*.md` | 每条记忆的 Markdown 镜像 | 写（remember 时） | `src/store/kb.js` |
| `kb/versions/<slug>/*.md` | 覆盖前的版本快照 | 覆盖保存时写 | `src/kb/doc-tools.js` |
| `agent_mode_*` / `agent_persona_*` | Agent 开关、专家人格 | 每轮 1 读 | `src/agent/mode.js` |
| `wx_*` / `tg_updates_dedup` | 微信游标、context_token、去重窗口 | 每条消息 1~2 次 | `src/wechat/handler.js` |

一轮对话（冷启动、Agent 模式）实际打出的 R2 操作：**约 8~10 次读 + 2 次写**
（去重窗口、Agent 开关、人格、历史、L1/L2/L3、注册表、模型选择），
其中读全部落在"首字之前"的关键路径上；热缓存时读降到 0，只剩 2 次写。

---

## 二、瓶颈定位（按对延迟/成本的影响排序）

1. **每次 `save_doc` 都做一次全量目录扫描。**
   写路径用 `kbGetRegistry({ fresh: true, verify: true })`：先读注册表，再 `list(kb/docs/)` 核对，漂移时还要把**每篇文档的头 4KB** 全读一遍。list 是 Class A 操作，典型 50~150ms，且与用户等待串行。

2. **版本快照每次都 `list` + 排序 + `delete`。**
   覆盖保存时为了"只留 3 份"，每次都列一遍 `kb/versions/<slug>/`。3 次往返只为删 1 个文件。

3. **记忆冷启动的旧键探测是串行的 3 次 GET。**
   `ltGet` 依次探 `kb/mem3/long/…` → `kb/agent_mem_…` → 根目录 `agent_mem_…`。新用户/新会话三个键全空，等于每次冷加载白打 2 次、且串行叠加 2 个 RTT。

4. **同一轮内重复读同一个 key。**
   `loop.js` 读注册表、工具层 `list_docs`/`read_doc` 又读一次；`memoryLoad` 与 `memoryStats` 也会各读一遍三层记忆。isolate 内完全重复的往返没有任何收益。

5. **没有重试，抖动被当成"没有数据"。**
   `storeGet` 捕获异常后返回 `null`：记忆被当成空（用户发现"它忘了我"）、注册表被当成缺失（触发一次全量重建并覆盖写）。R2 偶发 5xx / 网络抖动时这就是雪崩起点。

6. **缓存 TTL 偏短。**
   记忆 60s、正文 120s。连续对话里每分钟都要回源一次，而写入本来就是穿透更新缓存的。

7. **正文缓存没有版本校验。**
   只能靠短 TTL 保证"别读到旧内容"，于是没法把 TTL 放长，检索反复整篇读。

---

## 三、本次改动

### 1. `src/store/r2.js` —— 全部 R2 流量的统一出口（重写）

| 能力 | 说明 |
| :--- | :--- |
| 瞬时错误重试 | 50ms / 150ms 退避重试 1 次；参数/权限错误不重试。失败才交出 `null`，并把失败计入指标 |
| 单飞（single-flight） | 同一 key 的并发读只打一次 R2（`getShared` 计数可见） |
| 条件写 CAS | `storePutCas(env, key, value, etag)`，预条件失败返回 `conflict`，不支持时自动退化为普通写（绝不因优化丢数据） |
| 范围读 | `storeGetRange`：只取头 4KB，用于注册表重建读 frontmatter |
| list 重试 | `storeList`：列不出来不再被当成"没有文件" |
| 元数据读 | `storeGetMeta` 区分「对象不存在」与「读失败」，后者不再触发重建 |
| 指标 | `r2StatsLine()`，`AGENT_DEBUG_STATS=1` 时随 `[agent-stats]` 一起打印 |

### 2. 三层记忆（`src/memory/*`）

- **单飞**：`wmGet` / `ltGet` / `arGet` 并发调用只回源一次；对外仍返回副本，调用方就地 `push/splice` 不会污染共享快照。
- **旧键探测只做一次**：`ltNoLegacy` 记住"这个 chatId 已确认无旧键"，新会话之后只读新键（省 2 次 GET + 2 个串行 RTT）。
- **迁移写与 md 回补写合并**：旧版首次加载最多写 3 次索引，现在最多 1 次。
- **跳过无变化的写**：L1 内容与上次落盘完全一致时不再 PUT（重复 `/pin`、无实际改动的命令）。
- **TTL 可配**：新增 `MEM_CACHE_TTL_MS`（默认 180s，写入穿透更新缓存）。

### 3. 知识库注册表（`src/kb/registry.js`）

- 读路径带出 `etag`（`kbGetRegistryEx`）。
- 写路径改 **CAS**：`kbSaveRegistry(reg, { expectEtag })`，冲突返回 `false` 且不覆盖；`kbMutateRegistry` 自动"重读 → 重算 → 重写"，最多 3 轮。
- **保存路径不再 `verify`**：用 CAS 承担"防丢更新"的职责，一次 list 都不做。
- 读失败不再触发全量重建（有缓存先用缓存）。

### 4. 知识库文档（`src/kb/doc-tools.js`）

- 保存：`fresh + verify` → `fresh`（CAS 兜底）；正文与快照**并行**落盘；注册表用 CAS 更新。
- 快照清理：注册表记 `vcount`（已保留份数），未到 3 份直接跳过 `list`；`vcount` 未知（注册表重建过）才回退扫描。
- 正文缓存：TTL 120s → 300s、容量 48 → 64，并**按注册表 `updated_at` 校验**（别的实例改过就自动失效）。
- 全库正文检索并发 6 → 10。

### 5. 其它

- `src/utils.js`：新增 `singleFlight`。
- `src/agent/loop.js`：`[agent-stats]` 增加 `r2` 字段，用 `wrangler tail` 即可量化。
- `src/agent/mode.js`：开关/人格缓存 60s → 180s（写入穿透）。
- `wrangler.toml`：补 R2 建桶区域说明（`--location apac`）与可选 Smart Placement。
- `test/r2-perf.test.mjs`：8 个用例把"操作数"钉成断言（单飞 / 重试 / CAS / 保存不再 list / 记忆零回源 / 重复写不产生 PUT）。

---

## 四、量化对比（内存桶计数，确定性可复现）

| 场景 | 改前 | 改后 |
| :--- | :--- | :--- |
| 覆盖保存一篇文档（含快照） | 7~8 次操作，其中 **2 次 list**，全部串行 | **4 次操作**（1 读 + 3 写），**0 次 list**，正文与快照并行 |
| 新建一篇文档（注册表已存在） | 4 次操作 + 1 次 list（verify） | 3 次操作，0 次 list |
| 快照清理（未满 3 份时） | list + 可能的 delete | 0 次操作 |
| 新会话记忆冷加载 | 5 次读，其中 3 次串行 | 首次 5 次（仍并行化处理），**之后 3 次** |
| 一轮内多处读同一 key | 各读一次 | 合并为 1 次 |
| 连续对话（180s 内） | 每分钟回源一次记忆 | 0 次回源 |
| R2 抖动 | 读失败 = 数据为空 → 触发重建/丢上下文 | 自动重试一次；仍失败时区分「读失败」与「不存在」 |

---

## 五、部署侧（不做这些，代码优化只能拿到一半收益）

1. **建桶时选就近区域**（区域建好不能改）：
   ```bash
   wrangler r2 bucket create cloudflare-chat-r2 --location apac
   ```
   亚洲用户单次 R2 往返通常比默认区域少 100ms 以上，而一轮对话要打好几次。
2. **按端选择是否开启 Smart Placement**（`wrangler.toml` 里有注释块）：
   以 TG / 微信 webhook 为主 → 打开，Worker 会被调度到离桶更近的节点；以网页端为主 → 保持关闭。
3. **观测**：`wrangler tail` + `AGENT_DEBUG_STATS=1`，看 `[agent-stats]` 里的
   `r2: R2 get=… put=… 单飞复用=… 重试=… 条件写冲突=…`。冷启动一轮的 `get` 若明显大于 7，说明有模块没走缓存。
4. **成本**：免费额度每月 100 万次 A 类操作（写 / list）。本次改动把"每次保存 2 次 list"和"每分钟一次记忆回源"都去掉了。

---

## 六、后续可选优化（本次未做，附原因）

| 方向 | 收益 | 为什么暂不做 |
| :--- | :--- | :--- |
| 三层记忆合并为单对象 `kb/mem3/<id>.json` | 每轮 3 读 → 1 读 | 写放大 3 倍且三模块共用一份对象，跨版本迁移风险高，建议单独一版做 |
| 知识库正文倒排索引（保存时落 token → 文件） | 冷检索 N 读 → 命中篇数读 | 索引一致性与体积需要额外设计，当前并发 10 + 300s 缓存已够用 |
| `read_doc` 按字节范围读 | 20 万字文档翻页只读 8KB | 字符偏移与 UTF-8 字节偏移不等价，需要额外维护字节偏移表 |
| 对话历史按轮分片（`tg_hist/<id>/<ts>`） | 避免整对象重写 | 读取要 list 分片，读写成本互换，需实测 |
