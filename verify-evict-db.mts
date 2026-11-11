/**
 * 补丁二集成自检：真实 index.db（只读）上的 boundarySeq 查库、块 seq、
 * seq→ref 反查，以及「boundary 推进到当前封盘点时块候选 > 0」。
 *
 * ⚠ 这是**本机快照验收**：断言写死了某一时刻的 seq / 块编号，会话继续跑
 * 之后就会失效。开源仓库默认跳过；只有显式提供匹配快照时才运行：
 *
 *   BILI_EVICT_RUN_SNAPSHOT_TESTS=1 \
 *   BILI_EVICT_FIXTURE_FILE=<会话 json 路径> \
 *   BILI_EVICT_FIXTURE_SID=<会话 id> \
 *     <DSH Node24> --import tsx --test verify-evict-db.mts
 *
 * 只读：全程 query_only=ON，不写 DB、不改 sleep.json、不碰运行副本。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { openEvictDb } from "./src/evict-db.js";
import { collectBlockCandidatesDetailed } from "./src/evict.js";

// 会话 id 不再写死本机值：由调用方显式注入，缺一个都不跑。
const SID = process.env.BILI_EVICT_FIXTURE_SID ?? "";
const SESSION_FILE = process.env.BILI_EVICT_FIXTURE_FILE ?? "";
const SKIP = process.env.BILI_EVICT_RUN_SNAPSHOT_TESTS !== "1" || !SESSION_FILE || !existsSync(SESSION_FILE) || !SID
  ? "本机快照验收：需 BILI_EVICT_RUN_SNAPSHOT_TESTS=1 + BILI_EVICT_FIXTURE_FILE + BILI_EVICT_FIXTURE_SID"
  : false;

test("真实 index.db：boundary m12113 按会话查库得 seq 13822（不串会话）", { skip: SKIP }, () => {
  const db = openEvictDb();
  assert.equal(db.available, true, "只读 DB 视图应可用");
  // 不带 session_id 的全表查会串到另一会话的 14543；这里必须只认本会话。
  assert.equal(db.boundarySeqForRef(SID, 12113), 13822);
});

test("真实 index.db：active 块有 start_seq/end_seq，且 boundary 过期时 0 块可扔", { skip: SKIP }, () => {
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

test("真实 index.db：boundary 推进到当前 max(seq) → 块候选 > 0（补丁二的目标）", { skip: SKIP }, () => {
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

test("真实 index.db：seq→ref 反查可用（给存量无 ref 的块造 range）", { skip: SKIP }, () => {
  const db = openEvictDb();
  const spans = db.blockSpans(SID)!;
  const b576 = spans.get("b576");
  assert.ok(b576, "应能读到 b576");
  assert.equal(b576!.startRefNum, null, "b576 存量行确实没写 ref");
  // 2.4 附录：seq 17059 → m15066（ref_num 15066）
  const n = db.refNumForSeq(SID, b576!.startSeq!);
  assert.ok(n !== null && n > 0, `seq ${b576!.startSeq} 应能反查到 ref_num，实际 ${n}`);
});
