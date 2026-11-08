/**
 * 会话隔离方案单测（验收 1/2/3/4/6）。
 * 用 XDG_CONFIG_HOME / DSH_HOME 指向临时目录做隔离，不碰真实配置。
 *
 *   $env:XDG_CONFIG_HOME=<tmp>\cfg; $env:DSH_HOME=<tmp>\home
 *   <DSH Node24> --import tsx --test verify-sleep-seq.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  resolveBoundarySeq,
  checkSleepGate,
  sleepMarkerPath,
  ensureSleepMigration,
  sleepFilePath,
  atomicWriteJson,
  type SleepMarker,
} from "./src/sleep.js";
import type { EvictDbView } from "./src/evict-db.js";
import type { CompressionState, CoreMessage } from "acp-kernel";

const STT = path.join(process.env.XDG_CONFIG_HOME!, "stt-root");
const ARCHIVED = "archive.md";
// verifyArchive 要求 archived 指向存在且非空的归档文件。
mkdirSync(STT, { recursive: true });
writeFileSync(path.join(STT, ARCHIVED), "# 归档\n某内容\n", "utf8");

const SID = "session-A";
const SID_B = "session-B";

function stubDb(map: Record<string, number> = {}, max: Record<string, number> = {}): EvictDbView {
  return {
    available: true,
    boundarySeqForRef: (_sid, refNum) => map[String(refNum)] ?? null,
    messageSeqByRef: () => null,
    refNumForSeq: () => null,
    boundaryMsgIdForSeq: () => null,
    blockSpans: () => null,
    maxSeq: (sid) => (max[sid] !== undefined ? max[sid]! : null),
    minimalView: () => null,
    close: () => {},
  };
}

const emptyState = { blocks: [], messageRefs: { byRaw: {} } } as unknown as CompressionState;
const msg = (id: string): CoreMessage => ({ id, role: "user", contentType: "text", text: "" } as CoreMessage);

function writeMarker(sid: string, marker: SleepMarker) {
  atomicWriteJson(sleepMarkerPath(sid), { archived: ARCHIVED, ...marker });
}

function gate(sid: string, db: EvictDbView, opts: Record<string, unknown> = {}) {
  return checkSleepGate([msg("h1")], emptyState, { sessionId: sid, sttRoot: STT, db, ...opts });
}

test("验收 1：该会话 marker 有 boundarySeq → 闸门开（how=seq）", () => {
  writeMarker(SID, { boundarySeq: 19900 });
  const r = gate(SID, stubDb());
  assert.equal(r.ok, true, `应为开，实际关：${r.reason}`);
  assert.equal(r.how, "seq");
  assert.equal(r.boundarySeq, 19900);
});

test("验收 1b：boundary 的 mNNNNN 查库换 seq → 闸门开", () => {
  writeMarker(SID, { boundary: "m12113" });
  const r = gate(SID, stubDb({ "12113": 13822 }));
  assert.equal(r.ok, true);
  assert.equal(r.boundarySeq, 13822);
  assert.equal(r.how, "ref");
});

test("验收 2：boundarySeq > 该会话 max(seq) → 关闸门（boundary-beyond-session）", () => {
  writeMarker(SID, { boundarySeq: 20000 });
  const r = gate(SID, stubDb({}, { [SID]: 19991 }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boundary-beyond-session/);
  assert.match(r.reason ?? "", /20000/);
  assert.match(r.reason ?? "", /19991/);
});

test("验收 3：没有该会话的 marker → 关闸门（no-session-marker），不回落全局", () => {
  // 先造一个「看起来可用」的全局文件：若实现回落到全局，这里就会被放行。
  const global = sleepFilePath();
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(global, JSON.stringify({ sessionId: SID, boundarySeq: 19900, archived: ARCHIVED }), "utf8");
  // 但该会话目录没有 marker。
  rmSync(sleepMarkerPath(SID), { force: true });
  const r = gate(SID, stubDb());
  assert.equal(r.ok, false, "有全局文件也不该放行");
  assert.match(r.reason ?? "", /no-session-marker/);
});

test("验收 4：两个会话互不影响", () => {
  writeMarker("A", { boundarySeq: 19900 });
  writeMarker("B", { boundarySeq: 20000 });
  const db = stubDb({}, { A: 19991, B: 3740 });
  const gA = gate("A", db);
  const gB = gate("B", db);
  const gC = gate("C", db);
  assert.equal(gA.ok, true, "A 应开");
  assert.equal(gB.ok, false, "B 应关（boundary-beyond-session）");
  assert.match(gB.reason ?? "", /boundary-beyond-session/);
  assert.equal(gC.ok, false, "C 应关（no-session-marker）");
  assert.match(gC.reason ?? "", /no-session-marker/);
});

test("resolveBoundarySeq 纯函数：boundary-beyond-session 不依赖文件", () => {
  const r = resolveBoundarySeq({ boundarySeq: 20000 }, { sessionId: SID, db: stubDb({}, { [SID]: 19991 }) });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boundary-beyond-session/);
});

test("验收 6：迁移 — 全局 sleep.json 复制到旧会话目录，原文件改名不删", () => {
  const global = sleepFilePath(); // 默认 <DSH_HOME>/.dsh/heart/sleep.json
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(global, JSON.stringify({ sessionId: SID, boundarySeq: 19900, archived: ARCHIVED }), "utf8");
  ensureSleepMigration({ sleepFile: undefined }, () => {});
  const moved = sleepMarkerPath(SID);
  assert.ok(existsSync(moved), "应存在 per-session marker");
  const content = JSON.parse(readFileSync(moved, "utf8"));
  assert.equal(content.sessionId, SID);
  assert.equal(content.boundarySeq, 19900);
  const renamed = readdirSync(path.dirname(global)).find((f) => f.startsWith("sleep.json.migrated-"));
  assert.ok(renamed, "原文件应被改名为 .migrated-<日期>");
  assert.ok(existsSync(path.join(path.dirname(global), renamed!)));
});

test("2.6 水位触发（boundaryFromSleep=false）与 per-session 无关，仍按 maxSeq", () => {
  const r = gate(SID, stubDb({}, { [SID]: 19991 }), { boundaryFromSleep: false });
  assert.equal(r.ok, true);
  assert.equal(r.how, "waterline");
  assert.equal(r.boundarySeq, 19991);
});
