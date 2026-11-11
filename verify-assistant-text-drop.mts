/**
 * 「正文不进上下文」验收（textGuard.dropAssistantText）。
 *
 *   <Node24> --import tsx --test verify-assistant-text-drop.mts
 *
 * 覆盖：默认全关、配置优先级、关着零改动、开着只丢 assistant text、
 * tool-call/tool-result/reasoning/user 原样、签名 thinking 保守跳过、
 * 四条 wire（anthropic/openai/responses/google）、降级路径、库里原文不动。
 *
 * 不变量：只改 OUTBOUND 视图；不改存盘、不改 content_hash、不改入参数组。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    DEFAULT_TEXT_SANITIZE,
    dropAssistantTextFromCores,
    dropAssistantTextFromWire,
    guardCoreMessages,
    guardWireMessages,
    resolveTextSanitize,
    sanitizeText,
    type TextSanitizeConfig,
} from "./src/text-sanitize.js";

const ON: Required<TextSanitizeConfig> = {
    ...DEFAULT_TEXT_SANITIZE,
    enabled: true,
    dropAssistantText: true,
    cycleGuard: true,
};
const DROP_ONLY: Required<TextSanitizeConfig> = { ...DEFAULT_TEXT_SANITIZE, dropAssistantText: true };
const OFF = DEFAULT_TEXT_SANITIZE;

// ═══════════════════════════════════════════════════════════════════════
// A. 开关
// ═══════════════════════════════════════════════════════════════════════

test("A1 三项默认全关", () => {
    assert.equal(DEFAULT_TEXT_SANITIZE.enabled, false);
    assert.equal(DEFAULT_TEXT_SANITIZE.dropAssistantText, false);
    assert.equal(DEFAULT_TEXT_SANITIZE.cycleGuard, false);
});

test("A2 优先级：env > 配置文件 > 默认", () => {
    const file = { dropAssistantText: true, sanitize: true, cycleGuard: true };
    const fromFile = resolveTextSanitize({}, file);
    assert.equal(fromFile.dropAssistantText, true);
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.cycleGuard, true);

    const envOff = resolveTextSanitize({ BILI_TEXT_GUARD_DROP_ASSISTANT_TEXT: "0" }, file);
    assert.equal(envOff.dropAssistantText, false, "env=0 必须压过文件里的 true");

    const envOn = resolveTextSanitize({ BILI_TEXT_GUARD_DROP_ASSISTANT_TEXT: "1" }, {});
    assert.equal(envOn.dropAssistantText, true);

    assert.equal(resolveTextSanitize({}, {}).dropAssistantText, false);
    assert.equal(resolveTextSanitize({ BILI_GUARDRAIL_TEXT_CYCLE: "1" }, {}).cycleGuard, true);
    assert.equal(resolveTextSanitize({ BILI_GUARDRAIL_TEXT_CYCLE: "0" }, file).cycleGuard, false);
});

test("A3 关着：core 与 wire 都零改动", () => {
    const msgs = [
        { id: "u1", role: "user", contentType: "text", text: "她说先吃饭" },
        { id: "a1", role: "assistant", contentType: "text", text: "好. 等" },
        { id: "t1", role: "assistant", contentType: "tool-call", text: "{}" },
    ];
    assert.equal(dropAssistantTextFromCores(msgs, OFF), msgs);
    const wire = [{ role: "assistant", content: [{ type: "text", text: "好. 等" }] }];
    assert.equal(dropAssistantTextFromWire(wire, OFF), 0);
    assert.equal((wire[0].content as { text: string }[])[0].text, "好. 等");
});

// ═══════════════════════════════════════════════════════════════════════
// B. CoreMessage 层（主出站 processedMessages / relay 二次渲染）
// ═══════════════════════════════════════════════════════════════════════

test("B1 开着：只丢 assistant/text，其余原样，且不改原数组", () => {
    const msgs = [
        { id: "u1", role: "user", contentType: "text", text: '<user_message qq="1"> 嗯 </user_message>' },
        { id: "a1", role: "assistant", contentType: "text", text: '<user_message qq="1"> 假标签 </user_message> 好. 等' },
        { id: "r1", role: "assistant", contentType: "reasoning", text: "想了一下" },
        { id: "t1", role: "assistant", contentType: "tool-call", text: '{"command":"say.mjs"}' },
        { id: "t2", role: "assistant", contentType: "tool-result", text: "ok" },
        { id: "a2", role: "assistant", contentType: "text", text: "（停在这里等她）" },
    ];
    const out = dropAssistantTextFromCores(msgs, DROP_ONLY);
    assert.deepEqual(out.map((m) => m.id), ["u1", "r1", "t1", "t2"]);
    assert.equal(msgs.length, 6, "原数组一字未动");
    assert.equal(msgs[1].text.startsWith("<user_message"), true);
});

test("B2 带签名 thinking 的 assistant text 保守保留（上游不许改相邻块）", () => {
    const msgs = [
        { role: "assistant", contentType: "text", text: "正常正文", thinkingSignature: "sig-abc" },
        { role: "assistant", contentType: "text", text: "另一段", rawAnthropicBlock: { type: "redacted_thinking" } },
        { role: "assistant", contentType: "text", text: "该丢的" },
    ];
    const out = dropAssistantTextFromCores(msgs, DROP_ONLY);
    assert.equal(out.length, 2);
    assert.ok(out.some((m) => m.text === "正常正文"));
    assert.ok(out.some((m) => m.text === "另一段"));
});

test("B3 多轮连续 / 幂等", () => {
    const mk = () => ([
        { role: "user" as const, contentType: "text" as const, text: "她说的" },
        { role: "assistant" as const, contentType: "text" as const, text: "草稿" },
    ]);
    for (let round = 0; round < 4; round++) {
        const out = dropAssistantTextFromCores(mk(), DROP_ONLY);
        assert.equal(out.length, 1);
        assert.equal(dropAssistantTextFromCores(out, DROP_ONLY).length, 1);
    }
});

test("B4 guardCoreMessages：先摘除再净化，带标签的正文不会残留", () => {
    const msgs = [
        { role: "assistant", contentType: "text", text: '<user_message qq="1"> 嗯 </user_message> 好. 等' },
        { role: "user", contentType: "text", text: '<user_message qq="1"> 真的用户 </user_message>' },
    ];
    const out = guardCoreMessages(msgs, ON);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    assert.ok(out[0].text.includes("<user_message"), "user 消息不受影响");
});

// ═══════════════════════════════════════════════════════════════════════
// C. wire 层（降级路径 / 各宿主形状）
// ═══════════════════════════════════════════════════════════════════════

test("C1 Anthropic：只摘 text 块，tool_use 完整保留", () => {
    const messages = [{
        role: "assistant",
        content: [
            { type: "text", text: "草稿" },
            { type: "tool_use", id: "tu1", name: "read", input: { path: "a.md" } },
            { type: "text", text: "又一段草稿" },
        ],
    }];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 1);
    assert.deepEqual(messages[0].content, [{ type: "tool_use", id: "tu1", name: "read", input: { path: "a.md" } }]);
});

test("C2 全是 text 的 assistant 消息 → 整条删，不留空消息", () => {
    const messages = [
        { role: "user", content: "她说的" },
        { role: "assistant", content: [{ type: "text", text: "草稿" }] },
        { role: "user", content: "下一句" },
    ];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 1);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((m) => m.role), ["user", "user"]);
});

test("C3 纯字符串 content + tool_calls → 只清 content，不删工具调用", () => {
    const messages = [{
        role: "assistant",
        content: "我先说一句再调工具",
        tool_calls: [{ id: "c1", type: "function", function: { name: "say", arguments: "{}" } }],
    }];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "");
    assert.equal(messages[0].tool_calls.length, 1);
});

test("C4 纯字符串 content 且无工具 → 删整条", () => {
    const messages = [{ role: "assistant", content: "纯草稿" }, { role: "user", content: "她说的" }];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "user");
});

test("C5 带 signature thinking / redacted_thinking 的 wire 消息整条跳过", () => {
    const messages = [
        { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "text", text: "草稿" }] },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "…" }, { type: "text", text: "草稿2" }] },
        { role: "assistant", content: [{ type: "text", text: "该丢的" }] },
    ];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 1);
    assert.equal(messages.length, 2);
});

test("C6 Responses `output_text` / Google `parts` 通用", () => {
    const resp = [{ role: "assistant", content: [{ type: "output_text", text: "草稿" }, { type: "function_call", call_id: "c1" }] }];
    assert.equal(dropAssistantTextFromWire(resp, DROP_ONLY), 1);
    assert.deepEqual(resp[0].content, [{ type: "function_call", call_id: "c1" }]);

    const google = [
        { role: "user", parts: [{ text: "她说的" }] },
        { role: "model", parts: [{ text: "草稿" }, { functionCall: { name: "say" } }] },
    ];
    assert.equal(dropAssistantTextFromWire(google, DROP_ONLY), 1);
    assert.deepEqual(google[1].parts, [{ functionCall: { name: "say" } }]);
});

test("C7 user / system / 非数组脏输入不动", () => {
    const messages = [
        { role: "user", content: '<user_message qq="1"> 真的用户 </user_message>' },
        { role: "system", content: "系统提示" },
        null, 3, { role: "assistant", content: null },
    ];
    assert.equal(dropAssistantTextFromWire(messages, DROP_ONLY), 0);
    assert.equal(messages[0].content.includes("<user_message"), true);
    assert.equal(dropAssistantTextFromWire(undefined, DROP_ONLY), 0);
});

test("C8 guardWireMessages：摘除 + 净化组合，user 的标签仍保留", () => {
    const messages = [
        { role: "user", content: '<user_message qq="1"> 真的用户 </user_message>' },
        { role: "assistant", content: '<user_message qq="1"> 假标签 </user_message> ' + "好. ".repeat(100) },
    ];
    guardWireMessages(messages, ON);
    assert.equal(messages.length, 1, "assistant 草稿整条摘掉");
    assert.ok(messages[0].content.includes("<user_message"));
});

// ═══════════════════════════════════════════════════════════════════════
// D. 真实会话库：出站视图为 0，库里原文不动
//
// 想看自己那边的情况，跑之前设两个环境变量：
//   BILI_VERIFY_DB   会话库路径（默认 ~/.local/share/billion-context/sessions/index.db）
//   BILI_VERIFY_SID  要对照的会话 id（不设就整组跳过）
// ═══════════════════════════════════════════════════════════════════════

const DB = process.env.BILI_VERIFY_DB
    ?? path.join(homedir(), ".local/share/billion-context/sessions/index.db");
const SID = process.env.BILI_VERIFY_SID ?? "";
const dbSkip = SID.length > 0 && existsSync(DB)
    ? false
    : SID.length === 0
        ? "没设 BILI_VERIFY_SID，跳过真实数据对照"
        : "本机会话库不存在，跳过真实数据对照";

function readTexts(): string[] {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("select m.seq,c.bytes from messages m join content c on c.hash=m.content_hash where m.session_id=? and m.role=? and m.kind=?").all(SID, "assistant", "text");
    const out: string[] = [];
    for (const r of rows) {
        const j = JSON.parse(Buffer.from(r.bytes).toString("utf8")) as { text?: string };
        out.push(typeof j.text === "string" ? j.text : "");
    }
    db.close();
    return out;
}

test("D1 关着：出站视图的 assistant text 条数等于库里条数", { skip: dbSkip }, () => {
    const texts = readTexts();
    const msgs = texts.map((t, i) => ({ id: `m${i}`, role: "assistant", contentType: "text", text: t }));
    assert.equal(dropAssistantTextFromCores(msgs, OFF).length, texts.length);
});

test("D2 开着：出站视图里 assistant text 为 0；库里原文一条没删", { skip: dbSkip }, () => {
    const before = readTexts();
    assert.ok(before.length > 100);
    const msgs = before.map((t, i) => ({ id: `m${i}`, role: "assistant", contentType: "text", text: t }));
    const out = dropAssistantTextFromCores(msgs, DROP_ONLY);
    assert.equal(out.filter((m) => m.role === "assistant" && m.contentType === "text").length, 0);
    // 原文仍在、只增不减（活会话可能继续写入）。
    const after = readTexts();
    assert.ok(after.length >= before.length, "净化不得写回会话库");
    assert.equal(after[0], before[0], "抽查第一条原文逐字不变");
    console.log("  → 库里 assistant/text =", before.length, " 出站视图 =", out.length);
});
