/**
 * 「正文污染事故」处方 ①（出站视图净化）+ ②（源头短周期检测）验收。
 *
 *   <Node24> --import tsx --test verify-text-sanitize.mts
 *
 * 分四组：
 *   A 净化规则        B 短周期检测 / runaway-guard
 *   C core / wire 集成  D 真实会话库的术前术后对照（库不存在则 skip）
 *
 * 关键不变量：净化只改 OUTBOUND 视图，不改存盘、不改 content_hash、不改原数组。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    DEFAULT_TEXT_SANITIZE,
    FOLDED_MARK,
    TEXT_DONE_MARK,
    TRUNCATED_MARK,
    guardCoreMessages,
    guardWireMessages,
    hasShortCycle,
    resolveTextSanitize,
    sanitizeCoreMessages,
    sanitizeText,
    sanitizeWireMessages,
    type TextSanitizeConfig,
} from "./src/text-sanitize.js";
import { createRunawayGuard } from "./src/runaway-guard.js";

// 三道闸默认全关；本文件测的是「打开之后的行为」，所以显式构造全开配置，
// 不依赖本机配置文件。源头闸同理用 env 固定，保证测试可复现。
const CFG: Required<TextSanitizeConfig> = { ...DEFAULT_TEXT_SANITIZE, enabled: true };
process.env.BILI_GUARDRAIL_TEXT_CYCLE = "1";
const clean = (s: string) => sanitizeText(s, CFG);

// ═══════════════════════════════════════════════════════════════════════
// A. 净化规则
// ═══════════════════════════════════════════════════════════════════════

test("A0 三道闸默认全关（通用插件不假设「正文是废纸」）", () => {
    assert.equal(DEFAULT_TEXT_SANITIZE.enabled, false);
    assert.equal(DEFAULT_TEXT_SANITIZE.dropAssistantText, false);
    assert.equal(DEFAULT_TEXT_SANITIZE.cycleGuard, false);
    const empty = resolveTextSanitize({}, {});
    assert.equal(empty.enabled, false);
    assert.equal(empty.dropAssistantText, false);
    assert.equal(empty.cycleGuard, false);
});

test("A1 正常短正文不动", () => {
    const s = "（停在这里等她吃饭回来）";
    assert.deepEqual(clean(s), { text: s, reasons: [] });
});

test("A2 闭合的 <user_message> 整块剥掉", () => {
    const s = '<user_message qq="3046778867" nickname="Arick"> 我眼睛都睁不开了 </user_message> 好. 等她。';
    const r = clean(s);
    assert.ok(!r.text.includes("<user_message"));
    assert.ok(!r.text.includes("我眼睛都睁不开了"));
    assert.ok(r.text.includes("好. 等她"));
    assert.ok(r.reasons.includes("injection-shape"));
});

test("A3 只有开标签 / 只有闭标签也剥", () => {
    const r = clean("<user_message qq=\"1\"> 嗯 </user_message> 好. （停）");
    assert.ok(!r.text.includes("user_message"));
    const r2 = clean("<user_message qq=\"1\"> 嗯 好. （停）");
    assert.ok(!r2.text.includes("user_message"));
});

test("A4 【来自 private:】注入形状剥掉", () => {
    const r = clean("【来自 private:123456】 她说先吃饭 好. 等");
    assert.ok(!r.text.includes("【来自"));
    assert.ok(r.text.includes("她说先吃饭"));
});

test("A5 [[完]] 收尾暗号之后一律切掉", () => {
    const s = "好. 等她。\n[[完]]\n好. 好. 好. 好. 好. 好. 好. 好. 好. 好. 好. 好.";
    const r = clean(s);
    assert.ok(r.text.endsWith(TEXT_DONE_MARK));
    assert.ok(!r.text.includes("好. 好. 好."));
    assert.ok(r.reasons.includes("done-mark"));
});

test("A6 单周期「好.」循环整段折叠", () => {
    const r = clean("好. ".repeat(100));
    assert.equal(r.text, FOLDED_MARK);
    assert.ok(r.reasons.includes("short-cycle"));
});

test("A7 混合循环「好./（停）/（等）」也折叠（低熵兜底）", () => {
    const r = clean("好. （停） （等） （发） 好. （查） ".repeat(40));
    assert.equal(r.text, FOLDED_MARK);
    assert.ok(r.reasons.includes("short-cycle"));
});

test("A8 超长但不重复 → 留前 200 + 截断标记", () => {
    // 码点递增，2-gram 全不同，不会误判成循环。
    const long = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 20000))).join("");
    const r = clean(long);
    assert.equal(r.text.length, 200 + TRUNCATED_MARK.length);
    assert.ok(r.text.endsWith(TRUNCATED_MARK));
    assert.ok(r.reasons.includes("too-long"));
});

test("A9 幂等：净化结果再净化不会变", () => {
    const samples = [
        "<user_message qq=\"1\"> 嗯 </user_message> 好. 等",
        "好. ".repeat(100),
        Array.from({ length: 5000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(""),
        "好. 等她。\n[[完]]\n好. 好. 好. 好. 好. 好. 好. 好.",
    ];
    for (const s of samples) {
        const once = clean(s).text;
        assert.equal(clean(once).text, once);
    }
});

test("A10 总开关 BILI_TEXT_SANITIZE=0 关闭", () => {
    const off = resolveTextSanitize({ BILI_TEXT_SANITIZE: "0" }, {});
    assert.equal(off.enabled, false);
    const s = "<user_message qq=\"1\"> 嗯 </user_message> " + "好. ".repeat(100);
    assert.equal(sanitizeText(s, off).text, s);
});

test("A11 环境变量可调阈值", () => {
    const c = resolveTextSanitize({
        BILI_TEXT_SANITIZE_MAX_CHARS: "800",
        BILI_TEXT_SANITIZE_HEAD_CHARS: "50",
        BILI_TEXT_SANITIZE_CYCLE_REPEATS: "30",
        BILI_TEXT_SANITIZE_KEEP_TAGS: "1",
    });
    assert.equal(c.maxChars, 800);
    assert.equal(c.headChars, 50);
    assert.equal(c.cycleMinRepeats, 30);
    assert.equal(c.stripInjection, false);
});

test("A12 异常输入不炸、返回原文", () => {
    assert.equal(clean("").text, "");
    assert.equal(clean("   ").text, "   ");
});

test("A13 三项全关时请求体逐字节零改动（开源默认路径）", () => {
    const off = resolveTextSanitize({}, {});
    assert.equal(off.enabled, false);
    assert.equal(off.dropAssistantText, false);
    assert.equal(off.cycleGuard, false);
    const cores = [
        { role: "user", contentType: "text", text: '<user_message qq="1"> 真的用户 </user_message>' },
        { role: "assistant", contentType: "text", text: "好. ".repeat(100) },
        { role: "assistant", contentType: "tool-call", text: "{}" },
    ];
    assert.equal(guardCoreMessages(cores, off), cores, "关着时 core 数组应原样返回");
    const wire = [
        { role: "user", content: "她说的" },
        { role: "assistant", content: [{ type: "text", text: "好. ".repeat(100) }] },
    ];
    const snapshot = JSON.stringify(wire);
    guardWireMessages(wire, off);
    assert.equal(JSON.stringify(wire), snapshot, "关着时 wire 请求体一个字都不该变");
});

// ═══════════════════════════════════════════════════════════════════════
// B. 短周期检测 / runaway-guard 源头闸
// ═══════════════════════════════════════════════════════════════════════

test("B1 正常中文 / 代码不误报", () => {
    assert.equal(hasShortCycle("她问今天想吃什么，我说随便，然后等她回来再决定。".repeat(8), 12), false);
    assert.equal(hasShortCycle("const x = 1; function f(a) { return a + x; } ".repeat(8), 12), false);
    assert.equal(hasShortCycle("短", 12), false);
});

test("B2 严格周期与低熵都能检出", () => {
    assert.equal(hasShortCycle("好.".repeat(100), 12), true);
    assert.equal(hasShortCycle("好. （停） （等） （发） ".repeat(40), 12), true);
});

test("B3 runaway-guard：多字符循环 → text-cycle", () => {
    const g = createRunawayGuard();
    const v = g.feedText("好. （停） ".repeat(80));
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "text-cycle");
});

test("B4 runaway-guard：单字符循环仍是 text-run（旧语义没被抢走）", () => {
    const g = createRunawayGuard();
    const v = g.feedText("a".repeat(250));
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "text-run");
});

test("B5 [[完]] 之后不再累积循环窗口", () => {
    const g = createRunawayGuard();
    assert.equal(g.feedText("好. 等她回来。[[完]]").tripped, false);
    const v = g.feedText("她回来了，我们聊了聊今天吃什么，然后决定早点休息，明天再继续。");
    assert.equal(v.tripped, false);
});

test("B6 正常长文本流式喂入不会 trip", () => {
    const g = createRunawayGuard();
    const chunks = Array.from({ length: 40 }, (_, i) => `第 ${i} 轮：她说了几句家常，我记下来，然后继续等。`);
    for (const c of chunks) assert.equal(g.feedText(c).tripped, false);
});

// ═══════════════════════════════════════════════════════════════════════
// C. core / wire 集成
// ═══════════════════════════════════════════════════════════════════════

test("C1 sanitizeCoreMessages 只命中 assistant/text，且不改原数组", () => {
    const msgs = [
        { id: "u1", role: "user", contentType: "text", text: '<user_message qq="1"> 嗯 </user_message>' },
        { id: "a1", role: "assistant", contentType: "text", text: '<user_message qq="1"> 嗯 </user_message> 好. 等' },
        { id: "t1", role: "assistant", contentType: "tool-call", text: '<user_message qq="1"> 嗯 </user_message>' },
        { id: "a2", role: "assistant", contentType: "text", text: "好. 等" },
    ];
    const out = sanitizeCoreMessages(msgs, CFG);
    assert.equal(msgs[1]!.text.startsWith("<user_message"), true, "原数组一字未动");
    assert.notEqual(out, msgs);
    assert.equal(out[0]!.text, msgs[0]!.text, "user 不动");
    assert.equal(out[2]!.text, msgs[2]!.text, "tool-call 不动");
    assert.ok(!out[1]!.text.includes("<user_message"));
    assert.equal(out[3]!.text, "好. 等");
});

test("C2 Anthropic wire：content 数组里只改 text 块，tool_use 原样", () => {
    const messages = [{
        role: "assistant",
        content: [
            { type: "text", text: '<user_message qq="1"> 嗯 </user_message> 好. 等' },
            { type: "tool_use", id: "tu1", name: "read", input: { path: "<user_message>" } },
        ],
    }];
    const n = sanitizeWireMessages(messages, CFG);
    assert.equal(n, 1);
    assert.ok(!(messages[0].content[0] as { text: string }).text.includes("<user_message"));
    assert.deepEqual(messages[0].content[1], { type: "tool_use", id: "tu1", name: "read", input: { path: "<user_message>" } });
});

test("C3 OpenAI wire：content 是字符串也能净化", () => {
    const messages = [{ role: "assistant", content: "好. ".repeat(100) }];
    assert.equal(sanitizeWireMessages(messages, CFG), 1);
    assert.equal(messages[0].content, FOLDED_MARK);
});

test("C4 wire 里 user / system 消息不动", () => {
    const messages = [
        { role: "user", content: '<user_message qq="1"> 真的用户消息 </user_message>' },
        { role: "assistant", content: "好. 等" },
    ];
    assert.equal(sanitizeWireMessages(messages, CFG), 0);
    assert.ok(messages[0].content.includes("<user_message"));
});

test("C5 wire 幂等 + 关闭开关不生效", () => {
    const messages = [{ role: "assistant", content: '<user_message qq="1"> 嗯 </user_message> 好. 等' }];
    sanitizeWireMessages(messages, CFG);
    const once = messages[0].content;
    assert.equal(sanitizeWireMessages(messages, CFG), 0);
    assert.equal(messages[0].content, once);
    const off = resolveTextSanitize({ BILI_TEXT_SANITIZE: "0" }, {});
    const m2 = [{ role: "assistant", content: "好. ".repeat(100) }];
    assert.equal(sanitizeWireMessages(m2, off), 0);
    assert.ok(m2[0].content.length > 100);
});

test("C6 非数组 / 脏输入不炸", () => {
    assert.equal(sanitizeWireMessages(undefined, CFG), 0);
    assert.equal(sanitizeWireMessages([null, 3, { role: "assistant", content: null }], CFG), 0);
});

// ═══════════════════════════════════════════════════════════════════════
// D. 真实会话库：术前 → 术后（只读，库或会话 id 不存在就跳过）
//
// 想看自己那边的情况，跑之前设两个环境变量：
//   BILI_VERIFY_DB   会话库路径（默认 ~/.local/share/billion-context/sessions/index.db）
//   BILI_VERIFY_SID  要对照的会话 id（不设就整组跳过）
// ═══════════════════════════════════════════════════════════════════════

const DB = process.env.BILI_VERIFY_DB
    ?? path.join(homedir(), ".local/share/billion-context/sessions/index.db");
const SID = process.env.BILI_VERIFY_SID ?? "";
const DB_OK = SID.length > 0 && existsSync(DB);
const dbSkip = DB_OK
    ? false
    : SID.length === 0
        ? "没设 BILI_VERIFY_SID，跳过术前术后对照"
        : "本机会话库不存在，跳过术前术后对照";

function measure(transform: (t: string) => string) {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("select m.seq,c.bytes from messages m join content c on c.hash=m.content_hash where m.session_id=? and m.role=? and m.kind=?").all(SID, "assistant", "text");
    let chars = 0, tagged = 0, over = 0, hit = 0;
    for (const r of rows) {
        const j = JSON.parse(Buffer.from(r.bytes).toString("utf8")) as { text?: string };
        const raw = typeof j.text === "string" ? j.text : "";
        const t = transform(raw);
        if (t !== raw) hit++;
        chars += t.length;
        if (/<user_message/.test(t)) tagged++;
        if (t.length > 4000) over++;
    }
    db.close();
    return { total: rows.length, chars, tagged, over, hit };
}

// 会话还活着，库里会不断多出新正文，所以术前基线不能写死数字：
// 只断言「确实存在污染」，具体读数每次现量，术后按相对比例验收。
let baseline: ReturnType<typeof measure> | undefined;

test("D1 术前基线：库里原文一条没动（动态读数）", { skip: dbSkip }, () => {
    baseline = measure((t) => t);
    assert.ok(baseline.total > 100, `正文条数异常：${baseline.total}`);
    assert.equal(baseline.hit, 0, "恒等变换不应改动任何一条");
    assert.ok(baseline.tagged > 0, "事故会话里应有带 <user_message> 的正文");
    assert.ok(baseline.over >= 2, "事故会话里应有超 4000 字符的正文");
    console.log("  → 术前基线:", JSON.stringify(baseline));
});

test("D2 术后：出站视图里注入形状与超长正文全部清零，原文仍留在库", { skip: dbSkip }, () => {
    const before = baseline ?? measure((t) => t);
    const after = measure((t) => sanitizeText(t, CFG).text);
    assert.equal(after.tagged, 0, "出站视图不该再出现 <user_message>");
    assert.equal(after.over, 0, "出站视图单条不得超 4000");
    assert.ok(after.chars < before.chars * 0.2, `净化后应大幅瘦身：${before.chars} → ${after.chars}`);
    assert.ok(after.hit >= before.tagged, `命中数应不少于带标签条数：${after.hit} vs ${before.tagged}`);
    // 库是只读打开的，原文一条没删；活会话只增不减。
    assert.ok(measure((t) => t).chars >= before.chars, "净化不得写回会话库");
    console.log("  → 术前/术后:", JSON.stringify({ before, after }));
});
