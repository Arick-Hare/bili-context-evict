/**
 * 补丁二端到端（验收 7）：真实会话 state + 真实 kernel，
 * boundary 推进后真扔一块 → active=false → 再收集不重复。
 *
 * 只读会话文件；所有改动只发生在内存 state 上，不写回磁盘、不碰运行副本。
 *   <DSH Node24> --import tsx --test verify-evict-p2-e2e.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createCore, deactivateBlock, prune } from "acp-kernel";
import { openEvictDb } from "./src/evict-db.js";
import { collectBlockCandidatesDetailed } from "./src/evict.js";

const SID = "session-4c4a80e3-5bb8-452a-a1b7-429516582fb8";
const FILE = "C:\\Users\\Admin\\.local\\share\\billion-context\\sessions\\anthropic\\api.deepseek.com_fe11eacfaff277d45d50d766.json";

test("验收 7：真扔一块 → blocksCreated>0、active=false、视图变小、再收集不重复", () => {
  const j = JSON.parse(readFileSync(FILE, "utf8").replace(/^\uFEFF/, ""));
  const state = j.payload.state;
  const db = openEvictDb();
  assert.equal(db.available, true);
  const boundarySeq = db.maxSeq(SID)!;
  const ctx = {
    spans: db.blockSpans(SID),
    messageSeqByRef: db.messageSeqByRef(SID),
    refForSeq: (seq: number) => {
      const n = db.refNumForSeq(SID, seq);
      return n === null ? null : `m${n}`;
    },
    seqRefCheck: "strict" as const,
    log: () => {},
  };
  const first = collectBlockCandidatesDetailed(state, boundarySeq, new Set(), 200, ctx);
  assert.ok(first.units.length > 0, "推进 boundary 后应有候选");

  // 全量原文视图：applyCompression 需要 range 边界在 messages 里可见。
  const byRaw = state.messageRefs?.byRaw ?? {};
  const messages = Object.keys(byRaw).map((id) => ({ id, role: "user", contentType: "text", text: "x" }));
  const cfg = {
    ...(j.payload?.metadata?.effectiveConfig ?? {}),
    preserveRecentMessages: 0,
    compress: { ...(j.payload?.metadata?.effectiveConfig?.compress ?? {}), minCompressRange: 0, minSummaryLength: 50, maxSummaryLength: 20000 },
  };
  const core = createCore();
  const unit = first.units[0]!;
  const base = `[evicted: 块 ${unit.blockId} · 折叠于 12:00 · 原文 ${unit.effectiveMessageIds.length} 条 · 已归档，摘要整体丢弃，仅留此标记供回溯]`;
  const marker = base.length >= 50 ? base : base + " · " + "归档".repeat(20);
  const trial = deactivateBlock(state, [unit.blockId]);
  const res = core.applyCompression({
    ranges: [{ startRef: unit.startRef, endRef: unit.endRef, summary: marker }],
    messages,
    state: trial,
    config: cfg,
    protectedMessageIds: new Set<string>(),
  });
  assert.equal(res.result.blocksCreated, 1, `应能真造出 evicted 标记块，错误=${(res.result.errors ?? []).join("|").slice(0, 200)}`);
  assert.equal(res.state.blocks.find((b) => b.blockId === unit.blockId)?.active, false, "旧块应 inactive");

  const before = prune(messages, state, { injectSummaries: true });
  const after = prune(messages, res.state, { injectSummaries: true });
  const chars = (ms: unknown[]) => ms.reduce((n, m) => n + (((m as { text?: string }).text ?? "").length), 0);
  assert.ok(chars(after) < chars(before), `视图应变小：${chars(before)} → ${chars(after)}`);
  assert.ok(JSON.stringify(after).includes(marker), "视图里应出现 evicted 标记");

  // 幂等：state 换过后（新块的 span 用同一份 DB row 反查，且旧块 inactive）
  const second = collectBlockCandidatesDetailed(res.state, boundarySeq, new Set(), 200, ctx);
  assert.equal(
    second.units.some((u) => u.blockId === unit.blockId), false,
    "扔过的块不能再进候选",
  );
  console.log(`  → 扔 ${unit.blockId}，视图 ${chars(before)} → ${chars(after)} 字符；再收集含该块=${second.units.some((u) => u.blockId === unit.blockId)}`);
});
