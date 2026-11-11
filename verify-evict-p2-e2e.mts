/**
 * 补丁二端到端（验收 7，补丁四重写）：真实会话 state + 真实 kernel，
 * boundary 推进后直接把一块的 summary 换成 evicted 标记 → 保持 active →
 * prune 视图变小 → 再收集不重复。
 *
 * ⚠ 这是**本机快照验收**：依赖某一时刻的真实会话 state 与 index.db，
 * 会话继续跑之后断言就会失效。开源仓库默认跳过；显式提供匹配快照才运行：
 *
 *   BILI_EVICT_RUN_SNAPSHOT_TESTS=1 \
 *   BILI_EVICT_FIXTURE_FILE=<会话 json 路径> \
 *   BILI_EVICT_FIXTURE_SID=<会话 id> \
 *     <DSH Node24> --import tsx --test verify-evict-p2-e2e.mts
 *
 * 只读会话文件；所有改动只发生在内存 state 上，不写回磁盘、不碰运行副本。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { prune } from "acp-kernel";
import { openEvictDb } from "./src/evict-db.js";
import { collectBlockCandidatesDetailed, swapBlockSummary } from "./src/evict.js";

// 会话 id 不再写死本机值：由调用方显式注入，缺一个都不跑。
const SID = process.env.BILI_EVICT_FIXTURE_SID ?? "";
const FILE = process.env.BILI_EVICT_FIXTURE_FILE ?? "";
const SKIP = process.env.BILI_EVICT_RUN_SNAPSHOT_TESTS !== "1" || !FILE || !existsSync(FILE) || !SID
  ? "本机快照验收：需 BILI_EVICT_RUN_SNAPSHOT_TESTS=1 + BILI_EVICT_FIXTURE_FILE + BILI_EVICT_FIXTURE_SID"
  : false;

test("验收 7（补丁四）：换 summary → active 仍 true、视图变小、再收集不重复", { skip: SKIP }, () => {
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

  // prune 需要的全量原文视图（换 summary 不再需要 range 边界可见）。
  const byRaw = state.messageRefs?.byRaw ?? {};
  const messages = Object.keys(byRaw).map((id) => ({ id, role: "user", contentType: "text", text: "x" }));
  const unit = first.units[0]!;
  const base = `[evicted: 块 ${unit.blockId} · 折叠于 12:00 · 原文 ${unit.effectiveMessageIds.length} 条 · 已归档，摘要整体丢弃，仅留此标记供回溯]`;
  const marker = base.length >= 50 ? base : base + " · " + "归档".repeat(20);

  // 补丁四：不再 deactivate + applyCompression，直接换已有块的 summary。
  const swap = swapBlockSummary(state, unit.blockId, marker, unit.summaryChars);
  assert.equal(swap.applied, true, "应能直接换掉 summary");
  const changed = swap.state.blocks.find((b) => b.blockId === unit.blockId)!;
  assert.equal(changed.active, true, "块必须保持 active，否则 collectSummaryAnchors 不注入");
  assert.equal(changed.summary, marker);
  assert.equal(changed.topic, "evicted");
  assert.ok(swap.reclaimedChars >= 0);
  assert.ok(Math.ceil(swap.reclaimedChars / 4) >= 0, "reclaimedTokens 不能为负");

  const before = prune(messages, state, { injectSummaries: true });
  const after = prune(messages, swap.state, { injectSummaries: true });
  const chars = (ms: unknown[]) => ms.reduce((n, m) => n + (((m as { text?: string }).text ?? "").length), 0);
  assert.ok(chars(after) < chars(before), `视图应变小：${chars(before)} → ${chars(after)}`);
  assert.ok(JSON.stringify(after).includes(marker), "视图里应出现 evicted 标记");

  // 幂等：换过的块 summary 以 [evicted: 开头，候选收集直接跳过。
  const second = collectBlockCandidatesDetailed(swap.state, boundarySeq, new Set(), 200, ctx);
  assert.equal(
    second.units.some((u) => u.blockId === unit.blockId), false,
    "扔过的块不能再进候选",
  );
  console.log(`  → 扔 ${unit.blockId}，视图 ${chars(before)} → ${chars(after)} 字符；再收集含该块=${second.units.some((u) => u.blockId === unit.blockId)}`);
});
