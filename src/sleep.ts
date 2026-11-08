/**
 * 睡眠闸门（sleep.json）：驱逐对话原文的唯一开关。
 *
 * 设计（《驱逐插件-小洄的想法》）：
 *  - 「睡着」= 当天已经道晚安、记忆写完、handoff 已经归档出文件；由人写
 *    `~/.dsh/heart/sleep.json` 作为唯一凭据。
 *  - boundary 是睡前最后一条消息的 ref（如 `m09162`），插件在消息数组里找它，
 *    切在它前面：boundary 之前 = 已封盘，可以整段丢；之后一根汗毛不动。
 *  - tail 是那条消息前 ~30 字，ref 失效（重放 / 换会话 / ref 号重置）时靠它认。
 *  - 两个都找不到，就完全不动 —— 宁可少丢，不能丢错。
 *  - archived 指向 handoff 产出的归档文件，必须存在且非空，否则不认这个标记。
 *
 * 补丁二（2026-11-08）：
 *  - sleep.json 加会话身份 `sessionId`。m 编号每会话各一套，同一份全局
 *    sleep.json 拿去量多个会话是错的；身份不符一律关闸门。
 *  - `boundarySeq` 优先（seq 单调递增、永不重编号），没有则用 `boundary`
 *    的 mNNNNN 查 index.db 换 seq（**必须带 session_id**）。
 *  - 老文件无 sessionId：仅当唯一一个会话开着驱逐时按老逻辑继续并打迁移警告，
 *    否则关闸门。
 *  - reason 分级：不再把所有失败合成一句「找不到」。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CompressionState, CoreMessage } from "acp-kernel";
import type { EvictDbView } from "./evict-db.js";

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
  /** handoff 归档文件，相对 stt 根。 */
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
  sttRoot?: string;
  /** 当前会话 id（补丁二：验 sleep.json 身份）。 */
  sessionId?: string;
  /** 开着驱逐的会话数（去掉 "*" 后的唯一 base 数）；老文件迁移判定用。 */
  evictingSessionCount?: number;
  /** 只读 DB 视图；缺省时 boundary 的 mNNNNN 无法换 seq。 */
  db?: EvictDbView;
  /** 4.3 配置项：false 时完全忽略 sleep.json，只按水位触发。 */
  boundaryFromSleep?: boolean;
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

export function dshHomeDir(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? path.resolve(expandHome(env)) : path.join(homedir(), ".dsh");
}

export function sleepFilePath(explicit?: string): string {
  const p = explicit?.trim();
  if (p) return path.resolve(expandHome(p));
  return path.join(dshHomeDir(), "heart", "sleep.json");
}

/** stt 根：桌面 profile 下的 stt（say.mjs / daily / old-session 都在那里）。 */
export function sttRootDir(explicit?: string): string {
  const p = explicit?.trim();
  if (p) return path.resolve(expandHome(p));
  const home = dshHomeDir();
  const candidates = [
    path.join(home, "profiles", "desktop", "stt"),
    path.join(home, "stt"),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
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
    .replace(/^stt\//, "");
}

/** archived 必须存在、是文件、size>0，且不能跳出 stt 根。 */
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

/** 纯函数：解析 boundary 的 seq + reason 分级。导出供单测直接验（验收 1/2/3）。 */
export function resolveBoundarySeq(
  marker: SleepMarker,
  opts: {
    sessionId?: string;
    evictingSessionCount?: number;
    db?: EvictDbView;
  } = {},
): {
  ok: boolean;
  seq?: number;
  how?: SleepGateResult["how"];
  reason?: string;
  migrationWarning?: string;
} {
  const { sessionId, evictingSessionCount, db } = opts;

  // ① 身份校验（文档 2.5 读取顺序第 1 条）
  if (typeof marker.sessionId === "string" && marker.sessionId.trim() !== "") {
    if (!sessionId || marker.sessionId.trim() !== sessionId) {
      return {
        ok: false,
        reason: `边界属于另一个会话（sleep.json.sessionId=${marker.sessionId}，当前=${sessionId ?? "未知"}），闸门关闭，不做任何猜测`,
      };
    }
  } else {
    // 老文件迁移：仅当唯一一个会话开着驱逐时放行，并打迁移警告。
    const n = evictingSessionCount ?? 0;
    if (n > 1) {
      return { ok: false, reason: `sleep.json 缺 sessionId，且当前有 ${n} 个会话开着驱逐，无法判定边界归属，闸门关闭` };
    }
  }

  // ② boundarySeq 优先
  const explicitSeq = marker.boundarySeq;
  if (typeof explicitSeq === "number" && Number.isInteger(explicitSeq) && explicitSeq > 0) {
    return {
      ok: true,
      seq: explicitSeq,
      how: "seq",
      migrationWarning: marker.sessionId ? undefined : "sleep.json 缺 sessionId，已按老逻辑放行；请尽快补写会话身份",
    };
  }

  // ③ boundary 的 mNNNNN 查库换 seq（必须带 session_id）
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
    return {
      ok: true,
      seq,
      how: "ref",
      migrationWarning: marker.sessionId ? undefined : "sleep.json 缺 sessionId，已按老逻辑放行；请尽快补写会话身份",
    };
  }

  // ④ tail：仅当身份对得上时（① 已保证），交给旧逻辑在视图里找
  const tail = typeof marker.tail === "string" ? normalizeTail(marker.tail) : "";
  if (tail.length >= 4) {
    return {
      ok: false,
      reason: `sleep.json 无 boundarySeq、boundary 也不是 mNNNNN；tail 只能定位旧视图，无法给出 seq，闸门关闭（请补 boundarySeq）`,
    };
  }

  // ⑤ 全都没有
  return {
    ok: false,
    reason: "sleep.json 缺 boundarySeq、boundary 不是 mNNNNN、tail 也不可用，无法判定封盘线，闸门关闭",
  };
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

  const file = sleepFilePath(opts.sleepFile);
  const marker = readSleepMarker(file);
  if (!marker) {
    return { ok: false, reason: `没有可用的 sleep.json（${file}），还没封盘，不动` };
  }
  const archivedAbs = verifyArchive(sttRootDir(opts.sttRoot), marker.archived);
  if (!archivedAbs) {
    return {
      ok: false,
      reason: `sleep.json 的 archived 校验没通过（${marker.archived ?? "空"}），不认这个标记`,
    };
  }

  const seqResult = resolveBoundarySeq(marker, {
    sessionId: opts.sessionId,
    evictingSessionCount: opts.evictingSessionCount,
    db: opts.db,
  });
  if (!seqResult.ok || seqResult.seq === undefined) {
    return { ok: false, reason: seqResult.reason };
  }
  if (seqResult.migrationWarning) {
    // 由调用方 log 打出去（这里不直接 log，保持纯函数语义）。
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
    migrationWarning: seqResult.migrationWarning,
  };
}
