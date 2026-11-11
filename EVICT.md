# bili-context-evict — 通用上下文驱逐插件

> 这是 `billion-context` v0.1.212 的一个独立分支，增加了「块级驱逐」层。
> **本插件不依赖任何外部记忆系统**，可以单独安装使用。
> 上游：`github.com/ranxianglei/billion-context`，MIT，`Copyright (c) 2026 ranxianglei`。`LICENSE` 原样保留。

---

## 一、先读这一段：假性「失忆」风险

**本插件不提供记忆系统，也不提供检索记忆的工具。**

它做的事只有一件：把封盘线之前的对话原文，从**发给模型的上下文**里拿掉，换成一行 `[evicted: …]` 标记。模型从此看不到那些内容，也不会有工具自动帮它找回来。

因此，如果接入方没有自己的记忆系统和检索工具，模型在长会话里会**想不起早期上下文**，表现上像是「忘了」——我们称之为**假性失忆**。这是使用前必须知道的代价：

- 需要早期细节时，模型不会自动去翻；
- 摘要和 `[evicted]` 标记不包含原文细节，模型无法据此还原；
- 会话越长、驱逐越多，这个现象越明显；
- 想避免它，接入方需要自己提供「写入归档 + 按需检索」的工具链（本插件不提供，也不假设你用哪一套）。

**但不会真的失忆。** 每个 session 的 `index.db` 都保留完整会话记录：

- 每条消息的完整 JSON 以 `content.bytes` 存在 `content` 表，`messages` 表通过 `content_hash` 引用；
- 驱逐只改**内存里的 messages/state 视图**，不删磁盘数据，也不写 `DELETE`；
- `evict-db.ts` 打开 `index.db` 时用 `PRAGMA query_only=ON`，插件对账本只读。

真的需要时，可以翻回来：

| 途径 | 说明 |
|---|---|
| `bili-evict export <session> --full` | 输出 `### Original messages`（上游原始命令为 `bili export … --full`） |
| Web 会话详情 | `/detail`、`/block/content`、`/message` 端点，`full` 视图 = 每一条原始消息 |
| 直接查 `index.db` | `content.bytes` + `messages` 表；另有 `*.content-store.json` 边车快照 |

**一个诚实的例外**：没有持久化请求快照、且消息从未被压进 block 的 v2 会话，原文不可导出（`src/export.ts` 里明确提示 `conversation content is not available for export`）。所以不能承诺 100% 可翻——**`sleep.json` 里的 `archived` 归档才是第一道保险**。请务必在驱逐前自己留好底。

另外，跑过 `sessions rm` / `storage gc` / 手工清理归档之后，原文当然就没了。

---

## 二、能力边界（本版本只做这三件事）

| 能力 | 说明 |
|---|---|
| **摘要压缩** | 上游 `acp-kernel` 既有能力，把旧对话改写成分层摘要。压内容，不减条数。 |
| **工具结果裁剪** | `dropToolResults`：水位过线时把更早的 tool-result 正文换成一行占位符；保留最近 `keepToolResultRounds` 轮；小于 `minToolResultChars` 的不动。只裁工具结果，对话原文/摘要块一概不动。 |
| **块级驱逐** | 封盘线之前的完整「回合」（一条 user + 其后的 assistant/tool 段）整块换成 `[evicted: …]`。已折叠的 active 摘要块也能被驱逐。 |

**本版本不做**（别指望它）：

- 不写记忆、不做语义检索、不做跨会话召回；
- 不自动判断「内容是否已归档」——判定权完全交给 `sleep.json`，你写错它就会跟着错；
- 不自动把驱逐掉的内容重新注入上下文；
- 不提供通用的宿主挂载抽象（当前挂在 `prepare-anthropic` / `prepare-openai` 两条请求 lane）；
- `persistCheck`（annotated / coverage / memory-mtime / auto）目前只是**诊断配置**，不参与驱逐门槛，默认 `off`。

**默认不启用**：`evict.enabled` 默认 `false`，`sessions` 白名单为空时一个会话都不驱逐。

### 2.1 正文守卫（可选，默认全关）

这三个开关**只影响发给模型的出站视图**，不改变持久化，也不是驱逐功能的一部分。**默认全关时，这就是一个纯粹的驱逐插件**：assistant 的正文照常发送、照常回放，谁装了都不会被改写。

| 开关 | 作用 | 默认 |
|---|---|---|
| `dropAssistantText` | 请求体里不再读回 assistant 的 text 块；`tool-call` / `tool-result` / `reasoning` / 用户消息原样保留 | `false` |
| `sanitize` | 剥 `<user_message>` 等注入形状、折短周期循环、截断超长正文、认 `[[完]]` 收尾暗号 | `false` |
| `cycleGuard` | 输出流里检测短周期重复并中止生成（原有的单字符重复 ≥200 次检测始终常开，与它无关） | `false` |

**什么时候该开**：只有当宿主把 assistant 正文当**草稿**——写完不发送、每轮又整段回放进请求体——才有意义。我们自己的用法就是这样：正文是废纸，真正说的话全走 `say.mjs` 工具调用。普通宿主直接把正文当回复用，**不要开**；开了会把人家的正常对话从请求体里摘掉。

**开了会发生什么**：正文不进下一轮请求体，模型看不到自己上一轮写在纸上的字；但**原文完整留在 `index.db` 的 `content.bytes` 里**，随时可以翻（黑匣子不擦）。库里的内容、`content_hash`、digest parity 一律不变。

配置写在主配置文件的顶层（与 `evict` 平级）：

```jsonc
"textGuard": {
  "dropAssistantText": false,
  "sanitize": false,
  "cycleGuard": false,
  "maxChars": 4000,           // 单条正文上限
  "headChars": 200,           // 超长时保留的前缀
  "cycleMinRepeats": 10       // 连续重复多少次算循环
}
```

设置页「驱逐 → 正文守卫（可选，默认全关）」有三个勾和两个阈值输入框，能存能读，重启后保持。环境变量优先级更高：`BILI_TEXT_GUARD_DROP_ASSISTANT_TEXT` / `BILI_TEXT_SANITIZE` / `BILI_GUARDRAIL_TEXT_CYCLE`（`=1` 开、`=0` 关），以及 `BILI_TEXT_SANITIZE_MAX_CHARS` / `BILI_TEXT_SANITIZE_HEAD_CHARS` / `BILI_TEXT_SANITIZE_CYCLE_REPEATS`。

> 优先级统一为 **环境变量 > 配置文件 > 默认值**（4000 / 200 / 10）。非法值（非正数、非数字）自动回退，不会把配置写坏。

---

## 三、sleep.json 怎么用

### 3.1 它是干什么的

`sleep.json` 是**唯一**允许插件驱逐原文的凭据，语义是「封盘」：

> 边界之前的对话原文，我已经在自己的存储里留底了，可以从模型上下文里拿掉。

插件不会自己去验证「留底」的内容是否真的覆盖了那些对话，只验证归档文件存在、是文件、非空、没跳出归档根。**留底的正确性由写入方负责。**

### 3.2 放在哪里

```
<evictRoot>/sessions/<sessionId>/sleep.json      ← 每会话一份，闸门只读这个
<evictRoot>/sleep.json                          ← 旧「全局」文件，仅启动时迁移用
<evictRoot>/archive/<你的归档文件>                ← archived 相对这个根
```

`<evictRoot>` 的取值：

| 优先级 | 来源 | 默认 |
|---|---|---|
| 1 | `BILI_EVICT_ROOT` 环境变量 | — |
| 2 | `$XDG_CONFIG_HOME/billion-context/evict` | `~/.config/billion-context/evict` |

`<sessionId>` 用宿主实际会话 id。路径本身就是身份，插件**不靠**文件里的 `sessionId` 字段猜。

> 新代码完全不依赖 `~/.dsh/heart/`、`profiles/desktop/stt`、`soul-md/memory` 这些私有目录。
> 旧私有部署的 `~/.dsh/heart/sleep.json` 只会在启动时被一次性迁移（复制成 per-session 文件，原文件改名 `.migrated-<日期>` 保留，不删除）。

### 3.3 最小可用示例

先造归档文件（**必须存在、是普通文件、非空**）：

```bash
mkdir -p ~/.config/billion-context/evict/archive
# 把你自己的归档/导出内容写进去，例如：
bili-evict export <session> --full > ~/.config/billion-context/evict/archive/2026-11-10.md
```

再写 marker（`<sessionId>` 换成真实 id）：

```json
{
  "at": "2026-11-10T00:00:00+08:00",
  "sessionId": "<你的会话 id>",
  "boundarySeq": 19900,
  "boundary": "m12113",
  "day": "2026-11-09",
  "tail": "那就先这样，晚安",
  "archived": "2026-11-10.md"
}
```

**最小必需其实只有两项**：`boundarySeq` + `archived`。

### 3.4 字段说明

| 字段 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `boundarySeq` | 正整数 | **是**（推荐） | 封盘线的 `seq`。单调递增、不会重编号，是首选判据。 |
| `archived` | 字符串 | **是** | 归档文件，相对 `archiveRoot`。必须存在、是文件、非空、不越界。 |
| `boundary` | `mNNNNN` 字符串 | 否 | 没有 `boundarySeq` 时的退路：查 `index.db` 按 `session_id` 把 ref 换成 seq。必须是 `m` + 数字。 |
| `sessionId` | 字符串 | 否 | 给人看 / 迁移用。闸门以文件所在目录为准。 |
| `tail` | 字符串 | 否 | 边界消息前约 30 字，仅供诊断和旧视图定位，**不能当封盘线**。 |
| `at` / `day` / `turn` | 字符串 / 数字 | 否 | 纯记录，不参与判定。 |

`archived` 路径会去掉开头的 `./`、`archive/`、`archives/`、`stt/` 前缀（后两者为兼容旧 marker）。写 `2026-11-10.md` 或 `archive/2026-11-10.md` 都可以。

### 3.5 闸门校验（全部 fail-closed）

任何一条不满足 → **关闸门、完全不驱逐**，只记一条带原因的日志：

| 情况 | reason 关键字 |
|---|---|
| 没有当前 sessionId | `no-session-marker` |
| 该会话没有自己的 `sleep.json` | `no-session-marker`（**即使有全局文件也不回落**） |
| `archived` 缺失 / 文件不存在 / 是目录 / 空文件 / 路径越界 | `archived 校验没通过` |
| 只有 `tail`，没有 `boundarySeq` 也不是 `mNNNNN` | `请补 boundarySeq` |
| `boundary` 是 ref 但 `index.db` 不可用 | `只读视图不可用` |
| `boundary` 是 ref 但缺 sessionId | `无法按会话换 seq` |
| `boundary` 是 ref 但在该会话查不到 seq | `查不到 seq` |
| `boundarySeq > 该会话 max(seq)` | `boundary-beyond-session` |
| 三个边界字段全无 | `无法判定封盘线` |
| `boundaryFromSleep=false` 但 DB/sessionId/maxSeq 不可用 | `无法按水位取封盘线` |

`boundary-beyond-session` 是关键的会话隔离校验：绝不允许拿别的会话的封盘线来量当前会话。

### 3.6 推荐操作流程

1. 先跑 `EVICT_DRY_RUN=1` 观察一轮，确认候选和回收量符合预期；
2. 导出/归档边界之前的原文，落到 `archiveRoot` 下，确认文件非空；
3. 取得当前会话的 `boundarySeq`（从状态页或 `index.db` 的 `max(seq)` 附近取）；
4. 写 per-session `sleep.json`；
5. 打开 `evict.enabled`，并用 `sessions` 白名单只放行这一个会话；
6. 观察一轮日志，确认 `睡眠闸门已开` 与预期边界一致；
7. 确认无误后再逐步放开其它会话。

**不要**把 `boundarySeq` 填成别的会话的值，也不要用 `boundaryFromSleep=false` 绕过闸门——那个模式把「当前全部消息」都当封盘线，只按水位触发，等于放弃「先留底再驱逐」的保证。

---

## 四、配置

配置写在主配置文件的 `evict` 段（`$XDG_CONFIG_HOME/billion-context/billion-context.json`），环境变量优先级更高。

```jsonc
{
  "evict": {
    "enabled": false,              // 默认 false
    "sessions": ["session-xxx"],   // 白名单；空 = 一个都不驱逐；"*" = 全部
    "budget": 0.30,                // 水位超过 30% 才开始
    "target": 0.15,                // 降到 15% 以下停
    "batchTokens": 20000,
    "dryRun": true,                // 强烈建议首次开 true
    "dropToolResults": true,
    "keepToolResultRounds": 6,
    "minToolResultChars": 200,
    "boundaryFromSleep": true,     // false = 忽略 sleep.json，只按水位（不推荐）
    "seqRefCheck": "strict",
    "archiveRoot": "/path/to/archive",  // 可选，默认 <evictRoot>/archive
    "sleepFile": "/path/to/sleep.json", // 可选，仅迁移用
    "trimFile": "/path/to/trim.json"    // 可选，默认 <stateDir>/trim.json
  }
}
```

| 配置项 | 环境变量 | 默认 |
|---|---|---|
| `enabled` | `EVICT_ENABLED=1` / `BILI_EVICT=1` | `false` |
| `budget` / `target` | `EVICT_BUDGET` / `EVICT_TARGET` | `0.3` / `0.15` |
| `batchTokens` | `EVICT_BATCH_TOKENS` | `20000` |
| `dryRun` | `EVICT_DRY_RUN` | `false` |
| `dropToolResults` | `EVICT_DROP_TOOL_RESULTS` | `true` |
| `keepToolResultRounds` | `EVICT_KEEP_TOOL_RESULT_ROUNDS` | `6` |
| `minToolResultChars` | `EVICT_MIN_TOOL_RESULT_CHARS` | `200` |
| `boundaryFromSleep` | `EVICT_BOUNDARY_FROM_SLEEP` | `true` |
| `seqRefCheck` | `EVICT_SEQ_REF_CHECK` | `strict` |
| `refMismatchAllow` | `EVICT_REF_MISMATCH_ALLOW`（逗号分隔） | `[]` |
| `archiveRoot` | `EVICT_ARCHIVE_ROOT` | `<evictRoot>/archive` |
| `sttRoot`（旧名） | `EVICT_STT_ROOT` | 同上，兼容保留 |
| `persistCheck` | `EVICT_PERSIST_CHECK` | `off`（诊断项，非门槛） |
| `writeTools` / `readTools` / `actTools` | `EVICT_*_TOOLS` | `writeTools` 默认空 |
| `memoryRoot` / `memoryScope` | `EVICT_MEMORY_*` | `<evictRoot>/memory`（仅诊断） |
| 目录根 | `BILI_EVICT_ROOT` | `$XDG_CONFIG_HOME/billion-context/evict` |

`sttRoot` / `EVICT_STT_ROOT` 是为了兼容旧部署保留的别名，新接入请用 `archiveRoot`。

**`refMismatchAllow`**：`seqRefCheck: "strict"` 下的块级白名单。某些历史块的 `start_ref` / `end_ref` 与 `start_seq` / `end_seq` 不同源（常见于块合并 / 重编号，实测偏差有 +1、+14、+44、−2，不是单一 off-by-one），ref 对账必然失败。列进白名单的块在 strict 下按 **seq** 放行（封盘判定始终以 seq 为准），日志会写明「白名单放行」及偏差值；未列入的块仍严格跳过并给出原因。默认空数组，通用部署不会有任何块悄悄绕过对账。

---

## 四·补 驱逐记录与状态页

每次驱逐会往 `evict-history.jsonl` 追加一条记录，字段含 `evictedCount`（回合 + 块总数）、`evictedTurns`（落地回合范围数）、`evictedBlocks`（换成标记的摘要块数）、`reclaimedTokens`、水位前后值、触发方式与原因。旧记录没有拆分字段也能正常读取。

`GET /__bili/evict-status` 的 `lastEviction` 与 `recentEvictions` **只取 `evictedCount > 0` 的最近 5 条**：自动 lane 每个请求都会写一条（包括只裁工具结果、没扔任何块的轮次），若直接取最新一条，真正扔了 51 块的那轮会被随后的 0 记录顶掉，设置页就会显示「没扔任何东西」。设置页「最近 5 次驱逐」列出时间 / 触发 / 回合 + 块 / 水位变化，可翻到上一轮。

---

## 五、安装与构建

### 5.1 与官方版「不打架」

本包已经换成独立身份：

| 项 | 值 |
|---|---|
| npm 包名 | `bili-context-evict` |
| 版本 | `0.1.212-fork.1` |
| CLI | `bili-evict` / `bili-evict-proxy` |
| dsh bundle 条目 | `name: bili-context-evict`、`bili-context-evict/dsh-compaction-gate` |

**但一个 dsh profile 里仍然只能装一份**：`dsh.bundle.patch.yml` 固定插入 `id: bili-native` 和 `id: bili-compaction-gate`，官方版与自制版同时装会出现同名 id。换装必须先卸后装：

```bash
dsh plugin --profile <name> remove billion-context
dsh plugin --profile <name> add bili-context-evict
```

> XDG 配置/数据目录名仍沿用 `billion-context`（`~/.config/billion-context/`），这是**有意保留**的：配置文件、会话数据、CA 证书路径都与上游一致，避免改名后丢配置或要重签证书。既然同一 profile 不允许两份共存，共享目录不会造成冲突。

### 5.2 构建

```bash
npm install
npm run build     # kernel → pi-subagents → tsup → build-info → 两道产物校验
```

`dist/` 被 `.gitignore` 忽略（约 43.6 MB），**直接从 GitHub 地址安装会拿到没有产物的源码，bundle 加载不出来**。分发请用以下任一方式：

```bash
# A. 本地路径（开发用，改完重建即生效）
dsh plugin --profile <name> add file:/path/to/bili-context-evict

# B. 打成 tarball（可存档、可搬机器）
npm pack
dsh plugin --profile <name> add file:bili-context-evict-0.1.212-fork.1.tgz
```

装完**必须重启 dsh**，模块在启动时加载，重建 `dist` 不会热更新。

---

## 六、验收测试

需要 **Node ≥ 20（实测 Node 24）**：`verify-evict-generic.mts` 会 import `src/evict.ts`，
间接加载 `undici`；Node 18 缺全局 `File`，会报 `ReferenceError: File is not defined`。
dsh 自带运行时一般在 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`。

```bash
# 会话隔离（8 项）
XDG_CONFIG_HOME=/tmp/.../cfg DSH_HOME=/tmp/.../home \
  node --import tsx --test verify-sleep-seq.mts

# 通用化 / 开源准入测试（46 项 + 11 项 roadmap）
node --import tsx --test verify-evict-generic.mts

# 驱逐主体
node --import tsx --test verify-block-evict.mts
node --import tsx --test verify-block-evict-kernel.mts

# 本机快照验收（默认 skip，见下）
node --import tsx --test verify-evict-db.mts
node --import tsx --test verify-evict-p2-e2e.mts
```

`verify-evict-db.mts` 与 `verify-evict-p2-e2e.mts` 是**本机快照验收**：断言写死了
某一时刻真实会话的 seq / 块编号，会话继续跑就会失效，且原本硬编码了本机绝对路径。
现已改为默认 `skip`，只有显式设置 `BILI_EVICT_RUN_SNAPSHOT_TESTS=1` 与
`BILI_EVICT_FIXTURE_FILE=<会话 json>` 才运行。开源前应重写为自造 fixture（见 G11）。

`verify-evict-generic.mts` 里标 `[ROADMAP]` 的 11 个用例是**尚未实现**的后续方向，
当前以 `todo` 占位（TAP 输出里会显示为 `# TODO`，**不算通过**）。
开源准入条件：46 项非 roadmap 用例全通过，且 11 项 roadmap 逐条实现并转为真实通过。

---

## 七、已知限制

1. 归档正确性由写入方负责：插件只验归档文件「存在、是文件、非空、不越界」，不验内容。
2. 无记忆检索能力，长会话存在假性失忆（见第一节）。
3. 少数 v2 会话原文不可导出，不能承诺 100% 可翻。
4. 默认真驱逐（`dryRun=false`），第一次上生产请显式设 `true`。
5. `boundaryFromSleep=false` 会绕过「先留底再驱逐」的保证，仅按水位触发。
6. 自动触发目前只挂在 `prepare-anthropic` / `prepare-openai` 两条请求 lane；其它宿主 lane 需要自行接入 `autoEvictTurn()`。
7. 同一 dsh profile 不能与官方版共存。

---

## 八、许可证与归属

MIT。原作者 `Copyright (c) 2026 ranxianglei` 的声明与 `LICENSE` 原样保留。
本分支的驱逐层为独立增补；上游 issue 请提到上游仓库，本仓库只维护驱逐层。
