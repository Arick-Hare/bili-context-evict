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
 *  - archived 指向 handoff 产出的归档文件（相对 stt 根，如
 *    `old-session/extract/2026-11-02.md`），必须存在且非空，否则不认这个标记。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CompressionState, CoreMessage } from "acp-kernel";

export interface SleepMarker {
  /** ISO 时间，写标记的时刻。 */
  at?: string;
  /** 睡前最后一条消息的 ref（`m09162`）或原始 id。 */
  boundary?: string;
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
  marker?: SleepMarker;
  /** 校验通过后的归档绝对路径。 */
  archivedAbs?: string;
  /** 定位方式，写日志用。 */
  how?: "ref" | "id" | "tail";
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

/**
 * 在消息数组里定位 boundary：
 *  1. boundary 像 ref（m123）→ 在 state.messageRefs.byRaw 里找值为它的 raw id；
 *  2. boundary 本身就是 raw id → 直接匹配；
 *  3. 都不行且给了 tail → 从数组末尾往前找第一条正文含 tail 的消息（取最靠后的
 *     那条，最多封到那里，宁可少封）。
 */
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
        if (ref === boundary) {
          raw = baseId(id);
          break;
        }
      }
    }
    const target = raw ?? baseId(boundary);
    for (let i = 0; i < messages.length; i++) {
      const id = baseId(messages[i]!.id);
      if (id === target || id === baseId(boundary)) {
        return { index: i, how: raw ? "ref" : "id" };
      }
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

export function checkSleepGate(
  messages: CoreMessage[],
  state: CompressionState,
  opts: { sleepFile?: string; sttRoot?: string } = {},
): SleepGateResult {
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
  const found = resolveBoundaryIndex(messages, state, marker);
  if (!found) {
    return {
      ok: false,
      reason: `sleep.json 的 boundary（${marker.boundary ?? "空"}）在消息里找不到，整段不动`,
    };
  }
  if (found.index <= 0) {
    return { ok: false, reason: "boundary 落在第一条消息之前，没有已封盘的旧段" };
  }
  return {
    ok: true,
    boundaryIndex: found.index,
    marker,
    archivedAbs,
    how: found.how,
  };
}
