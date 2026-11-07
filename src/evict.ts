/**
 * Context eviction step (二期): 在压缩循环之后，把「已落盘长期记忆」的旧
 * 对话回合整块驱逐，换成一行 `[evicted: …]` 标记，让同一条会话的上下文体量
 * 在压扁之后还能继续下降（而不是只压内容不压条数）。
 *
 * 设计要点（对应《上下文驱逐 + 分层记忆：二期设计说明》）：
 *  - 复用 kernel 的 `applyCompression` + `prune`：驱逐 = 程序化构造 ranges，
 *    summary 就是那行 evicted 标记，完全走现有 block/coverage 机制，不新增
 *    state 结构，持久化天然安全。
 *  - 驱逐粒度 = 完整「回合」（一条 user 消息 + 它后面的 assistant/tool 段，
 *    到下一 user 之前）。旧的 user 消息也一起驱逐（内容已落盘长期记忆），
 *    否则 user 消息越积越多，能驱逐的量越来越少，最后还是会爆。
 *  - 只保护：第一条 user（会话锚点，kernel 也硬 pin 它）+ 最近
 *    preserveRecentMessages 条 user（当前上下文）。
 *  - 落盘判断默认用方案 (a) 标注式：回合之后出现过记忆写盘工具（memory_append /
 *    heart_note / heart_self / soul_update 等）即视为已落盘。coverage 方案保留
 *    为可选项（EVICT_PERSIST_CHECK=coverage 或文件里配），但阈值默认 0.3 ——
 *    实测这条会话对 18 个记忆文件的关键词命中率只有 0.17~0.46，0.6 永远不过。
 *  - dryRun 默认 false（真驱逐）；想先观察就 EVICT_DRY_RUN=1。
 *  - 自动触发挂在请求 lane（prepare-anthropic / prepare-openai）里：DSH 这条
 *    部署根本不走 loop/core.ts 的 ACP 回合循环，挂在那儿是死代码。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { prune, deactivateBlock } from "acp-kernel";
import type {
  CompressionCore,
  CompressionState,
  Config,
  CoreMessage,
} from "acp-kernel";
import { loadConfigFile } from "./config.js";
import { recordEviction } from "./evict-history.js";
import { checkSleepGate } from "./sleep.js";

export interface EvictFileSettings {
  enabled?: boolean;
  sessions?: string[];
  budget?: number;
  target?: number;
  batchTokens?: number;
  dropToolResults?: boolean;
  keepToolResultRounds?: number;
  minToolResultChars?: number;
  persistCheck?: string;
  requirePersisted?: boolean;
  persistThreshold?: number;
  dryRun?: boolean;
  writeTools?: string[];
  readTools?: string[];
  actTools?: string[];
  memoryRoot?: string;
  memoryScope?: string;
  sttRoot?: string;
  sleepFile?: string;
  trimFile?: string;
}

export function parseEvictSettings(obj: unknown): EvictFileSettings | undefined {
  if (obj === undefined || obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  const out: EvictFileSettings = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (Array.isArray(o.sessions)) {
    const s = o.sessions.filter((x) => typeof x === "string");
    if (s.length > 0) out.sessions = s;
  }
  if (typeof o.budget === "number" && o.budget > 0) out.budget = Math.floor(o.budget);
  if (typeof o.target === "number" && o.target > 0) out.target = Math.floor(o.target);
  if (typeof o.batchTokens === "number" && o.batchTokens > 0) out.batchTokens = Math.floor(o.batchTokens);
  if (typeof o.dropToolResults === "boolean") out.dropToolResults = o.dropToolResults;
  if (typeof o.keepToolResultRounds === "number" && o.keepToolResultRounds >= 0) out.keepToolResultRounds = Math.floor(o.keepToolResultRounds);
  if (typeof o.minToolResultChars === "number" && o.minToolResultChars > 0) out.minToolResultChars = Math.floor(o.minToolResultChars);
  if (typeof o.requirePersisted === "boolean") out.requirePersisted = o.requirePersisted;
  if (typeof o.persistThreshold === "number" && o.persistThreshold > 0) out.persistThreshold = Math.floor(o.persistThreshold);
  if (typeof o.dryRun === "boolean") out.dryRun = o.dryRun;
  if (Array.isArray(o.writeTools)) {
    const s = o.writeTools.filter((x) => typeof x === "string");
    if (s.length > 0) out.writeTools = s;
  }
  if (Array.isArray(o.readTools)) {
    const s = o.readTools.filter((x) => typeof x === "string");
    if (s.length > 0) out.readTools = s;
  }
  if (Array.isArray(o.actTools)) {
    const s = o.actTools.filter((x) => typeof x === "string");
    if (s.length > 0) out.actTools = s;
  }
  if (typeof o.memoryRoot === "string" && o.memoryRoot.length > 0) out.memoryRoot = o.memoryRoot;
  if (typeof o.memoryScope === "string" && o.memoryScope.length > 0) out.memoryScope = o.memoryScope;
  if (typeof o.sttRoot === "string" && o.sttRoot.length > 0) out.sttRoot = o.sttRoot;
  if (typeof o.sleepFile === "string" && o.sleepFile.length > 0) out.sleepFile = o.sleepFile;
  if (typeof o.trimFile === "string" && o.trimFile.length > 0) out.trimFile = o.trimFile;
  if (typeof o.persistCheck === "string") out.persistCheck = o.persistCheck;
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

export interface EvictConfig {
  /** 总开关（环境变量 EVICT_ENABLED=1 / BILI_EVICT=1）。 */
  enabled: boolean;
  /** 软目标：水位超过这个比例开始驱逐（0.3 = 30%）。 */
  budget: number;
  /** 硬目标：驱逐到这条线以下就停（0.15 = 15%）。 */
  target: number;
  /** 一批最多扔多少 token 的原文（估算）。 */
  batchTokens: number;
  /** 驱逐顺序，目前只支持 oldest（从最老开始）。 */
  order: "oldest";
  /** 没落盘不许扔。 */
  requirePersisted: boolean;
  /** 方案 (b) 的关键词覆盖率阈值，保留占位。 */
  persistThreshold: number;
  /** 视为「记忆写盘」的工具名（方案 a 的落盘证据）。 */
  writeTools: string[];
  /** 视为「只读」的工具名（expl 集优先扔）。 */
  readTools: string[];
  /** 视为「写操作」的工具名（act 集后扔）。 */
  actTools: string[];
  /** 先 log 不扔；false 时真驱逐。 */
  dryRun: boolean;
  /**
   * 落盘判断方式：
   *  - annotated：检查回合之后有没有 writeTools 调用；
   *  - coverage：关键词覆盖率；
   *  - memory-mtime：记忆文件 mtime 晚于回合结束时间；
   *  - auto（默认）：消息里有 tool-call 就用 annotated，否则 memory-mtime
   *    （DSH 这条 lane 是 text-only 渲染，工具调用会被剥掉，annotated 永远判不过）。
   */
  persistCheck: "annotated" | "coverage" | "memory-mtime" | "auto";
  /** memory 根目录覆盖（默认 $DSH_HOME/soul-md/memory 或 ~/.dsh/soul-md/memory）。 */
  memoryRoot?: string;
  /** 人格卡 scope 覆盖（默认扫描 memory 根下唯一子目录）。 */
  memoryScope?: string;
  /** 睡眠标记文件覆盖（默认 $DSH_HOME/heart/sleep.json）。 */
  sleepFile?: string;
  /** stt 根目录覆盖（默认 $DSH_HOME/profiles/desktop/stt）。 */
  sttRoot?: string;
  /**
   * 只丢旧的工具结果：水位过线时把更早的 tool-result 正文换成一行占位符，
   * 对话原文、摘要块、kernel 的 block 一概不动（2026-11-03 用户定的最小改动）。
   */
  dropToolResults: boolean;
  /** 保留最近几轮（user 回合）内的工具结果，更早的才丢。 */
  keepToolResultRounds: number;
  /** 小于这个字符数的工具结果不值得丢。 */
  minToolResultChars: number;
  /** 截断位记录文件覆盖（默认 ~/.local/state/billion-context/trim.json）。 */
  trimFile?: string;
  /** 会话白名单：驱逐只对这些 sessionId 生效（空 = 不驱逐任何会话）。 */
  sessions?: string[];
  /**
   * 二次折叠（冷存）：睡眠闸门开之后，把 boundary 之前的多块摘要合并成一条，
   * 让封盘线之前的上下文体量恒定。纯拼接、不调模型（见 coldStoreFold）。
   */

}

export const DEFAULT_EVICT_CONFIG: EvictConfig = {
  enabled: false,
  budget: 0.3,
  target: 0.15,
  batchTokens: 20000,
  order: "oldest",
  requirePersisted: true,
  persistThreshold: 0.3,
  writeTools: [
    "memory_append",
    "memory_rewrite",
    "memory_write",
    "heart_note",
    "heart_self",
    "heart_summary",
    "heart_longterm",
    "soul_update",
  ],
  readTools: ["read", "grep", "glob", "search_context", "list", "ls"],
  actTools: [
    "edit",
    "write",
    "notebook_edit",
    "apply_patch",
    "bash",
    "execute",
    "run",
  ],
  dryRun: false,
  persistCheck: "auto",
  dropToolResults: true,
  keepToolResultRounds: 6,
  minToolResultChars: 200,

};

/** 把外部字符串收敛成合法的落盘判断方式。 */
function asPersistCheck(
  v: string | undefined,
): EvictConfig["persistCheck"] | undefined {
  return v === "annotated" || v === "coverage" || v === "memory-mtime" || v === "auto"
    ? v
    : undefined;
}

function parsePercent(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const s = v.trim();
  if (s === "") return dflt;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : dflt;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** 布尔开关：环境变量（1/0）优先，其次配置文件，最后默认值。 */
function pickBool(
  envValue: string | undefined,
  fileValue: unknown,
  dflt: boolean,
): boolean {
  if (envValue === "1") return true;
  if (envValue === "0") return false;
  if (typeof fileValue === "boolean") return fileValue;
  return dflt;
}

/** 正数：环境变量优先，其次配置文件，最后默认值。 */
function pickPositiveNumber(
  envValue: string | undefined,
  fileValue: unknown,
  dflt: number,
): number {
  if (envValue !== undefined && envValue.trim() !== "") {
    const n = Number(envValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof fileValue === "number" && Number.isFinite(fileValue) && fileValue > 0) {
    return fileValue;
  }
  return dflt;
}

/** 字符串数组：环境变量用逗号分隔，其次配置文件数组，最后默认值。 */
function pickStringList(
  envValue: string | undefined,
  fileValue: unknown,
  dflt: string[],
): string[] {
  if (envValue !== undefined && envValue.trim() !== "") {
    const list = envValue
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length > 0) return list;
  }
  if (Array.isArray(fileValue)) {
    const list = fileValue.filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
    if (list.length > 0) return list;
  }
  return dflt;
}

export function resolveEvictConfig(
  rawEvict: unknown,
  env: Record<string, string | undefined> = {},
): EvictConfig {
  const fileEvict = parseEvictSettings(rawEvict);
  const fileSessions = Array.isArray(fileEvict?.sessions)
    ? fileEvict.sessions.filter((s): s is string => typeof s === "string")
    : undefined;
  const persistCheck: EvictConfig["persistCheck"] =
    asPersistCheck(env.EVICT_PERSIST_CHECK) ??
    asPersistCheck(fileEvict?.persistCheck) ??
    DEFAULT_EVICT_CONFIG.persistCheck;
  return {
    ...DEFAULT_EVICT_CONFIG,
    enabled:
      env.EVICT_ENABLED === "1" ||
      env.BILI_EVICT === "1" ||
      fileEvict?.enabled === true,
    budget: env.EVICT_BUDGET
      ? parsePercent(env.EVICT_BUDGET, DEFAULT_EVICT_CONFIG.budget)
      : typeof fileEvict?.budget === "number" && fileEvict.budget > 0
        ? fileEvict.budget
        : DEFAULT_EVICT_CONFIG.budget,
    target: env.EVICT_TARGET
      ? parsePercent(env.EVICT_TARGET, DEFAULT_EVICT_CONFIG.target)
      : typeof fileEvict?.target === "number" && fileEvict.target > 0
        ? fileEvict.target
        : DEFAULT_EVICT_CONFIG.target,
    batchTokens: pickPositiveNumber(
      env.EVICT_BATCH_TOKENS,
      fileEvict?.batchTokens,
      DEFAULT_EVICT_CONFIG.batchTokens,
    ),
    requirePersisted: pickBool(
      env.EVICT_REQUIRE_PERSISTED,
      fileEvict?.requirePersisted,
      DEFAULT_EVICT_CONFIG.requirePersisted,
    ),
    persistThreshold: pickPositiveNumber(
      env.EVICT_PERSIST_THRESHOLD,
      fileEvict?.persistThreshold,
      DEFAULT_EVICT_CONFIG.persistThreshold,
    ),
    dryRun: pickBool(env.EVICT_DRY_RUN, fileEvict?.dryRun, DEFAULT_EVICT_CONFIG.dryRun),
    persistCheck,
    writeTools: pickStringList(
      env.EVICT_WRITE_TOOLS,
      fileEvict?.writeTools,
      DEFAULT_EVICT_CONFIG.writeTools,
    ),
    readTools: pickStringList(
      env.EVICT_READ_TOOLS,
      fileEvict?.readTools,
      DEFAULT_EVICT_CONFIG.readTools,
    ),
    actTools: pickStringList(
      env.EVICT_ACT_TOOLS,
      fileEvict?.actTools,
      DEFAULT_EVICT_CONFIG.actTools,
    ),
    memoryRoot: env.EVICT_MEMORY_ROOT ?? fileEvict?.memoryRoot,
    memoryScope: env.EVICT_MEMORY_SCOPE ?? fileEvict?.memoryScope,
    sleepFile: env.EVICT_SLEEP_FILE ?? fileEvict?.sleepFile,
    sttRoot: env.EVICT_STT_ROOT ?? fileEvict?.sttRoot,
    dropToolResults: pickBool(
      env.EVICT_DROP_TOOL_RESULTS,
      fileEvict?.dropToolResults,
      DEFAULT_EVICT_CONFIG.dropToolResults,
    ),
    keepToolResultRounds: pickPositiveNumber(
      env.EVICT_KEEP_TOOL_RESULT_ROUNDS,
      fileEvict?.keepToolResultRounds,
      DEFAULT_EVICT_CONFIG.keepToolResultRounds,
    ),
    minToolResultChars: pickPositiveNumber(
      env.EVICT_MIN_TOOL_RESULT_CHARS,
      fileEvict?.minToolResultChars,
      DEFAULT_EVICT_CONFIG.minToolResultChars,
    ),
    trimFile: env.EVICT_TRIM_FILE ?? fileEvict?.trimFile,
    sessions: fileSessions,
  };
}

/** base id（去掉 `#` 投影后缀），与 kernel 的 baseIdOf 对齐。 */
function baseId(id: string): string {
  const h = id.indexOf("#");
  return h > 0 ? id.slice(0, h) : id;
}

/**
 * 会话白名单匹配。支持：
 *  - `"*"`：所有会话；
 *  - 完整 id（`session-xxxx`）；
 *  - 省略 `session-` 前缀的 uuid；
 *  - `|sub:` 派生的子 lane（取 `|` 之前那段比较）。
 * DSH 每开一个新会话就换 id，按完整 id 写死一定会烂 —— 这也是 2026-11-03
 * 白名单里写着上一个会话、当前 lane 却完全没被选中的原因。
 */
export function sessionSelected(
  sessionId: string,
  sessions: string[] | undefined,
): boolean {
  if (!sessions || sessions.length === 0) return false;
  const stripPrefix = (v: string) =>
    v.startsWith("session-") ? v.slice("session-".length) : v;
  const base = baseId(sessionId.split("|sub:")[0] ?? sessionId);
  for (const raw of sessions) {
    const s = raw.trim();
    if (s.length === 0) continue;
    if (s === "*") return true;
    const sb = baseId(s.split("|sub:")[0] ?? s);
    if (sb === base || stripPrefix(sb) === stripPrefix(base)) return true;
  }
  return false;
}

// ── memory 路径（与 dsh-soul-md/memory-layout.js 保持一致）─────────────────
// 不直接 import dsh-soul-md：其 package.json 的 exports 不暴露 memory-layout.js，
// 且入口 index.js 有插件副作用。这里内置一份一致的 safeMemoryName + 路径规则，
// scope（人格卡名）改名时必须与 dsh-soul-md 同步，否则算出的路径就写丢了。

function safeMemoryName(value: string, fallback = "memory"): string {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 64) || fallback;
}

function memoryRoot(override: string | undefined): string {
  if (override && override.length > 0) return override;
  const dshHome = process.env.DSH_HOME;
  if (dshHome && dshHome.length > 0) {
    return path.join(dshHome, "soul-md", "memory");
  }
  return path.join(homedir(), ".dsh", "soul-md", "memory");
}

function resolveMemoryScope(root: string, override: string | undefined): string {
  if (override && override.length > 0) return override;
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n !== "global");
    if (dirs.length >= 1) {
      // 只有带 core.md 的目录才是人格卡 scope；按 core.md 的修改时间取最新的
      // 那个。memory 根下可能同时有 `topics/` 这种非 scope 目录，readdir
      // 顺序不可靠 —— 以前直接取 dirs[0]，实测选中 `topics/`，coverage 永远
      // 读不到 core.md。
      const scored = dirs
        .map((name) => {
          let mtime = 0;
          try {
            mtime = statSync(path.join(root, name, "core.md")).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { name, mtime };
        })
        .filter((d) => d.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime);
      if (scored.length > 0) return scored[0]!.name;
      return dirs[0]!;
    }
  } catch {
    /* memory 根不存在 */
  }
  return "global";
}

function memoryCoreFile(root: string, scope: string): string {
  return path.join(root, safeMemoryName(scope, "global"), "core.md");
}

function memoryTopicsDir(root: string, scope: string): string {
  return path.join(root, safeMemoryName(scope, "global"), "topics");
}

function listMemoryTopicFiles(root: string, scope: string): string[] {
  try {
    const dir = memoryTopicsDir(root, scope);
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function shortMemoryFile(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

/** memory scope 下所有 .md 的最新 mtime（0 = 一个可读文件都没有）。 */
function memoryLatestMtime(root: string, scope: string): number {
  const files = [
    memoryCoreFile(root, scope),
    path.join(root, `${safeMemoryName(scope, "global")}.md`),
    ...listMemoryTopicFiles(root, scope),
  ];
  let latest = 0;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* 文件不存在就跳过 */
    }
  }
  return latest;
}

// ── 方案 b：关键词覆盖 ─────────────────────────────────────────────────────

// 常见虚词/寒暄字：片段中占比过高即视为低信息量，不参与覆盖。
const STOP_CHARS = new Set(
  "的了着过是我你他她它这在有和与就都还很被把让向从对跟给帮记收好哦啊呀吗呢吧嘛".split(""),
);

function extractKeywords(text: string): string[] {
  const kws = new Set<string>();
  // 引号里的原话
  for (const m of text.matchAll(/["「『]([^"」』]{2,40})["」』]/g)) {
    const v = m[1]!.trim();
    if (v) kws.add(v);
  }
  // 日期
  for (const m of text.matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}[日号]/g)) {
    kws.add(m[0]);
  }
  // 3 位以上数字（ID / 金额 / 账号等）
  for (const m of text.matchAll(/\d{3,}/g)) {
    kws.add(m[0]);
  }
  // 按标点切短语：保留 4~20 字、停用字占比 ≤ 50% 的片段。
  for (const seg of text.split(/[\s，。！？；：、,\.!?;:()（）\[\]【】"'…—]+/)) {
    const s = seg.trim();
    if (s.length < 4 || s.length > 20) continue;
    let stop = 0;
    for (const ch of s) {
      if (STOP_CHARS.has(ch)) stop++;
    }
    if (stop / s.length > 0.5) continue;
    kws.add(s);
  }
  return [...kws].slice(0, 80);
}

function coverageRatio(keywords: string[], memoryText: string): number {
  if (keywords.length === 0) return 0;
  let hit = 0;
  for (const kw of keywords) {
    if (memoryText.includes(kw)) hit++;
  }
  return hit / keywords.length;
}

/** 方案 b：读 core.md + topics/*.md，关键词覆盖率达标即视为已落盘，返回命中文件。 */
function coverageCheck(
  text: string,
  root: string,
  scope: string,
  threshold: number,
): { persisted: boolean; files: string[] } {
  const keywords = extractKeywords(text);
  if (keywords.length === 0) return { persisted: false, files: [] };
  // 新布局：<scope>/core.md + <scope>/topics/*.md；老布局可能还留在根级
  // `<scope>.md`（拆 topics 之前的那份），一起算，读不到就跳过。
  const files = [
    memoryCoreFile(root, scope),
    path.join(root, `${safeMemoryName(scope, "global")}.md`),
    ...listMemoryTopicFiles(root, scope),
  ];
  const hitFiles: string[] = [];
  for (const file of files) {
    let mem = "";
    try {
      mem = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (coverageRatio(keywords, mem) >= threshold) hitFiles.push(file);
  }
  return { persisted: hitFiles.length > 0, files: hitFiles };
}

/** 一个完整「回合」：一条 user 消息 + 它后面的 assistant/tool 段（含 user 本身）。 */
interface Episode {
  start: number;
  end: number; // exclusive，指向下一 user 或末尾
  kind: "expl" | "act";
  tokens: number;
}

function segmentEpisodes(messages: CoreMessage[]): Episode[] {
  const episodes: Episode[] = [];
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "user") continue;
    if (start >= 0) {
      episodes.push({ start, end: i, kind: "expl", tokens: 0 });
    }
    start = i;
  }
  if (start >= 0) {
    episodes.push({ start, end: messages.length, kind: "expl", tokens: 0 });
  }
  return episodes;
}

function classifyEpisode(
  ep: Episode,
  messages: CoreMessage[],
  readTools: string[],
  actTools: string[],
): "expl" | "act" {
  for (let i = ep.start; i < ep.end; i++) {
    const m = messages[i]!;
    if (m.contentType !== "tool-call" || typeof m.toolName !== "string") continue;
    const name = m.toolName;
    if (readTools.includes(name)) continue;
    if (actTools.includes(name)) return "act";
    // 未知工具保守视为 act（有副作用）。
    return "act";
  }
  return "expl";
}

function estimateEpisodeTokens(messages: CoreMessage[], ep: Episode): number {
  let chars = 0;
  for (let i = ep.start; i < ep.end; i++) {
    const m = messages[i]!;
    chars += (m.text?.length ?? 0) + (m.thinkingTokens ?? 0) * 4;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function charsIn(messages: CoreMessage[], ep: Episode): number {
  let chars = 0;
  for (let i = ep.start; i < ep.end; i++) {
    chars += messages[i]!.text?.length ?? 0;
  }
  return chars;
}

function charsInGroup(messages: CoreMessage[], group: Episode[]): number {
  let chars = 0;
  for (const ep of group) chars += charsIn(messages, ep);
  return chars;
}

/** 方案 (a)：回合之后出现过记忆写盘工具调用，视为已落盘。 */
function isPersisted(
  messages: CoreMessage[],
  afterIdx: number,
  writeTools: string[],
): boolean {
  for (let i = afterIdx; i < messages.length; i++) {
    const m = messages[i]!;
    if (
      m.contentType === "tool-call" &&
      typeof m.toolName === "string" &&
      writeTools.includes(m.toolName)
    ) {
      return true;
    }
  }
  return false;
}

function fmtTime(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "?";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function episodeHint(messages: CoreMessage[], ep: Episode): string {
  const tools = new Set<string>();
  let sample = "";
  for (let i = ep.start; i < ep.end; i++) {
    const m = messages[i]!;
    if (m.contentType === "tool-call" && typeof m.toolName === "string") {
      tools.add(m.toolName);
    }
    // 优先抓 user 的原话（回合开头）作为内容线索。
    if (!sample && m.text) {
      sample = m.text.replace(/\s+/g, " ").slice(0, 40);
    }
  }
  const toolList = tools.size > 0 ? [...tools].join("/") : "无工具调用";
  return sample ? `${toolList}，内容「${sample}…」` : toolList;
}

function groupText(messages: CoreMessage[], group: Episode[]): string {
  let out = "";
  for (const ep of group) {
    for (let i = ep.start; i < ep.end; i++) {
      out += messages[i]!.text ?? "";
      out += "\n";
    }
  }
  return out;
}

function groupMarker(
  group: Episode[],
  messages: CoreMessage[],
  persisted: boolean,
  files: string[],
): string {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const t0 = fmtTime(messages[first.start]!.ts);
  const t1 = fmtTime(messages[last.end - 1]!.ts);
  const totalN = last.end - first.start;
  const actCount = group.filter((ep) => ep.kind === "act").length;
  const hint = episodeHint(messages, first);
  const tail =
    files.length > 0
      ? `已落盘: ${files.join(", ")}`
      : persisted
        ? "已落盘长期记忆"
        : "未落盘";
  return `[evicted: ${t0} ~ ${t1} · ${group.length} 个回合 ${totalN} 条（${actCount} 动作） · 涉及 ${hint} · ${tail}]`;
}

export interface EvictOutcome {
  messages: CoreMessage[];
  state: CompressionState;
  evictedCount: number;
  reclaimedTokens: number;
}

/** kernel 把已折叠/被剪掉的消息在 messageRefs.byRaw 里标成 BLOCKED。 */
const isBadRef = (r: string | undefined): boolean =>
  r === undefined || r === "BLOCKED" || r.startsWith("BLOCKED");

/** 工具结果被丢后的占位符开头（用来判断「这条已经丢过」）。 */
const DROPPED_MARK = "[tool output dropped: ";

/**
 * 驱逐重做（2026-11-08）：把「已折叠的 active 摘要块」本身当成一个可驱逐
 * 单元。病灶是 isCovered 把被 active block 覆盖的原文全排除出候选，折过的
 * 摘要块因此只增不减。这里让 block 当整体被扔：换成一行 evicted 标记，
 * 上下文真正变小。不新增 state 结构，复用 kernel 的 block 机制。
 */
export interface BlockUnit {
  kind: "block";
  blockId: string;
  effectiveMessageIds: string[];
  summaryChars: number;
  tier: string;
  createdTurn: number;
  startRef: string;
  endRef: string;
}

/** 新增候选来源（只加不删）：在 maybeEvict 的候选构造里调用一次。 */
export function collectBlockCandidates(
  messages: CoreMessage[],
  state: CompressionState,
  boundaryIndex: number,
  protectedIds: Set<string>,
  minSummaryChars: number,
): BlockUnit[] {
  const indexByBase = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const base = baseId(messages[i]!.id);
    if (!indexByBase.has(base)) indexByBase.set(base, i);
  }
  const units: BlockUnit[] = [];
  for (const b of state.blocks) {
    if (!b.active) continue; // 扔过的（active:false）不再进候选
    const ids = b.effectiveMessageIds ?? [];
    if (ids.length === 0) continue;
    const summary = b.summary ?? "";
    const summaryChars = summary.length;
    if (summaryChars < minSummaryChars) continue; // 够大：同一把尺子
    if (summary.startsWith("[evicted:")) continue; // 驱逐标记本身不再被扔
    let maxIdx = -1;
    let inView = false;
    let hitsProtected = false;
    for (const id of ids) {
      const base = baseId(id);
      if (protectedIds.has(base)) {
        hitsProtected = true;
        break;
      }
      const idx = indexByBase.get(base);
      if (idx !== undefined) {
        inView = true;
        if (idx > maxIdx) maxIdx = idx;
      }
    }
    if (hitsProtected || !inView) continue; // 保护区 / 不在主视图
    if (maxIdx >= boundaryIndex) continue; // 封盘线之前（一块都不能跳过）
    // kernel 的 block-map 规则：优先用块自己存的 ref 范围（折叠时就记好的），
    // 老会话没有再用 effectiveMessageIds 首尾去 byRaw 反查。
    const startRef = b.startRef ?? state.messageRefs.byRaw[baseId(ids[0]!)];
    const endRef = b.endRef ?? state.messageRefs.byRaw[baseId(ids[ids.length - 1]!)];
    if (isBadRef(startRef) || isBadRef(endRef)) continue;
    units.push({
      kind: "block",
      blockId: b.blockId,
      effectiveMessageIds: ids,
      summaryChars,
      tier: String(b.tier),
      createdTurn: typeof b.createdAt === "number" ? b.createdAt : 0,
      startRef,
      endRef,
    });
  }
  units.sort((a, z) => a.createdTurn - z.createdTurn); // 越旧越先扔
  return units;
}

/** 截断位记录：按 sessionId 记已经丢过的消息 id，保证跨请求前缀稳定。 */
interface TrimState {
  [sessionId: string]: { dropped: string[]; at: number };
}

function trimFilePath(evict: EvictConfig): string {
  if (evict.trimFile) return evict.trimFile;
  return path.join(homedir(), ".local", "state", "billion-context", "trim.json");
}

function loadTrimState(file: string): TrimState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TrimState;
  } catch {
    return {};
  }
}

function saveTrimState(file: string, st: TrimState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(st));
  } catch {
    // 记不住就按规则重算：下次可能把同一段再丢一遍，但不会丢错。
  }
}

/**
 * 只丢工具结果：保留最近 keepRounds 个 user 回合内的全部内容，把更早的
 * tool-result 正文换成一行占位符。extend=false 只复原上一次记下的截断位
 * （前缀不变，缓存不打穿）；extend=true 才把新够龄的工具结果也一起丢。
 */
export function dropToolOutputs(
  messages: CoreMessage[],
  evict: EvictConfig,
  sessionId: string,
  extend: boolean,
  persist: boolean,
): { messages: CoreMessage[]; savedChars: number; changed: boolean; droppedCount: number } {
  const keepRounds = Math.max(1, Math.floor(evict.keepToolResultRounds ?? 6));
  const minChars = Math.max(1, Math.floor(evict.minToolResultChars ?? 200));
  const file = trimFilePath(evict);
  const all = loadTrimState(file);
  const prev = new Set(all[sessionId]?.dropped ?? []);

  // 保护区：倒数第 keepRounds 个 user 消息及其之后的全部内容。
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") userIdx.push(i);
  }
  const keepFrom = userIdx.length >= keepRounds ? userIdx[userIdx.length - keepRounds]! : 0;

  const out: CoreMessage[] = messages.slice();
  const droppedIds: string[] = [];
  let savedChars = 0;
  let changed = false;
  for (let i = 0; i < keepFrom; i++) {
    const m = messages[i]!;
    if (m.contentType !== "tool-result") continue;
    const id = baseId(m.id);
    const text = m.text ?? "";
    if (text.startsWith(DROPPED_MARK)) continue;
    const remember = prev.has(id);
    if (!remember && !(extend && text.length >= minChars)) continue;
    const placeholder = `${DROPPED_MARK}${text.length} chars]`;
    out[i] = { ...m, text: placeholder };
    droppedIds.push(id);
    savedChars += Math.max(0, text.length - placeholder.length);
    changed = true;
  }
  if (persist && droppedIds.length > 0) {
    all[sessionId] = {
      dropped: [...new Set([...(all[sessionId]?.dropped ?? []), ...droppedIds])],
      at: Date.now(),
    };
    saveTrimState(file, all);
  }
  return { messages: out, savedChars, changed, droppedCount: droppedIds.length };
}

/**
 * 驱逐台阶。返回 null 表示本次什么都没做（水位没到 / 没可驱逐的回合 / dryRun）。
 * 调用方负责在真驱逐后把返回的 messages/state 写回 session。
 */
export function maybeEvict(
  core: CompressionCore,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  contextTokens: number,
  evict: EvictConfig,
  log: (msg: string) => void,
  /**
   * 这个请求真正可用的窗口（headroom 之后）。自动 lane 传进来的 config 已经
   * 是这份配置；手动端点拿到的是进程基础 config（200000），必须由调用方用
   * session.metadata.reservedContextLimit 覆盖，否则水位会被放大约 4 倍。
   */
  limitOverride?: number,
  /** 收尾：把「为什么没驱逐」写出来，给设置页手动按钮显示具体原因。 */
  trace?: { reason?: string },
  /** 会话 id：截断位按会话记，自动 lane 传 sessionId，手动端点传 base。 */
  sessionId?: string,
): EvictOutcome | null {
  if (!evict.enabled) {
    if (trace) trace.reason = "驱逐未启用（enabled=false）";
    return null;
  }
  const limit = limitOverride && limitOverride > 0 ? limitOverride : config.modelContextLimit;
  if (!limit || limit <= 0) {
    if (trace) trace.reason = "上下文窗口未知（limit<=0）";
    return null;
  }
  const ratio = contextTokens / limit;

  // 丢工具结果（最小改动）：先复原上一次记下的截断位 —— 每个请求都要做，
  // 前缀才稳定；水位过线时再把新够龄的工具结果也一起丢。对话原文、摘要块、
  // kernel 的 block 一概不碰（2026-11-03 用户定的范围）。
  let trimTokens = 0;
  let totalChars = 0;
  if (evict.dropToolResults) {
    totalChars = messages.reduce((n, m) => n + (m.text?.length ?? 0), 0);
    const key = sessionId ?? "__default";
    const restore = dropToolOutputs(messages, evict, key, false, !evict.dryRun);
    let trimmed = restore;
    if (ratio >= evict.budget) {
      trimmed = dropToolOutputs(restore.messages, evict, key, true, !evict.dryRun);
    }
    if (trimmed.changed) {
      messages = trimmed.messages;
      // 按字符占比折算，而不是 chars/4：工具输出里长 ASCII / 代码的 token
      // 密度和对话差得多，直接除四会把水位算到负数（实测 456k 的上下文被
      // 估成掉了 479k）。占比法有界，也不会把「不折对话」判断带偏。
      trimTokens =
        totalChars > 0
          ? Math.min(contextTokens, Math.round((contextTokens * trimmed.savedChars) / totalChars))
          : Math.ceil(trimmed.savedChars / 4);
      log(
        `[evict] 丢工具结果：${trimmed.droppedCount} 条 / ${trimmed.savedChars} 字符，约 ${trimTokens} tokens（保留最近 ${evict.keepToolResultRounds} 轮；不动对话/摘要）`,
      );
    }
  }
  const afterTrim = Math.max(0, contextTokens - trimTokens);

  if (ratio < evict.budget) {
    if (trimTokens > 0 && !evict.dryRun) {
      return { messages, state, evictedCount: 0, reclaimedTokens: trimTokens };
    }
    if (trace) {
      trace.reason = `水位 ${(ratio * 100).toFixed(1)}% < 预设 ${(evict.budget * 100).toFixed(0)}%（${contextTokens}/${limit}），未到触发线`;
    }
    return null;
  }

  log(
    `[evict] 水位 ${(ratio * 100).toFixed(1)}% ≥ 软目标 ${(evict.budget * 100).toFixed(0)}%（${contextTokens}/${limit}），进入驱逐检查${
      trimTokens > 0 ? `；丢工具结果后约 ${(afterTrim / limit * 100).toFixed(1)}%` : ""
    }`,
  );

  // 只丢工具结果就够回到目标线：到此为止，绝不折对话。
  if (trimTokens > 0 && !evict.dryRun && afterTrim / limit <= evict.target) {
    log(
      `[evict] 丢工具结果后水位 ${(afterTrim / limit * 100).toFixed(1)}% ≤ 目标 ${(evict.target * 100).toFixed(0)}%，不折对话`,
    );
    return { messages, state, evictedCount: 0, reclaimedTokens: trimTokens };
  }

  // 睡眠闸门：驱逐对话原文的唯一凭据。没有 sleep.json / 归档校验不过 /
  // boundary 定位不到，一律不动 —— 宁可少丢，不能丢错。闸门之外只有这一
  // 条硬约束，跟水位、落盘判断都无关。
  const gate = checkSleepGate(messages, state, {
    sleepFile: evict.sleepFile,
    sttRoot: evict.sttRoot,
  });
  if (!gate.ok) {
    log(`[evict] 睡眠闸门未开：${gate.reason}`);
    if (trimTokens > 0 && !evict.dryRun) {
      return { messages, state, evictedCount: 0, reclaimedTokens: trimTokens };
    }
    if (trace) trace.reason = `睡眠闸门未开：${gate.reason}`;
    return null;
  }
  const boundaryIndex = gate.boundaryIndex!;
  log(
    `[evict] 睡眠闸门已开：boundary=${gate.marker?.boundary ?? "-"}（${gate.how}）→ 第 ${boundaryIndex} 条之前可丢；归档 ${gate.marker?.archived ?? "-"}`,
  );

  // 保护区：第一条 user（会话锚点）+ 最近 preserveRecentMessages 条 user。
  const recent = config.preserveRecentMessages ?? 3;
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") userIdx.push(i);
  }
  const protectedStarts = new Set<number>();
  if (userIdx.length > 0) protectedStarts.add(userIdx[0]!); // 第一条 user 永不扔
  for (const idx of userIdx.slice(-recent)) protectedStarts.add(idx);

  // protectedIds 传给 applyCompression：保护区 user 消息 + 末尾 recent 条消息。
  const protectedIds = new Set<string>();
  for (const idx of protectedStarts) protectedIds.add(baseId(messages[idx]!.id));
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - recent); i--) {
    protectedIds.add(baseId(messages[i]!.id));
  }

  // 已被 active block 折叠过的原文，不能再当候选：手动端点喂的是客户端原始
  // 快照（含全部原文），不剔除它们就会切出几百个「folded nothing — already
  // covered by active block(s)」的块，逐个提交全被 kernel 拒（2026-11-03 实测
  // 616 块）。按 effectiveMessageIds 预过滤，只让真正裸露的旧回合进候选。
  const coveredRaw = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) coveredRaw.add(baseId(id));
  }
  const isCovered = (ep: Episode): boolean => {
    for (let i = ep.start; i < ep.end; i++) {
      if (coveredRaw.has(baseId(messages[i]!.id))) return true;
    }
    return false;
  };
  // 还有一类不能进候选：范围两端的 ref 缺失或 BLOCKED。它们有的不在
  // effectiveMessageIds 里（嵌套折叠 / 剪枝后 id 空间对不上），只有到
  // applyCompression 才会被拒；提前剔掉，免得每次计划一堆注定失败的块
  // （2026-11-03 实测 8/11 块如此）。只查首尾：中间的 BLOCKED 由 kernel 的
  // 保护区判定处理，全查会误伤整段还能用的回合。
  const hasBadRef = (ep: Episode): boolean =>
    isBadRef(state.messageRefs.byRaw[baseId(messages[ep.start]!.id)]) ||
    isBadRef(state.messageRefs.byRaw[baseId(messages[ep.end - 1]!.id)]);

  // 切回合 + 分类 + 过滤（跳过保护区、已折叠、无 ref）。
  const episodes = segmentEpisodes(messages);
  const candidates: Episode[] = [];
  let skippedCovered = 0;
  let skippedBlocked = 0;
  let skippedBlockedChars = 0;
  let skippedUnsealed = 0;
  let protectedChars = 0;
  const blockedDetail: string[] = [];
  for (const ep of episodes) {
    // 睡眠闸门：只动 boundary 之前的完整回合；之后的（包括跨过 boundary 的）
    // 一根汗毛都不碰。
    if (ep.end > boundaryIndex) {
      skippedUnsealed++;
      continue;
    }
    if (protectedStarts.has(ep.start)) {
      protectedChars += charsIn(messages, ep); // 保护区（第一条 / 最近 N 条 user）
      continue;
    }
    if (isCovered(ep)) {
      skippedCovered++;
      continue;
    }
    if (hasBadRef(ep)) {
      skippedBlocked++;
      const chars = charsIn(messages, ep);
      skippedBlockedChars += chars;
      if (chars > 500 && blockedDetail.length < 3) {
        blockedDetail.push(
          `${baseId(messages[ep.start]!.id)}(${messages[ep.start]!.role})..${baseId(
            messages[ep.end - 1]!.id,
          )}(${messages[ep.end - 1]!.role}, ${chars} 字符)`,
        );
      }
      continue;
    }
    ep.kind = classifyEpisode(ep, messages, evict.readTools, evict.actTools);
    ep.tokens = estimateEpisodeTokens(messages, ep);
    candidates.push(ep);
  }

  // 驱逐重做：新增候选来源 —— active 摘要块本身。用同一把睡眠闸门 /
  // 保护区尺子，结果并入本轮计划；原来的 Episode 候选一行不动。
  const blockCandidates = collectBlockCandidates(
    messages,
    state,
    boundaryIndex,
    protectedIds,
    Math.max(1, Math.floor(evict.minToolResultChars ?? 200)),
  );

  if (candidates.length === 0 && blockCandidates.length === 0) {
    // 名字别和函数开头那个 totalChars 撞：这里算的是「当前视图」的字符数。
    const viewChars = messages.reduce((n, m) => n + (m.text?.length ?? 0), 0);
    log(
      `[evict] 无可驱逐回合（保护区 ${Math.ceil(protectedChars / 4)} tokens / ${skippedCovered} 个已被 active block 覆盖 / ${
        skippedBlocked
      } 个 ref 为 BLOCKED / ${skippedUnsealed} 个回合在封盘线之后未过睡眠闸门；视图共 ${
        messages.length
      } 条约 ${Math.ceil(viewChars / 4)} tokens）${
        blockedDetail.length > 0 ? ` BLOCKED 明细：${blockedDetail.join(" / ")}` : ""
      }`,
    );
    if (trace) {
      const coveredNote =
        skippedCovered > 0 ? `${skippedCovered} 个已折叠进 active block，` : "";
      const blockedNote = skippedBlocked > 0 ? `${skippedBlocked} 个 ref 已失效（BLOCKED），` : "";
      const unsealedNote = skippedUnsealed > 0 ? `${skippedUnsealed} 个回合在封盘线之后，` : "";
      trace.reason = `没有可驱逐的回合（${coveredNote}${blockedNote}${unsealedNote}其余在保护区 / 无 ref）`;
    }
    return null;
  }

  // 合并成 group：连续可驱逐的回合攒到一个 range。minChars 只用来决定「何时
  // 切块」，不再是「要不要驱逐」的门槛 —— 水位过了 budget 就该动手，短块交给
  // applyCompression 判定，被拒就跳过这一块，不能因为「剩余可压内容不够最小
  // 压缩阈值」整体放弃（2026-11-03 用户要求：第一触发条件只能是水位）。
  const minChars = config.compress?.minCompressRange ?? 5000;
  const groups: Episode[][] = [];
  let cur: Episode[] = [];
  let curChars = 0;
  let curTokens = 0;
  const flush = () => {
    if (cur.length > 0) {
      groups.push(cur);
      cur = [];
      curChars = 0;
      curTokens = 0;
    }
  };
  for (const ep of candidates) {
    if (cur.length > 0 && cur[cur.length - 1]!.end !== ep.start) {
      // 中间隔了保护区回合，不能跨过去合并。
      flush();
    }
    cur.push(ep);
    curChars += charsIn(messages, ep);
    curTokens += ep.tokens;
    if (curChars >= minChars || curTokens >= evict.batchTokens) {
      flush();
    }
  }
  flush();

  // 水位已经过了 budget，所有攒出来的块都值得试 —— 不再用 minChars 过滤掉
  // 「不够大」的块。kernel 的 minCompressRange 是「全批」判定；我们逐块提交，
  // 小块被拒只跳过它自己（下面的循环里还会对小块降阈值重试一次）。
  const sized = groups;
  // 放宽：只有摘要块可扔时（原文全被 active block 覆盖，Episode 候选为空）
  // 也要继续 —— 这正是「摘要只增不减」的病灶场景。
  if (sized.length === 0 && blockCandidates.length === 0) {
    log("[evict] 无可驱逐内容（没有攒出可用块）");
    if (trace) trace.reason = "没有攒出可驱逐的块";
    return null;
  }

  // 睡眠闸门已经验过：boundary 之前的回合都算「已封盘」，不再跑旧的落盘
  // 判断（annotated / coverage / memory-mtime 退成诊断用途，不再是门槛）。
  // 但也不会一口气折光：按目标线挑块，丢到 target 以下就停；差得很少
  // （< 2000 tokens）就先不动，避免为几百 token 频繁重写前缀、把缓存全废。
  const needTokens = Math.max(0, Math.ceil(contextTokens - evict.target * limit));
  // 停手线只保护「重写前缀」；有可驱逐摘要块时仍要继续（重做目标：让只增
  // 不减的摘要也能被扔）。没有块候选时保持原逻辑一行不动。
  if (needTokens < 2000 && blockCandidates.length === 0) {
    log(
      `[evict] 水位 ${(ratio * 100).toFixed(1)}% 离目标线 ${(evict.target * 100).toFixed(0)}% 只差 ${needTokens} tokens，不值得动前缀，停手`,
    );
    if (trace) trace.reason = `离目标线只差 ${needTokens} tokens（<2000），按设计不动前缀`;
    return null;
  }

  const archivedLabel = gate.marker?.archived ?? "";
  const chosen: { group: Episode[]; persisted: boolean; files: string[] }[] = [];
  let chosenTokens = 0;
  for (const g of sized) {
    if (chosen.length > 0 && chosenTokens >= needTokens) break;
    chosen.push({
      group: g,
      persisted: true,
      files: archivedLabel ? [archivedLabel] : [],
    });
    chosenTokens += g.reduce((s, ep) => s + ep.tokens, 0);
  }
  const chosenEpisodes = chosen.reduce((s, c) => s + c.group.length, 0);

  const markerLines = chosen.map(({ group, persisted, files }) =>
    groupMarker(group, messages, persisted, files),
  );

  log(
    `[evict] 计划驱逐 ${chosenEpisodes} 个回合（${chosen.length} 块）/ 约 ${chosenTokens} tokens，另有 ${blockCandidates.length} 个可驱逐摘要块（${blockCandidates.reduce((s, u) => s + u.summaryChars, 0)} 字符）（目标线 ${(evict.target * 100).toFixed(0)}%，睡眠闸门=sleep.json）；${
      evict.dryRun ? "dryRun，仅观察不扔" : "执行驱逐"
    }`,
  );

  if (evict.dryRun) {
    if (trace) {
      trace.reason = `dryRun 模式下只观察不执行（预估可驱逐 ${chosenTokens} tokens）`;
    }
    return null;
  }

  // 真驱逐：逐个范围尝试 applyCompression，失败的范围跳过（而不是一次传
  // 全批）。kernel 的 applyCompression 是「全批拒绝」——只要有一个范围触碰
  // tool-pair/保护区边界或 BLOCKED ref，整批都返回 0 block（2026-11-03 实测
  // 519 块全被拒）。逐块尝试能让能折叠的那部分照样落地，水位随之下降。
  let newState: CompressionState = state;
  let appliedCount = 0;
  let appliedTokens = 0;
  for (let idx = 0; idx < chosen.length; idx++) {
    const { group } = chosen[idx]!;
    const startRaw = baseId(messages[group[0]!.start]!.id);
    const endRaw = baseId(messages[group[group.length - 1]!.end - 1]!.id);
    const startRef = newState.messageRefs.byRaw[startRaw];
    const endRef = newState.messageRefs.byRaw[endRaw];
    if (isBadRef(startRef) || isBadRef(endRef)) {
      log(
        `[evict] 跳过范围（ref 无效/BLOCKED）：${startRaw}..${endRaw} (${startRef}..${endRef})`,
      );
      continue;
    }
    const groupChars = charsInGroup(messages, group);
    try {
      const res = core.applyCompression({
        ranges: [{ startRef, endRef, summary: markerLines[idx]! }],
        messages,
        state: newState,
        config,
        protectedMessageIds: protectedIds,
      });
      if (res.result.blocksCreated === 0) {
        // 小块被 kernel 的 minCompressRange 挡了：水位已经过线，这一块的原文
        // 又确实可以扔掉，就临时把阈值降到 0 再试一次。大块保持原规则。
        if (groupChars < minChars) {
          const retry = core.applyCompression({
            ranges: [{ startRef, endRef, summary: markerLines[idx]! }],
            messages,
            state: newState,
            config: { ...config, compress: { ...config.compress, minCompressRange: 0 } },
            protectedMessageIds: protectedIds,
          });
          if (retry.result.blocksCreated > 0) {
            newState = retry.state;
            appliedCount++;
            appliedTokens += group.reduce((s, ep) => s + ep.tokens, 0);
            log(
              `[evict] 小块放行（${groupChars} 字符 < 阈值 ${minChars}，水位已过线）：${startRef}..${endRef}`,
            );
            continue;
          }
        }
        // errors 为空不一定是 bug：kernel 对「已经折叠过的范围」走 noop
        // 分支，只给 warnings 不给 errors（#4521），以前落成「未知原因」。
        const detail =
          res.result.errors.length > 0
            ? res.result.errors.join(" | ")
            : res.result.warnings.length > 0
              ? res.result.warnings.join(" | ")
              : res.result.noop
                ? "noop（范围已经折叠过）"
                : "未知原因";
        log(`[evict] 跳过范围（applyCompression 拒绝）：${startRef}..${endRef} — ${detail.slice(0, 240)}`);
        continue;
      }
      newState = res.state;
      appliedCount++;
      appliedTokens += group.reduce((s, ep) => s + ep.tokens, 0);
    } catch (err) {
      log(
        `[evict] 跳过范围（异常）：${startRef}..${endRef} — ${String(err).slice(0, 240)}`,
      );
      continue;
    }
  }

  // ── 驱逐重做：把选中的 active 摘要块换成一行 evicted 标记 ──────────────
  // 顺序必须是「先 deactivate 旧块 → 再对同一范围 applyCompression 造新块」：
  // 反了会被 kernel 判「范围已经折叠过」noop。且每块原子化 —— 任一步失败
  // 就丢弃临时 state，绝不提交只 deactivate 的状态，否则 prune 会把原文
  // 恢复出来，上下文反而变大。新块的 summary 就是那行标记，复用 kernel 的
  // block/coverage 机制，不新增 state 结构；旧块标 active:false 不再注入，
  // 视图里那块长摘要就此消失。
  let appliedBlocks = 0;
  let reclaimedBlockChars = 0;
  for (const unit of blockCandidates) {
    const marker = `[evicted: 块 ${unit.blockId} · 折叠于 ${new Date(unit.createdTurn).toISOString().slice(11, 16)} · 原文 ${unit.effectiveMessageIds.length} 条]`;
    const range = [{ startRef: unit.startRef, endRef: unit.endRef, summary: marker }];
    const trialState = deactivateBlock(newState, [unit.blockId]);
    try {
      let res = core.applyCompression({
        ranges: range,
        messages,
        state: trialState,
        config,
        protectedMessageIds: protectedIds,
      });
      if (res.result.blocksCreated === 0) {
        // 同 Episode 逻辑：被 minCompressRange 挡住时降阈值再试一次。
        res = core.applyCompression({
          ranges: range,
          messages,
          state: trialState,
          config: { ...config, compress: { ...config.compress, minCompressRange: 0 } },
          protectedMessageIds: protectedIds,
        });
      }
      if (res.result.blocksCreated === 0) {
        log(`[evict] 跳过摘要块（applyCompression 拒绝）：${unit.blockId} ${unit.startRef}..${unit.endRef}`);
        continue; // 不提交 trialState
      }
      newState = res.state; // 原子提交
      appliedBlocks++;
      reclaimedBlockChars += Math.max(0, unit.summaryChars - marker.length);
    } catch (err) {
      log(`[evict] 跳过摘要块（异常）：${unit.blockId} — ${String(err).slice(0, 240)}`);
      continue; // 不提交 trialState
    }
  }
  if (appliedBlocks > 0) {
    log(`[evict] 扔摘要块：${appliedBlocks} 块 / ${reclaimedBlockChars} 字符`);
    appliedTokens += Math.ceil(reclaimedBlockChars / 4);
  }

  if (appliedCount === 0 && appliedBlocks === 0) {
    log("[evict] 所有范围都被 applyCompression 拒绝，无可驱逐内容");
    if (trace) {
      trace.reason = `水位已过线、也已落盘，但 ${chosen.length} 块回合 / ${blockCandidates.length} 个摘要块全部被 kernel 拒绝（原因见 bili.log）`;
    }
    return null;
  }

  log(
    `[evict] applyCompression 成功折叠 ${appliedCount} 个范围（约 ${appliedTokens} tokens），跳过 ${chosen.length - appliedCount} 个`,
  );

  let newMessages: CoreMessage[];
  try {
    newMessages = prune(messages, newState, { injectSummaries: true });
  } catch (err) {
    log(`[evict] prune 失败，放弃驱逐：${String(err)}`);
    return null;
  }

  log(
    `[evict] 已驱逐 ${appliedCount} 个范围 + ${appliedBlocks} 个摘要块（约 ${appliedTokens} tokens，跳过 ${chosen.length - appliedCount} 个范围）→ 视图 ${messages.length} → ${newMessages.length} 条`,
  );
  return {
    messages: newMessages,
    state: newState,
    evictedCount: appliedCount + appliedBlocks,
    reclaimedTokens: appliedTokens,
  };
}

// ── 请求 lane 的自动触发 ───────────────────────────────────────────────────
// DSH 这条部署的真实请求走 server 的 prepare-anthropic / prepare-openai
// （kernel processTurn + preflightCompressIfNeeded），并不经过 loop/core.ts
// 的 ACP 回合循环 —— 2026-11-03 实测 bili.log 里 `[evict-diag]` 一条没有。
// 自动驱逐必须挂在请求 lane 上，否则永远不会跑。

let autoConfigCache: { at: number; config: EvictConfig } | null = null;

/** 自动触发用的配置：进程环境 + 配置文件，2 秒内复用（每个请求都会调）。 */
export function currentEvictConfig(): EvictConfig {
  const now = Date.now();
  if (autoConfigCache && now - autoConfigCache.at < 2000) {
    return autoConfigCache.config;
  }
  let fileEvict: unknown;
  try {
    fileEvict = loadConfigFile().evict;
  } catch {
    fileEvict = undefined;
  }
  const config = resolveEvictConfig(fileEvict, process.env);
  autoConfigCache = { at: now, config };
  return config;
}

export interface LastRequestSnapshot {
  messages: CoreMessage[];
  tokens: number;
  at: number;
}

// 每轮请求的原始消息快照，只给手动端点用。放 WeakMap 不落盘：空闲时
// session.lastMessages 会被折叠成 3 条视图（persist.ts 的 foldResidentTail），
// 手动驱逐拿它几乎看不到候选。
const lastRequestSnapshots = new WeakMap<object, LastRequestSnapshot>();

export function noteLastRequest(
  session: object,
  messages: CoreMessage[],
  tokens: number,
): void {
  if (messages.length > 0) {
    lastRequestSnapshots.set(session, { messages, tokens, at: Date.now() });
  }
}

export function lastRequestSnapshot(session: object): LastRequestSnapshot | undefined {
  return lastRequestSnapshots.get(session);
}

/**
 * 请求 lane 里的自动驱逐：水位（tokenCount / config.modelContextLimit）超过
 * budget 时，把已落盘的旧回合折叠成 `[evicted: …]` 标记。成功时成对改写
 * turn.messages 与 turn.state；调用方仍负责把 outcome.state 写回 session。
 */
export function autoEvictTurn(
  core: CompressionCore,
  sessionId: string,
  turn: { messages: CoreMessage[]; state: CompressionState },
  config: Config,
  tokenCount: number,
  log: (level: string, msg: string) => void,
  /** 宿主报的可用窗口（effectiveContextLimit）。不传就退回 config 的默认值。 */
  limitOverride?: number,
): EvictOutcome | null {
  const evict = currentEvictConfig();
  if (!evict.enabled) return null;
  if (!sessionSelected(sessionId, evict.sessions)) return null;
  log(
    "info",
    `[evict-diag] sid=${sessionId} hit=true enabled=true budget=${evict.budget} target=${evict.target} limit=${
      limitOverride && limitOverride > 0 ? limitOverride : config.modelContextLimit
    } tokens=${tokenCount} dryRun=${evict.dryRun} check=${evict.persistCheck} writeTools=${evict.writeTools.length} sessions=${JSON.stringify(evict.sessions ?? [])}`,
  );
  const trace: { reason?: string } = {};
  const outcome = maybeEvict(
    core,
    turn.messages,
    turn.state,
    config,
    tokenCount,
    evict,
    (m) => log("info", `[evict][${sessionId}] ${m}`),
    limitOverride,
    trace,
    sessionId,
  );
  // 自动路径每个请求都会跑：成功的逐条记，失败的由 recordEviction 按
  // (trigger, sid, reason) 60s 去重，不把 JSONL 写爆。
  const limit = limitOverride && limitOverride > 0 ? limitOverride : config.modelContextLimit;
  const beforeRatio = limit > 0 ? tokenCount / limit : null;
  const afterRatio = limit > 0
    ? Math.max(0, tokenCount - (outcome?.reclaimedTokens ?? 0)) / limit
    : null;
  recordEviction({
    trigger: "auto",
    sessionId,
    evictedCount: outcome?.evictedCount ?? 0,
    reclaimedTokens: outcome?.reclaimedTokens ?? 0,
    beforeRatio,
    afterRatio: outcome ? afterRatio : beforeRatio,
    dryRun: evict.dryRun,
    reason: outcome ? "" : (trace.reason ?? "没有可驱逐的内容"),
    tokensSource: "unknown",
  });
  if (!outcome) return null;
  turn.messages = outcome.messages;
  // 消息与 state 必须成对更新。只写 messages 会让下游
  // stripKernelSummaries(turn.messages, turn.state) 拿着旧 state 查不到新折叠块
  // （2026-11-06 代码 review 第 1 条）。
  turn.state = outcome.state;
  return outcome;
}
