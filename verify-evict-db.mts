/**
 * 补丁二集成自检：真实 index.db（只读）上的 boundarySeq 查库、块 seq、
 * seq→ref 反查，以及「boundary 推进到当前封盘点时块候选 > 0」。
 *
 * 只读：全程 query_only=ON，不写 DB、不改 sleep.json、不碰运行副本。
 *   <DSH Node24> --import tsx --test verify-evict-db.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { openEvictDb } from "./src/evict-db.js";
import { collectBlockCandidatesDetailed } from "./src/evict.js";

const SID = "session-4c4a80e3-5bb8-452a-a1b7-429516582fb8";
const SESSION_FILE = "C:\\Users\\Admin\\.local\\share\\billion-context\\sessions\\anthropic\\api.deepseek.com_fe11eacfaff277d45d50d766.json";

test("真实 index.db：boundary m12113 按会话查库得 seq 13822（不串会话）", () => {
  const db = openEvictDb();
  assert.equal(db.available, true, "只读 DB 视图应可用");
  // 不带 session_id 的全表查会串到另一会话的 14543；这里必须只认本会话。
  assert.equal(db.boundarySeqForRef(SID, 12113), 13822);
});

test("真实 index.db：active 块有 start_seq/end_seq，且 boundary 过期时 0 块可扔", () => {
  const db = openEvictDb();
  const spans = db.blockSpans(SID);
  assert.ok(spans && spans.size > 0, "应读到块区间");
  const active = [...spans!.values()].filter((s) => s.active);
  assert.ok(active.length >= 20, `active 块应 >=20，实际 ${active.length}`);
  assert.ok(active.every((s) => Number.isInteger(s.startSeq) && Number.isInteger(s.endSeq)), "DB 里每行都有 seq");
  const j = JSON.parse(readFileSync(SESSION_FILE, "utf8").replace(/^\uFEFF/, ""));
  const logs: string[] = [];
  const r = collectBlockCandidatesDetailed(j.payload.state, 13822, new Set(), 200, {
    spans,
    messageSeqByRef: db.messageSeqByRef(SID),
    seqRefCheck: "off",
    log: (m) => logs.push(m),
  });
  assert.equal(r.units.length, 0, "boundary=13822 已过期，所有块都在它之后 → 0 块");
  assert.equal(r.stats.afterBoundary, active.length - r.stats.tooSmall - r.stats.protectedHit - r.stats.alreadyEvicted);
});

test("真实 index.db：boundary 推进到当前 max(seq) → 块候选 > 0（补丁二的目标）", () => {
  const db = openEvictDb();
  const maxSeq = db.maxSeq(SID);
  assert.ok(maxSeq && maxSeq > 13822, `maxSeq 应 > 13822，实际 ${maxSeq}`);
  const j = JSON.parse(readFileSync(SESSION_FILE, "utf8").replace(/^\uFEFF/, ""));
  const logs: string[] = [];
  const r = collectBlockCandidatesDetailed(j.payload.state, maxSeq, new Set(), 200, {
    spans: db.blockSpans(SID),
    messageSeqByRef: db.messageSeqByRef(SID),
    refForSeq: (seq) => {
      const n = db.refNumForSeq(SID, seq);
      return n === null ? null : `m${n}`;
    },
    seqRefCheck: "strict",
    log: (m) => logs.push(m),
  });
  assert.ok(r.units.length > 0, `boundary 推进后应有块进候选，实际 ${r.units.length}；统计 ${JSON.stringify(r.stats)}`);
  assert.ok(r.units.every((u) => u.endSeq < maxSeq!), "全部候选都已封盘");
  assert.ok(r.units.every((u) => u.startRef && u.endRef), "全部候选都有可交给 applyCompression 的 range");
  console.log("  → 候选数:", r.units.length, "统计:", JSON.stringify({ ...r.stats, mismatches: r.stats.mismatches.slice(0, 3) }));
});

test("真实 index.db：seq→ref 反查可用（给存量无 ref 的块造 range）", () => {
  const db = openEvictDb();
  const spans = db.blockSpans(SID)!;
  const b576 = spans.get("b576");
  assert.ok(b576, "应能读到 b576");
  assert.equal(b576!.startRefNum, null, "b576 存量行确实没写 ref");
  // 2.4 附录：seq 17059 → m15066（ref_num 15066）
  const n = db.refNumForSeq(SID, b576!.startSeq!);
  assert.ok(n !== null && n > 0, `seq ${b576!.startSeq} 应能反查到 ref_num，实际 ${n}`);
});
