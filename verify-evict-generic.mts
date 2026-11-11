/**
 * 通用化 / 开源准入验收套件。
 *
 * 目标：证明这个插件在「没有任何外部记忆系统」的前提下也能安全使用，
 * 并且每次改动都不会破坏 sleep.json 闸门的 fail-closed 语义。
 *
 *   node --import tsx --test verify-evict-generic.mts
 *
 * 全部用临时目录（XDG_CONFIG_HOME / DSH_HOME / BILI_EVICT_ROOT 隔离），
 * 不碰真实配置。标 [ROADMAP] 的用例是后续迭代方向，当前以 todo 跳过；
 * 开源准入条件 = 非 roadmap 全通过 + roadmap 逐条实现并转通过。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── 环境隔离：必须在任何被测模块被求值前固定 ──────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), "bili-evict-generic-"));
const CFG = path.join(TMP, "cfg");
const HOME = path.join(TMP, "home");
const DATA = path.join(TMP, "data");
const STATE = path.join(TMP, "state");
const ARCHIVE_ROOT = path.join(TMP, "archive-root");
for (const d of [CFG, HOME, DATA, STATE, ARCHIVE_ROOT]) mkdirSync(d, { recursive: true });
process.env.XDG_CONFIG_HOME = CFG;
process.env.XDG_DATA_HOME = DATA;
process.env.XDG_STATE_HOME = STATE;
process.env.DSH_HOME = HOME;
process.env.BILI_EVICT_ROOT = "";

import {
  archiveRootDir,
  checkSleepGate,
  resolveBoundarySeq,
  sleepMarkerPath,
  sleepFilePath,
  atomicWriteJson,
  verifyArchive,
  type SleepGateOpts,
  type SleepMarker,
} from "./src/sleep.js";
import { evictRoot, configDir, stateDir } from "./src/paths.js";
import {
  DEFAULT_EVICT_CONFIG,
  parseEvictSettings,
  resolveEvictConfig,
  sessionSelected,
} from "./src/evict.js";
import type { EvictDbView } from "./src/evict-db.js";
import type { CompressionState, CoreMessage } from "acp-kernel";

const SID = "session-A";
const SID_B = "session-B";
const ARCHIVED = "2026-11-10.md";

// 归档文件：必须存在、是普通文件、非空。
writeFileSync(path.join(ARCHIVE_ROOT, ARCHIVED), "# 归档\n边界之前的原文已留底\n", "utf8");
writeFileSync(path.join(ARCHIVE_ROOT, "empty.md"), "", "utf8");
mkdirSync(path.join(ARCHIVE_ROOT, "adir"), { recursive: true });
writeFileSync(path.join(ARCHIVE_ROOT, "legacy.md"), "legacy prefix\n", "utf8");
writeFileSync(path.join(TMP, "outside.md"), "越界文件\n", "utf8");

const emptyState = { blocks: [], messageRefs: { byRaw: {} } } as unknown as CompressionState;
const msg = (id: string): CoreMessage => ({ id, role: "user", contentType: "text", text: "" } as CoreMessage);

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

function writeMarker(sid: string, marker: SleepMarker): void {
  atomicWriteJson(sleepMarkerPath(sid), { archived: ARCHIVED, ...marker });
}

function gate(sid: string, db: EvictDbView, opts: Partial<SleepGateOpts> = {}) {
  return checkSleepGate([msg("h1")], emptyState, {
    sessionId: sid,
    archiveRoot: ARCHIVE_ROOT,
    db,
    ...opts,
  });
}

process.on("exit", () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响验收结论 */ }
});

// ═══════════════════════════════════════════════════════════════════════
// A. 路径通用化：不依赖任何宿主私有目录
// ═══════════════════════════════════════════════════════════════════════

test("A1 evictRoot 落在 XDG 配置目录下，不含 .dsh", () => {
  const root = evictRoot();
  assert.equal(path.dirname(root), configDir());
  assert.ok(root.startsWith(CFG), `实际 ${root}`);
  assert.ok(!root.includes(".dsh"), "不得依赖宿主私有目录");
});

test("A2 BILI_EVICT_ROOT 可整体搬家", () => {
  const moved = path.join(TMP, "custom-root");
  process.env.BILI_EVICT_ROOT = moved;
  try {
    assert.equal(evictRoot(), moved);
  } finally {
    process.env.BILI_EVICT_ROOT = "";
  }
});

test("A3 sleep.json 每会话一份，路径即身份", () => {
  const a = sleepMarkerPath(SID);
  const b = sleepMarkerPath(SID_B);
  assert.notEqual(a, b);
  assert.equal(path.basename(a), "sleep.json");
  assert.equal(path.basename(path.dirname(a)), SID);
  assert.ok(a.startsWith(evictRoot()));
});

test("A4 archiveRootDir 默认是 evictRoot/archive，不读私有 stt", () => {
  const root = archiveRootDir();
  assert.equal(root, path.join(evictRoot(), "archive"));
  assert.ok(!root.includes(".dsh"), `实际 ${root}`);
});

test("A5 显式 archiveRoot 覆盖生效", () => {
  assert.equal(archiveRootDir(ARCHIVE_ROOT), path.resolve(ARCHIVE_ROOT));
});

test("A6 全局 sleep.json 只是迁移入口，与 per-session 不同", () => {
  assert.equal(path.basename(sleepFilePath()), "sleep.json");
  assert.notEqual(sleepFilePath(), sleepMarkerPath(SID));
});

test("A7 stateDir / configDir 走标准 XDG", () => {
  assert.ok(stateDir().startsWith(TMP));
  assert.ok(configDir().startsWith(CFG));
});

// ═══════════════════════════════════════════════════════════════════════
// B. 归档校验（archived 是第一道保险）
// ═══════════════════════════════════════════════════════════════════════

test("B1 正常归档文件 → 通过", () => {
  assert.ok(verifyArchive(ARCHIVE_ROOT, ARCHIVED));
});

test("B2 空文件 → 拒绝", () => {
  assert.equal(verifyArchive(ARCHIVE_ROOT, "empty.md"), null);
});

test("B3 目录 → 拒绝", () => {
  assert.equal(verifyArchive(ARCHIVE_ROOT, "adir"), null);
});

test("B4 ../ 越界 → 拒绝", () => {
  assert.equal(verifyArchive(ARCHIVE_ROOT, "../outside.md"), null);
});

test("B5 绝对路径 → 拒绝", () => {
  assert.equal(verifyArchive(ARCHIVE_ROOT, path.join(TMP, "outside.md")), null);
});

test("B6 不存在 / 空字符串 / undefined → 拒绝", () => {
  assert.equal(verifyArchive(ARCHIVE_ROOT, "nope.md"), null);
  assert.equal(verifyArchive(ARCHIVE_ROOT, ""), null);
  assert.equal(verifyArchive(ARCHIVE_ROOT), null);
});

test("B7 旧 marker 的 archive/ 与 stt/ 前缀仍兼容", () => {
  assert.ok(verifyArchive(ARCHIVE_ROOT, `archive/${ARCHIVED}`));
  assert.ok(verifyArchive(ARCHIVE_ROOT, `stt/${ARCHIVED}`));
  assert.ok(verifyArchive(ARCHIVE_ROOT, "./legacy.md"));
});

// ═══════════════════════════════════════════════════════════════════════
// C. sleep.json 契约：全部 fail-closed
// ═══════════════════════════════════════════════════════════════════════

test("C1 最小 marker（boundarySeq + archived）→ 开闸门", () => {
  writeMarker(SID, { boundarySeq: 19900 });
  const r = gate(SID, stubDb());
  assert.equal(r.ok, true, `应开，实际关：${r.reason}`);
  assert.equal(r.how, "seq");
  assert.equal(r.boundarySeq, 19900);
  assert.ok(r.archivedAbs && statSync(r.archivedAbs).size > 0);
});

test("C2 该会话没有 sleep.json → 关（no-session-marker）", () => {
  rmSync(sleepMarkerPath("session-none"), { force: true });
  const r = gate("session-none", stubDb());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no-session-marker/);
});

test("C3 没有 sessionId → 关", () => {
  const r = checkSleepGate([msg("h1")], emptyState, {
    archiveRoot: ARCHIVE_ROOT,
    db: stubDb(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no-session-marker/);
});

test("C4 缺 archived → 关", () => {
  atomicWriteJson(sleepMarkerPath(SID), { boundarySeq: 19900 });
  const r = gate(SID, stubDb());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /archived/);
});

test("C5 archived 指向空文件 → 关", () => {
  atomicWriteJson(sleepMarkerPath(SID), { boundarySeq: 19900, archived: "empty.md" });
  assert.equal(gate(SID, stubDb()).ok, false);
});

test("C6 archived 越界 → 关", () => {
  atomicWriteJson(sleepMarkerPath(SID), { boundarySeq: 19900, archived: "../outside.md" });
  assert.equal(gate(SID, stubDb()).ok, false);
});

test("C7 只有 tail → 关（tail 不能当封盘线）", () => {
  atomicWriteJson(sleepMarkerPath(SID), { tail: "那就先这样，晚安", archived: ARCHIVED });
  const r = gate(SID, stubDb());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boundarySeq/);
});

test("C8 boundary 不是 mNNNNN → 关", () => {
  atomicWriteJson(sleepMarkerPath(SID), { boundary: "random-id", archived: ARCHIVED });
  assert.equal(gate(SID, stubDb()).ok, false);
});

test("C9 boundarySeq > 该会话 max(seq) → 关（会话隔离核心）", () => {
  writeMarker(SID, { boundarySeq: 20000 });
  const r = gate(SID, stubDb({}, { [SID]: 19991 }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boundary-beyond-session/);
  assert.match(r.reason ?? "", /20000/);
  assert.match(r.reason ?? "", /19991/);
});

test("C10 boundary 的 mNNNNN 查库换 seq → 开", () => {
  writeMarker(SID, { boundary: "m12113" });
  const r = gate(SID, stubDb({ "12113": 13822 }));
  assert.equal(r.ok, true, `应开：${r.reason}`);
  assert.equal(r.boundarySeq, 13822);
  assert.equal(r.how, "ref");
});

test("C11 mNNNNN 查不到 / DB 不可用 / 缺 sessionId → 都关", () => {
  writeMarker(SID, { boundary: "m99999" });
  assert.equal(gate(SID, stubDb()).ok, false);

  const noDb = checkSleepGate([msg("h1")], emptyState, {
    sessionId: SID,
    archiveRoot: ARCHIVE_ROOT,
  });
  assert.equal(noDb.ok, false);

  const pure = resolveBoundarySeq({ boundary: "m12113" }, { db: stubDb({ "12113": 1 }) });
  assert.equal(pure.ok, false, "缺 sessionId 时 ref 不得换 seq");
});

test("C12 有全局 sleep.json、无 per-session → 不回落", () => {
  const global = sleepFilePath();
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(global, JSON.stringify({ sessionId: SID, boundarySeq: 19900, archived: ARCHIVED }), "utf8");
  rmSync(sleepMarkerPath("session-fresh"), { force: true });
  const r = gate("session-fresh", stubDb());
  assert.equal(r.ok, false, "全局文件绝不能被当成当前会话的封盘线");
  assert.match(r.reason ?? "", /no-session-marker/);
  rmSync(global, { force: true });
});

test("C13 两个会话互不影响", () => {
  writeMarker("A", { boundarySeq: 19900 });
  writeMarker("B", { boundarySeq: 20000 });
  const db = stubDb({}, { A: 19991, B: 3740 });
  assert.equal(gate("A", db).ok, true);
  const gB = gate("B", db);
  assert.equal(gB.ok, false);
  assert.match(gB.reason ?? "", /boundary-beyond-session/);
  const gC = gate("C", db);
  assert.equal(gC.ok, false);
  assert.match(gC.reason ?? "", /no-session-marker/);
});

test("C14 boundaryFromSleep=false：按水位开，缺 DB 时仍关", () => {
  const r = gate(SID, stubDb({}, { [SID]: 19991 }), { boundaryFromSleep: false });
  assert.equal(r.ok, true);
  assert.equal(r.how, "waterline");
  assert.equal(r.boundarySeq, 19991);
  const noDb = checkSleepGate([msg("h1")], emptyState, {
    sessionId: SID,
    archiveRoot: ARCHIVE_ROOT,
    boundaryFromSleep: false,
  });
  assert.equal(noDb.ok, false);
});

test("C15 resolveBoundarySeq 纯函数：越界判定不依赖文件", () => {
  const r = resolveBoundarySeq(
    { boundarySeq: 20000 },
    { sessionId: SID, db: stubDb({}, { [SID]: 19991 }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boundary-beyond-session/);
});

// ═══════════════════════════════════════════════════════════════════════
// D. 配置通用性：零私有假设
// ═══════════════════════════════════════════════════════════════════════

test("D1 默认配置不启用、不带任何记忆工具名", () => {
  assert.equal(DEFAULT_EVICT_CONFIG.enabled, false);
  assert.deepEqual(DEFAULT_EVICT_CONFIG.writeTools, []);
  assert.equal(DEFAULT_EVICT_CONFIG.persistCheck, "off");
});

test("D2 resolveEvictConfig({}) 序列化后不含私有目录 / 私有工具名", () => {
  const s = JSON.stringify(resolveEvictConfig({}));
  for (const bad of ["soul-md", "heart_note", "soul_update", ".dsh", "handoff", "profiles/desktop"]) {
    assert.ok(!s.includes(bad), `默认配置不应含 ${bad}`);
  }
});

test("D3 环境变量可覆盖水位 / dryRun / 归档根", () => {
  const c = resolveEvictConfig({}, {
    EVICT_ENABLED: "1",
    EVICT_BUDGET: "0.42",
    EVICT_TARGET: "0.2",
    EVICT_DRY_RUN: "1",
    EVICT_ARCHIVE_ROOT: ARCHIVE_ROOT,
  });
  assert.equal(c.enabled, true);
  assert.equal(c.budget, 0.42);
  assert.equal(c.target, 0.2);
  assert.equal(c.dryRun, true);
  assert.equal(c.archiveRoot, ARCHIVE_ROOT);
});

test("D4 接入方可注入自己的写盘工具名（通用注入点）", () => {
  const c = resolveEvictConfig({}, { EVICT_WRITE_TOOLS: "my_store,my_index" });
  assert.deepEqual(c.writeTools, ["my_store", "my_index"]);
  const fromFile = resolveEvictConfig({ writeTools: ["append_memory"] });
  assert.deepEqual(fromFile.writeTools, ["append_memory"]);
});

test("D5 archiveRoot 走文件配置；旧 sttRoot 仍兼容", () => {
  assert.equal(parseEvictSettings({ archiveRoot: ARCHIVE_ROOT })?.archiveRoot, ARCHIVE_ROOT);
  assert.equal(resolveEvictConfig({ sttRoot: ARCHIVE_ROOT }).sttRoot, ARCHIVE_ROOT);
  assert.equal(resolveEvictConfig({ archiveRoot: ARCHIVE_ROOT }).archiveRoot, ARCHIVE_ROOT);
});

test("D6 会话白名单语义", () => {
  assert.equal(sessionSelected(SID, undefined), false, "空白名单 = 一个都不驱逐");
  assert.equal(sessionSelected(SID, [SID]), true);
  assert.equal(sessionSelected(SID, ["*"]), true);
  assert.equal(sessionSelected(SID, [SID_B]), false);
});

test("D7 非法配置不会把闸门打开", () => {
  assert.equal(parseEvictSettings(null), undefined);
  assert.equal(parseEvictSettings([]), undefined);
  assert.equal(parseEvictSettings({ enabled: "yes" })?.enabled, undefined);
  assert.equal(resolveEvictConfig({ persistCheck: "garbage" }).persistCheck, "off");
});

// ═══════════════════════════════════════════════════════════════════════
// E. 能力边界 / 数据留存 / 声明
// ═══════════════════════════════════════════════════════════════════════

const SRC = path.join(process.cwd(), "src");
const ROOT = process.cwd();
const readSrc = (p: string) => readFileSync(path.join(SRC, p), "utf8");
const readRoot = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

test("E1 index.db 只读打开，不写账本", () => {
  const s = readSrc("evict-db.ts");
  assert.match(s, /query_only/i, "必须以只读方式打开 index.db");
  assert.ok(!/\b(DELETE|UPDATE|INSERT)\b/i.test(s), "驱逐路径不得改写会话账本");
});

test("E2 完整原文有导出通道（不是真的失忆）", () => {
  assert.match(readSrc("export.ts"), /Original messages/);
  assert.match(readSrc("storage/schema.ts"), /content_hash/);
});

test("E3 EVICT.md 明确声明能力边界与假性失忆风险", () => {
  const doc = readRoot("EVICT.md");
  assert.match(doc, /假性/);
  assert.match(doc, /不会真的失忆/);
  assert.match(doc, /摘要压缩/);
  assert.match(doc, /工具结果裁剪/);
  assert.match(doc, /块级驱逐/);
  assert.match(doc, /不提供记忆系统/);
  assert.match(doc, /sleep\.json/);
  assert.match(doc, /index\.db/);
});

test("E4 运行时日志带一次性风险提示", () => {
  assert.match(readSrc("evict.ts"), /amnesiaNoticeShown/);
  assert.match(readSrc("evict.ts"), /假性失忆/);
});

test("E5 默认不依赖私有记忆布局", () => {
  const s = readSrc("evict.ts") + readSrc("sleep.ts");
  assert.ok(!s.includes("dsh-soul-md/memory-layout"), "不得内置私有记忆布局");
  assert.ok(!s.includes("memory_append"), "不得预置私有写盘工具名");
});

// ═══════════════════════════════════════════════════════════════════════
// F. 打包与命名隔离
// ═══════════════════════════════════════════════════════════════════════

test("F1 包名 / 版本 / CLI 与官方区分", () => {
  const pkg = JSON.parse(readRoot("package.json"));
  assert.notEqual(pkg.name, "billion-context");
  assert.equal(pkg.name, "bili-context-evict");
  assert.match(pkg.version, /^0\.1\.212-fork\./);
  const bins = Object.keys(pkg.bin);
  assert.ok(!bins.includes("bili"), "不得占用官方 CLI 名");
  assert.ok(!bins.includes("bili-proxy"));
});

test("F2 dsh bundle 指向新包，且 bili-native 只插一次", () => {
  const yml = readRoot("dsh.bundle.patch.yml");
  assert.match(yml, /name: bili-context-evict\b/);
  assert.match(yml, /name: bili-context-evict\/dsh-compaction-gate/);
  assert.equal((yml.match(/id: bili-native/g) ?? []).length, 1);
  assert.equal((yml.match(/id: bili-compaction-gate/g) ?? []).length, 1);
  assert.ok(!yml.includes("name: billion-context\n"));
});

test("F3 package exports 保留 gate 子路径", () => {
  const pkg = JSON.parse(readRoot("package.json"));
  assert.ok(pkg.exports["./dsh-compaction-gate"]);
  assert.ok(pkg.exports["./dsh"]);
});

test("F4 构建产物存在且包含闸门标记", () => {
  const f = path.join(ROOT, "dist", "index.js");
  assert.ok(existsSync(f), "先跑 npm run build");
  const s = readFileSync(f, "utf8");
  for (const k of ["no-session-marker", "boundary-beyond-session", "bili-context-evict"]) {
    assert.ok(s.includes(k), `产物缺少 ${k}`);
  }
  for (const bad of ["memory_append", "heart_note", "soul-md"]) {
    assert.ok(!s.includes(bad), `产物不应再含私有默认值 ${bad}`);
  }
});

test("F5 dist 不入库（避免 GitHub 直装拿到无产物源码）", () => {
  assert.match(readRoot(".gitignore"), /^dist\//m);
});

// ═══════════════════════════════════════════════════════════════════════
// G. [ROADMAP] 后续迭代方向 —— 全部转通过后再开源
// ═══════════════════════════════════════════════════════════════════════

test("G1 [ROADMAP] 可插拔「检索记忆」工具接口：驱逐前回调接入方检索器", { todo: true }, () => {});
test("G2 [ROADMAP] 归档内容覆盖校验：不只验文件存在，要验归档确实覆盖边界前消息", { todo: true }, () => {});
test("G3 [ROADMAP] 无 index.db 时可用的纯文件闸门（不依赖宿主账本）", { todo: true }, () => {});
test("G4 [ROADMAP] 通用宿主挂载抽象：除 prepare-anthropic/openai 之外的 lane 也能接入", { todo: true }, () => {});
test("G5 [ROADMAP] 100% 原文可导出保证：补齐无快照且未入块 v2 会话的导出路径", { todo: true }, () => {});
test("G6 [ROADMAP] 真实 e2e：起一轮 proxy 请求，断言驱逐前后 messages/state 与磁盘数据一致", { todo: true }, () => {});
test("G7 [ROADMAP] GitHub 直装可用：dist 入库或 release tgz + 安装后自检", { todo: true }, () => {});
test("G8 [ROADMAP] 跨会话召回与冲突检测：同一原文被多会话引用时的处置", { todo: true }, () => {});
test("G9 [ROADMAP] 假性失忆缓解：可选「按需恢复」通道，把归档片段重新注入上下文", { todo: true }, () => {});
test("G10 [ROADMAP] 完整配置 schema 与 config-reference 登记（当前 evict 段无 schema）", { todo: true }, () => {});
test("G11 [ROADMAP] 重写快照型验收：verify-evict-db / p2-e2e 改为自造 fixture，去掉本机绝对路径与写死 seq", { todo: true }, () => {});
