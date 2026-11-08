/**
 * 补丁二单测：闸门 seq 化（文档第三节验收 1/2/3）+ sessionId 身份校验。
 * 纯逻辑，不碰真实 sleep.json / DB；DB 用 stub 注入。
 *
 *   <DSH Node24> --import tsx --test verify-sleep-seq.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBoundarySeq,
  boundaryRefNum,
  resolveBoundaryIndexBySeq,
  checkSleepGate,
  type SleepMarker,
} from "./src/sleep.js";
import type { EvictDbView } from "./src/evict-db.js";
import type { CompressionState, CoreMessage } from "acp-kernel";

const SID = "session-A";

function stubDb(map: Record<string, number> = {}): EvictDbView {
  return {
    available: true,
    boundarySeqForRef: (_sid, refNum) => map[String(refNum)] ?? null,
    boundaryMsgIdForSeq: () => null,
    blockSpans: () => null,
    messageSeqByRef: () => null,
    maxSeq: () => 19991,
    refNumForSeq: () => null,
    minimalView: () => null,
    close: () => {},
  };
}

const emptyState = { blocks: [], messageRefs: { byRaw: {} } } as unknown as CompressionState;
const msg = (id: string, ledgerSeq?: number): CoreMessage =>
  ({ id, role: "user", contentType: "text", text: "", ledgerSeq } as CoreMessage);

test("验收 1：boundarySeq 命中 → 闸门解析开（seq 优先）", () => {
  const marker: SleepMarker = { sessionId: SID, boundary: "m12113", boundarySeq: 19900 };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: stubDb() });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 19900);
  assert.equal(r.how, "seq");
});

test("验收 2：只有 boundary(mNNN)，DB 查得到 → 闸门开", () => {
  const marker: SleepMarker = { sessionId: SID, boundary: "m12113" };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: stubDb({ "12113": 13822 }) });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 13822);
  assert.equal(r.how, "ref");
});

test("验收 3a：DB 查不到 → 闸门关，reason 指到具体缺哪一步", () => {
  const marker: SleepMarker = { sessionId: SID, boundary: "m12113" };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: stubDb({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /查不到 seq/);
});

test("验收 3b：两条都没有 → 闸门关，reason 分级", () => {
  const marker: SleepMarker = { sessionId: SID, tail: "嗯嗯别忘了" };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: stubDb() });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /(无|缺) boundarySeq/);
});

test("验收 3c：DB 不可用 → 闸门关，reason 写明", () => {
  const marker: SleepMarker = { sessionId: SID, boundary: "m12113" };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: { ...stubDb(), available: false } });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /只读视图不可用/);
});

test("2.5 补充：sessionId 属于另一会话 → 闸门关，不做任何猜测", () => {
  const marker: SleepMarker = { sessionId: "session-B", boundarySeq: 19900 };
  const r = resolveBoundarySeq(marker, { sessionId: SID, db: stubDb() });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /属于另一个会话/);
});

test("2.5 补充：老文件缺 sessionId，唯一会话 → 放行 + 迁移警告", () => {
  const marker: SleepMarker = { boundarySeq: 19900 };
  const r = resolveBoundarySeq(marker, { sessionId: SID, evictingSessionCount: 1, db: stubDb() });
  assert.equal(r.ok, true);
  assert.match(r.migrationWarning ?? "", /缺 sessionId/);
});

test("2.5 补充：老文件缺 sessionId，多会话 → 闸门关", () => {
  const marker: SleepMarker = { boundarySeq: 19900 };
  const r = resolveBoundarySeq(marker, { sessionId: SID, evictingSessionCount: 2, db: stubDb() });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /无法判定边界归属/);
});

test("2.5 补充：老文件缺 sessionId，且 tail 兜底也不给 seq → 闸门关", () => {
  const marker: SleepMarker = { boundary: "h_abc", tail: "一句话" };
  const r = resolveBoundarySeq(marker, { sessionId: SID, evictingSessionCount: 1, db: stubDb() });
  assert.equal(r.ok, false);
});

test("boundaryRefNum：只认 mNNNNN", () => {
  assert.equal(boundaryRefNum("m12113"), 12113);
  assert.equal(boundaryRefNum("m00001"), 1);
  assert.equal(boundaryRefNum("b545"), null);
  assert.equal(boundaryRefNum("h_abc"), null);
  assert.equal(boundaryRefNum("BLOCKED"), null);
});

test("2.2：boundaryIndex 从 seq 定位（ledgerSeq 命中），不用数组下标持久化", () => {
  const msgs = [msg("h_1", 100), msg("h_2", 200), msg("h_3", 300)];
  const r = resolveBoundaryIndexBySeq(msgs, emptyState, { boundarySeq: 200 }, 200);
  assert.equal(r?.index, 1);
  assert.equal(r?.how, "seq");
});

test("2.2：消息无 ledgerSeq 时按 DB 的 msg_id 定位", () => {
  const db = { ...stubDb(), boundaryMsgIdForSeq: () => "h_2" };
  const msgs = [msg("h_1"), msg("h_2"), msg("h_3")];
  const r = resolveBoundaryIndexBySeq(msgs, emptyState, {}, 200, db, SID);
  assert.equal(r?.index, 1);
});

test("4.3：boundaryFromSleep=false → 忽略 sleep.json，按水位触发", () => {
  // 不写任何 sleep.json：用 opts 直接验，DB stub 给 maxSeq。
  const r = checkSleepGate([msg("h_1")], emptyState, {
    sessionId: SID,
    db: stubDb(),
    boundaryFromSleep: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.boundarySeq, 19991);
  assert.equal(r.how, "waterline");
  assert.equal(r.fromWaterline, true);
});

test("4.3：boundaryFromSleep=false 但 DB 不可用 → 闸门关（不猜）", () => {
  const r = checkSleepGate([msg("h_1")], emptyState, {
    sessionId: SID,
    db: { ...stubDb(), available: false },
    boundaryFromSleep: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /无法按水位取封盘线/);
});
