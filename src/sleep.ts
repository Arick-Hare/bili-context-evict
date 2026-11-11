/**
 * 睡眠闸门（sleep.json）：驱逐对话原文的唯一开关。
 *
 * 这是本插件唯一的「人/外部系统确认」接口，与任何记忆系统的实现无关：
 *  - 「封盘」= 边界之前的对话原文已经在你自己的存储里留了底。写一份
 *    per-session `sleep.json` 作为凭据，插件才允许驱逐那之前的原文。
 *  - `boundarySeq` 是封盘线的 seq（优先），或 `boundary` 的 `mNNNNN` 由
 *    `index.db` 按 session_id 换算。切在它前面：之前可整段丢，之后不动。
 *  - `archived` 指向归档文件（相对 archiveRoot），必须存在、是文件、非空，
 *    且不能跳出归档根；否则不认这个标记。
 *  - `tail` 是边界消息前 ~30 字，仅作诊断/旧视图定位，不能当封盘线。
 *  - 任何一项缺失或校验不过 → 关闸门，完全不动。宁可少丢，不能丢错。
 *
 * 路径全部走 `evictRoot()`（XDG_CONFIG_HOME / BILI_EVICT_ROOT），不依赖
 * 宿主私有的记忆目录。旧的 `~/.dsh/heart/sleep.json` 只在一次性迁移时读。
 *
 * 会话隔离（2026-11-08，针对一次「新会话拿旧边界」事故）：
 *  - 每会话一份 marker：`<evictRoot>/sessions/<sessionId>/sleep.json`；
 *    读不到就关闸门（`no-session-marker`），**不回落全局文件**。
 *  - `boundarySeq > 该会话 max(seq)` → 关闸门（`boundary-beyond-session`）。
 */
import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CompressionState, CoreMessage } from "acp-kernel";
import type { EvictDbView } from "./evict-db.js";
import { evictRoot } from "./paths.js";

export interface SleepMarker {
  /** ISO 时间，写标记的时刻。 */
  at?: string;
  /** 该标记属于哪个会话（补丁二：m 编号每会话各一套，必须验身份）。 */
  sessionId?: string;
  /** 睡前最后一条消息的 ref（`m09162`）或原始 id。 */
  boundary?: string;
  /** 睡前最后一条消息的 seq（补丁二：优先用，不用 ref 猜）。 */
  boundarySeq?: number;
  /** 回合序号，只给人看，不参与定位。 */
  turn?: number | string;
  /** boundary 消息前 ~30 字，ref 失效时按原文兜底定位。 */
  tail?: string;
  /** 归档对应的日期（`2026-11-02`）。 */
  day?: string;
  /** 归档文件，相对 archiveRoot（默认 `<evictRoot>/archive`）。必须存在、是文件、非空。 */
  archived?: string;
}

export interface SleepGateResult {
  ok: boolean;
  reason?: string;
  /** 消息数组里的 boundary 下标；[0, boundaryIndex) 已封盘。 */
  boundaryIndex?: number;
  /** 补丁二：boundary 的 seq（块候选判定用，消息下标不持久化）。 */
  boundarySeq?: number;
  marker?: SleepMarker;
  /** 校验通过后的归档绝对路径。 */
  archivedAbs?: string;
  /** 定位方式，写日志用。 */
  how?: "seq" | "ref" | "id" | "tail" | "waterline";
  /** 老文件（无 sessionId）走迁移路径时给调用方打一条警告。 */
  migrationWarning?: string;
  /** boundaryFromSleep=false 时按水位触发，闸门恒开。 */
  fromWaterline?: boolean;
}

export interface SleepGateOpts {
  sleepFile?: string;
  /** 归档根目录（推荐名）。 */
  archiveRoot?: string;
  /** @deprecated 用 archiveRoot；保留以兼容旧配置。 */
  sttRoot?: string;
  /** 当前会话 id（会话隔离：决定读哪个目录的 marker，并对账 max(seq)）。 */
  sessionId?: string;
  /** 只读 DB 视图；缺省时 boundary 的 mNNNNN 无法换 seq、max(seq) 也无法对账。 */
  db?: EvictDbView;
  /** 4.3 配置项：false 时完全忽略 sleep.json，只按水位触发。 */
  boundaryFromSleep?: boolean;
  /** 可选日志回调：关闸门时（尤其 boundary-beyond-session）打出 warn。 */
  log?: (msg: string) => void;
}

function baseId(id: string): string {
  const h = id.indexOf("#");
  return h > 0 ? id.slice(0, h) : id;
}

function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(homedir(), t.slice(2));
  return t;
}

/** 仅用于兼容旧部署的一次性迁移；新代码不得把它当默认路径。 */
export function dshHomeDir(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? path.resolve(expandHome(env)) : path.join(homedir(), ".dsh");
}

/** 旧的私有部署全局 marker 路径（迁移源）。 */
export function legacySleepFilePath(): string {
  return path.join(dshHomeDir(), "heart", "sleep.json");
}

/**
 * 通用部署的全局 marker 路径：`<evictRoot>/sleep.json`。
 * 只是「全局」入口；闸门实际读的是 per-session 文件，见 sleepMarkerPath。
 */
export function sleepFilePath(explicit?: string): string {
  const p = explicit?.trim();
  if (p) return path.resolve(expandHome(p));
  return path.join(evictRoot(), "sleep.json");
}

/**
 * 会话隔离：每会话一份 marker。
 * `<evictRoot>/sessions/<sessionId>/sleep.json`（XDG 感知，不写死盘符/用户，
 * 也不依赖任何宿主私有目录）。
 */
export function sleepMarkerPath(sessionId: string): string {
  const sid = String(sessionId ?? "").trim();
  return path.join(evictRoot(), "sessions", sid, "sleep.json");
}

/** 只读该会话的 marker；目录或文件不存在返回 null（关闸门依据）。 */
export function readSleepMarkerForSession(sessionId: string): SleepMarker | null {
  return readSleepMarker(sleepMarkerPath(sessionId));
}

/** 原子写 JSON：先写 `<file>.tmp` 再 rename 覆盖，防写到一半断电留半截。 */
export function atomicWriteJson(file: string, obj: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

let migrationDone = false;
/**
 * 一次性迁移：把「全局」sleep.json 收编成 per-session marker，原文件改名
 * `.migrated-<日期>` 不删。模块级只跑一次，读不到任何来源就什么都不做。
 *
 * 来源优先级：显式配置路径 → 通用全局 `<evictRoot>/sleep.json` → 旧私有部署
 * `~/.dsh/heart/sleep.json`（仅为兼容，插件本身不再依赖该目录）。
 *  - 有 sessionId → 收编到该会话目录；无 → `_legacy/`，不参与驱逐。
 *  - 目标已存在 → 不覆盖，只把来源文件改名让路。
 */
export function ensureSleepMigration(evict: { sleepFile?: string }, log?: (msg: string) => void): void {
  if (migrationDone) return;
  migrationDone = true;
  const candidates = [
    evict.sleepFile?.trim() ? path.resolve(expandHome(evict.sleepFile)) : "",
    sleepFilePath(),
    legacySleepFilePath(),
  ].filter((p) => p !== "");
  const global = candidates.find((p) => existsSync(p) && readSleepMarker(p) !== null);
  if (!global) return;
  const marker = readSleepMarker(global);
  const sid = typeof marker?.sessionId === "string" && marker.sessionId.trim() !== "" ? marker.sessionId.trim() : "_legacy";
  const target = sleepMarkerPath(sid);
  const dir = path.dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(target)) {
    // 该会话已有 per-session marker（用户新建的），不要覆盖，只把全局文件让路。
    safeRenameAway(global);
    log?.(`[sleep][migrate] 会话 ${sid} 已有 per-session marker，全局 ${global} 已让路（改名），未覆盖`);
    return;
  }
  try {
    copyFileSync(global, target);
    safeRenameAway(global);
    log?.(`[sleep][migrate] 全局 ${global} 已复制到 ${target}，原文件改名保留`);
  } catch (e) {
    log?.(`[sleep][migrate] 复制失败，保持原文件不动：${String(e).slice(0, 200)}`);
  }
}

/** 把全局文件改名 `<file>.migrated-<YYYYMMDD>`（内容还在，不删）。 */
function safeRenameAway(file: string): void {
  try {
    const tag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    renameSync(file, `${file}.migrated-${tag}`);
  } catch {
    /* 改名失败不致命：下次仍会重试（migrationDone 已置位，不会重复复制） */
  }
}

/**
 * 归档根：sleep.json 里 `archived` 相对路径的基准。
 * 默认 `<evictRoot>/archive`，与宿主无关；显式 archiveRoot/sttRoot 优先。
 * 旧私有部署的 `profiles/desktop/stt` 仅在确实存在时作兼容回退，插件不依赖它。
 */
export function archiveRootDir(explicit?: string): string {
  const p = explicit?.trim();
  if (p) return path.resolve(expandHome(p));
  const generic = path.join(evictRoot(), "archive");
  if (existsSync(generic)) return generic;
  const home = dshHomeDir();
  const legacy = [
    path.join(home, "profiles", "desktop", "stt"),
    path.join(home, "stt"),
  ].find((c) => existsSync(c));
  return legacy ?? generic;
}

/** @deprecated 用 archiveRootDir；保留名字以兼容已有配置与调用方。 */
export function sttRootDir(explicit?: string): string {
  return archiveRootDir(explicit);
}

export function readSleepMarker(file: string): SleepMarker | null {
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SleepMarker;
  } catch {
    return null;
  }
}

function normalizeArchived(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^(?:archive|archives|stt)\//, "");
}

/** archived 必须存在、是文件、size>0，且不能跳出归档根。 */
export function verifyArchive(sttRoot: string, archived?: string): string | null {
  if (!archived || !archived.trim()) return null;
  const root = path.resolve(sttRoot);
  const abs = path.resolve(root, normalizeArchived(archived.trim()));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const st = statSync(abs);
    if (st.isFile() && st.size > 0) return abs;
  } catch {
    return null;
  }
  return null;
}

function normalizeTail(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** `mNNNNN` → 数值 ref_num；不是这个形式返回 null。 */
export function boundaryRefNum(boundary: string): number | null {
  const m = /^m(\d+)$/.exec(boundary.trim());
  return m ? Number(m[1]) : null;
}

/**
 * 把 boundarySeq 映回消息数组下标：
 *  1. 消息自带 ledgerSeq → 直接匹配；
 *  2. 否则查 DB 得 boundarySeq 的 msg_id，再按 id 找；
 *  3. 都不行 → null（调用方保守处理：不让 Episode 进候选，但块候选仍可用 seq）。
 * 不持久化数组下标（重启 / 裁剪 / 块合并后都会变，seq 不会）。
 */
export function resolveBoundaryIndexBySeq(
  messages: CoreMessage[],
  state: CompressionState,
  marker: SleepMarker,
  boundarySeq: number,
  db?: EvictDbView,
  sessionId?: string,
): { index: number; how: "seq" } | null {
  for (let i = 0; i < messages.length; i++) {
    const s = (messages[i] as CoreMessage & { ledgerSeq?: number }).ledgerSeq;
    if (typeof s === "number" && s === boundarySeq) return { index: i, how: "seq" };
  }
  if (db?.available && sessionId) {
    const msgId = db.boundaryMsgIdForSeq(sessionId, boundarySeq);
    if (msgId) {
      const base = baseId(msgId);
      for (let i = 0; i < messages.length; i++) {
        if (baseId(messages[i]!.id) === base) return { index: i, how: "seq" };
      }
    }
    // 备用：boundary 的 ref 在 byRaw 里能反查到 raw id 时，也用来定位下标。
    const boundary = typeof marker.boundary === "string" ? marker.boundary.trim() : "";
    if (boundary) {
      const byRaw = state.messageRefs?.byRaw ?? {};
      let raw: string | undefined;
      for (const [id, ref] of Object.entries(byRaw)) {
        if (ref === boundary) { raw = baseId(id); break; }
      }
      if (raw) {
        for (let i = 0; i < messages.length; i++) {
          if (baseId(messages[i]!.id) === raw) return { index: i, how: "seq" };
        }
      }
    }
  }
  return null;
}

/** 旧逻辑（补丁一及之前）：只在当前视图里按 ref / id / tail 定位。保留作回落。 */
export function resolveBoundaryIndex(
  messages: CoreMessage[],
  state: CompressionState,
  marker: SleepMarker,
): { index: number; how: "ref" | "id" | "tail" } | null {
  const boundary = typeof marker.boundary === "string" ? marker.boundary.trim() : "";
  if (boundary) {
    let raw: string | undefined;
    if (/^m\d+$/.test(boundary)) {
      const byRaw = state.messageRefs?.byRaw ?? {};
      for (const [id, ref] of Object.entries(byRaw)) {
        if (ref === boundary) { raw = baseId(id); break; }
      }
    }
    const target = raw ?? baseId(boundary);
    for (let i = 0; i < messages.length; i++) {
      const id = baseId(messages[i]!.id);
      if (id === target || id === baseId(boundary)) return { index: i, how: raw ? "ref" : "id" };
    }
  }
  const tail = typeof marker.tail === "string" ? normalizeTail(marker.tail) : "";
  if (tail.length >= 4) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = normalizeTail(messages[i]!.text ?? "");
      if (text.includes(tail)) return { index: i, how: "tail" };
    }
  }
  return null;
}

/**
 * 纯函数：解析 boundary 的 seq + reason 分级。导出供单测直接验（验收 1/2/3）。
 * 会话隔离后不再做「sessionId 字段严格校验」（文件位置本身就是身份），
 * 但会多一步 `boundary-beyond-session` 越界校验（boundarySeq 超过该会话
 * 真实 max(seq) 时关闸门，绝不拿别的会话的封盘线量自己）。
 */
export function resolveBoundarySeq(
  marker: SleepMarker,
  opts: {
    sessionId?: string;
    db?: EvictDbView;
    log?: (msg: string) => void;
  } = {},
): {
  ok: boolean;
  seq?: number;
  how?: SleepGateResult["how"];
  reason?: string;
} {
  const { sessionId, db, log } = opts;

  // ① boundarySeq 优先
  const explicitSeq = marker.boundarySeq;
  if (typeof explicitSeq === "number" && Number.isInteger(explicitSeq) && explicitSeq > 0) {
    return beyondCheck(explicitSeq, sessionId, db, "seq", log);
  }

  // ② boundary 的 mNNNNN 查库换 seq（必须带 session_id）
  const boundary = typeof marker.boundary === "string" ? marker.boundary.trim() : "";
  const refNum = boundary ? boundaryRefNum(boundary) : null;
  if (refNum !== null) {
    if (!db?.available) {
      return { ok: false, reason: `boundary（${boundary}）是 ref，但 index.db 只读视图不可用，无法换成 seq，闸门关闭` };
    }
    if (!sessionId) {
      return { ok: false, reason: `boundary（${boundary}）是 ref，但缺少当前 sessionId，无法按会话换 seq（m 编号每会话各一套），闸门关闭` };
    }
    const seq = db.boundarySeqForRef(sessionId, refNum);
    if (seq === null) {
      return { ok: false, reason: `boundary（${boundary}）在 index.db 的 session_id=${sessionId} 里查不到 seq，闸门关闭` };
    }
    return beyondCheck(seq, sessionId, db, "ref", log);
  }

  // ③ tail 只能定位旧视图，无法给出 seq
  const tail = typeof marker.tail === "string" ? normalizeTail(marker.tail) : "";
  if (tail.length >= 4) {
    return {
      ok: false,
      reason: `sleep.json 无 boundarySeq、boundary 也不是 mNNNNN；tail 只能定位旧视图，无法给出 seq，闸门关闭（请补 boundarySeq）`,
    };
  }

  // ④ 全都没有
  return {
    ok: false,
    reason: "sleep.json 缺 boundarySeq、boundary 不是 mNNNNN、tail 也不可用，无法判定封盘线，闸门关闭",
  };
}

/** boundarySeq 超过该会话真实 max(seq) → 越界关闸门（会话隔离核心校验）。 */
function beyondCheck(
  seq: number,
  sessionId: string | undefined,
  db: EvictDbView | undefined,
  how: SleepGateResult["how"],
  log?: (msg: string) => void,
): { ok: boolean; seq?: number; how?: SleepGateResult["how"]; reason?: string } {
  if (db?.available && sessionId) {
    const maxSeq = db.maxSeq(sessionId);
    if (maxSeq !== null && seq > maxSeq) {
      const reason = `boundary 的 boundarySeq=${seq} 超过该会话最大 seq=${maxSeq}，闸门关闭（boundary-beyond-session）`;
      log?.(`[sleep] ${reason}`);
      return { ok: false, reason };
    }
  }
  return { ok: true, seq, how };
}

export function checkSleepGate(
  messages: CoreMessage[],
  state: CompressionState,
  opts: SleepGateOpts = {},
): SleepGateResult {
  // 4.3：boundaryFromSleep=false → 忽略 sleep.json，只按水位触发。
  // 用 DB 的 maxSeq 作为封盘线（当前已存在的全部消息都算封盘），闸门恒开。
  if (opts.boundaryFromSleep === false) {
    if (!opts.db?.available || !opts.sessionId) {
      return { ok: false, reason: "boundaryFromSleep=false 但 index.db 只读视图/sessionId 不可用，无法按水位取封盘线，闸门关闭" };
    }
    const maxSeq = opts.db.maxSeq(opts.sessionId);
    if (maxSeq === null) {
      return { ok: false, reason: "boundaryFromSleep=false 但 index.db 查不到该会话的 max(seq)，闸门关闭" };
    }
    return {
      ok: true,
      boundarySeq: maxSeq,
      boundaryIndex: messages.length,
      how: "waterline",
      fromWaterline: true,
    };
  }

  // 会话隔离：读「本次要驱逐的会话」自己的 marker；读不到直接关闸门，
  // 不回落全局文件（宁可不动，也不能拿别的会话的封盘线量自己）。
  const sid = opts.sessionId;
  if (!sid) {
    return { ok: false, reason: "没有当前会话 id，无法定位 per-session sleep.json，闸门关闭（no-session-marker）" };
  }
  const marker = readSleepMarkerForSession(sid);
  if (!marker) {
    return {
      ok: false,
      reason: `没有该会话的 sleep.json（${sleepMarkerPath(sid)}），还没封盘，闸门关闭（no-session-marker）`,
    };
  }
  const archivedAbs = verifyArchive(
    archiveRootDir(opts.archiveRoot ?? opts.sttRoot),
    marker.archived,
  );
  if (!archivedAbs) {
    return {
      ok: false,
      reason: `sleep.json 的 archived 校验没通过（${marker.archived ?? "空"}），不认这个标记`,
    };
  }

  const seqResult = resolveBoundarySeq(marker, {
    sessionId: opts.sessionId,
    db: opts.db,
    log: opts.log,
  });
  if (!seqResult.ok || seqResult.seq === undefined) {
    return { ok: false, reason: seqResult.reason };
  }

  const boundarySeq = seqResult.seq;
  // boundaryIndex：优先按 seq 定位；定位不到时保守给 0（不让 Episode 进候选），
  // 但闸门仍开、块候选按 seq 判定 —— 这正是补丁二要修的「旧消息被压出视图」。
  const bySeq = resolveBoundaryIndexBySeq(messages, state, marker, boundarySeq, opts.db, opts.sessionId);
  let boundaryIndex = bySeq?.index;
  if (boundaryIndex === undefined) {
    const legacy = resolveBoundaryIndex(messages, state, marker);
    boundaryIndex = legacy?.index ?? 0;
  }
  if (boundaryIndex <= 0) {
    // 不再当失败：老会话里 boundary 消息常已被压出视图，下标 0 是预期情况。
    // Episode 候选会因 idx >= boundaryIndex 全被跳过，但块候选照常按 seq 工作。
  }
  return {
    ok: true,
    boundaryIndex,
    boundarySeq,
    marker,
    archivedAbs,
    how: seqResult.how,
  };
}
