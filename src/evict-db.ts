/**
 * 补丁二（2026-11-08）：驱逐专用的 **只读** index.db 视图。
 *
 * 为什么需要它：运行时 `state.blocks` 只有 ref，没有 seq（`startSeq/endSeq` 是
 * kernel 的可选字段，真实会话里 21 个 active 块一个都没有）；而 `index.db` 的
 * `blocks` 表每行都有 `start_seq/end_seq`（messages 主键的一半，单调递增、永不
 * 重编号）。补丁二的原则是「seq 当裁判，ref 当证人」，所以判定所需 seq 全部
 * 从这里按 session_id 查。
 *
 * 安全约束（文档第五节）：
 *  - 全程 `PRAGMA query_only = ON`，只执行 SELECT，绝不写、不动 unified/legacy
 *    drift 逻辑、不删消息。
 *  - 用项目自带的 storage/driver（自动选 node:sqlite / better-sqlite3），不静态
 *    import node:sqlite —— 老 Node 上没有该模块时不会崩，而是优雅降级。
 *  - 引擎不可用 / 表缺失 / 查询异常 → 返回 null，调用方保守降级（闸门关、不扔块）。
 *  - 每个会话的 block spans 与 ref→seq 映射按 DB 文件 mtime 缓存，避免每次驱逐
 *    重扫 12 万行（文档 2.3「启动从 DB 加载时顺手建，不要每次现查」）。
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./storage/driver.js";
import { sessionsDir } from "./paths.js";
import type { CompressionState, CoreMessage } from "acp-kernel";

export interface BlockSpanRow {
  blockId: string;
  startSeq: number | null;
  endSeq: number | null;
  /** DB 里存的是 ref_num（INTEGER），不是 "m17107" 字符串。 */
  startRefNum: number | null;
  endRefNum: number | null;
  active: boolean;
  ord: number;
}

export interface EvictDbView {
  readonly available: boolean;
  /** mNNNNN → 该会话里这条消息的 seq（必须带 session_id，m 编号每会话各一套）。 */
  boundarySeqForRef(sessionId: string, refNum: number): number | null;
  /** seq → msg_id，用来把 boundarySeq 映回视图里的消息下标。 */
  boundaryMsgIdForSeq(sessionId: string, seq: number): string | null;
  /** 该会话全部块的 seq/ref 区间（按 blockId 索引）。 */
  blockSpans(sessionId: string): Map<string, BlockSpanRow> | null;
  /** ref_num → seq，用于 2.3 的 ref 对账；查不到返回 undefined。 */
  messageSeqByRef(sessionId: string): Map<number, number> | null;
  /** 该会话最大 seq（boundaryFromSleep=false 时按水位取封盘线用）。 */
  maxSeq(sessionId: string): number | null;
  /** seq → ref_num：存量块没写 ref 时，用它反查给 applyCompression 造 range
   *  （文档 2.4 附录的「seq 17059 → m15066」）。 */
  refNumForSeq(sessionId: string, seq: number): number | null;
  /** 2.6：重启后 snapshot/lastMessages 都空时，从 DB 组一个最小视图。 */
  minimalView(
    sessionId: string,
    boundarySeq: number,
    state: CompressionState,
  ): CoreMessage[] | null;
  close(): void;
}

interface SessionCache {
  mtimeMs: number;
  spans: Map<string, BlockSpanRow> | null;
  seqByRef: Map<number, number> | null;
  maxSeq: number | null;
}

const cacheBySession = new Map<string, SessionCache>();

/** 进程级单例：一条只读连接 + 按 mtime 失效的会话缓存。避免每轮请求都新开
 *  sqlite 连接（文档 2.3「启动从 DB 加载时顺手建，不要每次现查」）。 */
let singleton: { path: string; mtimeMs: number; db: SqliteDatabase } | null = null;

function sharedDb(dbPath: string): { db: SqliteDatabase; mtimeMs: number } | null {
  try {
    if (!existsSync(dbPath)) return null;
    const mtimeMs = statSync(dbPath).mtimeMs;
    if (singleton && singleton.path === dbPath && singleton.mtimeMs === mtimeMs && singleton.db.open) {
      return { db: singleton.db, mtimeMs };
    }
    if (singleton?.db.open) { try { singleton.db.close(); } catch { /* ignore */ } }
    cacheBySession.clear();
    const db = openSqliteDatabase(dbPath).db;
    db.exec("PRAGMA query_only = ON");
    singleton = { path: dbPath, mtimeMs, db };
    return { db, mtimeMs };
  } catch {
    return null;
  }
}

function scalar(row: unknown, key: string): number | string | null {
  if (!row || typeof row !== "object") return null;
  const v = (row as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") return v;
  return null;
}

function rowsOf(db: SqliteDatabase, sql: string, ...args: unknown[]): Record<string, unknown>[] | null {
  try {
    return db.prepare(sql).all(...args) as Record<string, unknown>[];
  } catch {
    return null;
  }
}

function oneOf(db: SqliteDatabase, sql: string, ...args: unknown[]): Record<string, unknown> | null {
  try {
    const r = db.prepare(sql).get(...args);
    return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function openEvictDb(): EvictDbView {
  const dbPath = path.join(sessionsDir(), "index.db");
  const opened = sharedDb(dbPath);
  const db = opened?.db ?? null;
  const mtimeMs = opened?.mtimeMs ?? 0;

  if (!db) {
    const unavailable: EvictDbView = {
      available: false,
      boundarySeqForRef: () => null,
      boundaryMsgIdForSeq: () => null,
      blockSpans: () => null,
      messageSeqByRef: () => null,
      maxSeq: () => null,
      refNumForSeq: () => null,
      minimalView: () => null,
      close: () => {},
    };
    return unavailable;
  }
  const handle = db;

  const freshCache = (sessionId: string): SessionCache => {
    const hit = cacheBySession.get(sessionId);
    if (hit && hit.mtimeMs === mtimeMs) return hit;

    const spanRows = rowsOf(
      handle,
      "SELECT block_id, start_seq, end_seq, start_ref, end_ref, active, ord FROM blocks WHERE session_id = ?",
      sessionId,
    );
    const spans = new Map<string, BlockSpanRow>();
    if (spanRows) {
      for (const r of spanRows) {
        const id = scalar(r, "block_id");
        if (typeof id !== "string") continue;
        const num = (k: string): number | null => {
          const v = scalar(r, k);
          return typeof v === "number" ? v : null;
        };
        spans.set(id, {
          blockId: id,
          startSeq: num("start_seq"),
          endSeq: num("end_seq"),
          startRefNum: num("start_ref"),
          endRefNum: num("end_ref"),
          active: num("active") === 1,
          ord: num("ord") ?? 0,
        });
      }
    }

    const refRows = rowsOf(
      handle,
      "SELECT seq, ref_num FROM messages WHERE session_id = ? AND ref_num IS NOT NULL AND retired_at IS NULL",
      sessionId,
    );
    const seqByRef = new Map<number, number>();
    if (refRows) {
      for (const r of refRows) {
        const seq = scalar(r, "seq");
        const refNum = scalar(r, "ref_num");
        if (typeof seq !== "number" || typeof refNum !== "number") continue;
        // 同一 ref_num 理论上唯一；万一重复取最小 seq（最靠前的证人）。
        const prev = seqByRef.get(refNum);
        if (prev === undefined || seq < prev) seqByRef.set(refNum, seq);
      }
    }
    const maxRow = oneOf(handle, "SELECT MAX(seq) AS m FROM messages WHERE session_id = ?", sessionId);
    const maxVal = maxRow ? scalar(maxRow, "m") : null;

    const entry: SessionCache = {
      mtimeMs,
      spans: spanRows ? spans : null,
      seqByRef: refRows ? seqByRef : null,
      maxSeq: typeof maxVal === "number" ? maxVal : null,
    };
    cacheBySession.set(sessionId, entry);
    return entry;
  };

  return {
    available: true,
    boundarySeqForRef(sessionId, refNum) {
      const row = oneOf(
        handle,
        "SELECT seq FROM messages WHERE session_id = ? AND ref_num = ? AND retired_at IS NULL ORDER BY seq LIMIT 1",
        sessionId,
        refNum,
      );
      const v = row ? scalar(row, "seq") : null;
      return typeof v === "number" ? v : null;
    },
    boundaryMsgIdForSeq(sessionId, seq) {
      const row = oneOf(
        handle,
        "SELECT msg_id FROM messages WHERE session_id = ? AND seq = ? ORDER BY seq LIMIT 1",
        sessionId,
        seq,
      );
      const v = row ? scalar(row, "msg_id") : null;
      return typeof v === "string" ? v : null;
    },
    blockSpans(sessionId) {
      return freshCache(sessionId).spans;
    },
    messageSeqByRef(sessionId) {
      return freshCache(sessionId).seqByRef;
    },
    maxSeq(sessionId) {
      return freshCache(sessionId).maxSeq;
    },
    refNumForSeq(sessionId, seq) {
      const row = oneOf(
        handle,
        "SELECT ref_num FROM messages WHERE session_id = ? AND seq = ? AND ref_num IS NOT NULL AND retired_at IS NULL LIMIT 1",
        sessionId,
        seq,
      );
      const v = row ? scalar(row, "ref_num") : null;
      return typeof v === "number" ? v : null;
    },
    minimalView(sessionId, boundarySeq, state) {
      // 2.6 兜底：boundarySeq 之后的消息 + active 块的 summary 占位。
      // 视图只需要让 maybeEvict / applyCompression 能定位 ref 边界，正文用空串，
      // 不重放 content CAS（那会拖慢且没必要）。
      const msgRows = rowsOf(
        handle,
        "SELECT seq, msg_id, ref, role, kind FROM messages WHERE session_id = ? AND seq > ? AND retired_at IS NULL ORDER BY seq",
        sessionId,
        boundarySeq,
      );
      if (!msgRows) return null;
      const out: CoreMessage[] = [];
      for (const r of msgRows) {
        const id = scalar(r, "msg_id");
        if (typeof id !== "string") continue;
        const role = scalar(r, "role");
        const kind = scalar(r, "kind");
        out.push({
          id,
          role: (typeof role === "string" ? role : "user") as CoreMessage["role"],
          contentType: (kind === "tool-result" ? "tool-result" : "text") as CoreMessage["contentType"],
          text: "",
          ledgerSeq: typeof scalar(r, "seq") === "number" ? (scalar(r, "seq") as number) : undefined,
        } as CoreMessage);
      }
      // active 块的 summary 占位：prune 注入的渲染摘要形如 acp_summary_<blockId>。
      // 这些行让视图里保留「块还在」的证据，避免最小视图看起来像空会话。
      for (const b of state.blocks) {
        if (!b.active) continue;
        out.push({
          id: `acp_summary_${b.blockId}`,
          role: "system",
          contentType: "text",
          text: b.summary ?? "",
        } as CoreMessage);
      }
      return out;
    },
    close() {
      // 连接是进程级单例，由 sharedDb 的 mtime 检查统一回收；单个 view 不关，
      // 否则下一次驱逐拿到的就是已关闭的句柄。
    },
  };
}
