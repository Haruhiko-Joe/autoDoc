import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../tokenize.js";

describe("tokenize", () => {
  it("lowercases and splits ASCII words", () => {
    const tokens = tokenize("Hello World Scaffold Agent");
    assert.ok(tokens.includes("hello"));
    assert.ok(tokens.includes("world"));
    assert.ok(tokens.includes("scaffold"));
    assert.ok(tokens.includes("agent"));
  });

  it("drops English stopwords", () => {
    const tokens = tokenize("the quick brown fox is jumping over the lazy dog");
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("is"));
    assert.ok(!tokens.includes("over"));
    assert.ok(tokens.includes("quick"));
    assert.ok(tokens.includes("brown"));
  });

  it("splits camelCase and snake_case identifiers", () => {
    const tokens = tokenize("docRetriever build_chat_context");
    assert.ok(tokens.includes("docretriever"));
    assert.ok(tokens.includes("doc"));
    assert.ok(tokens.includes("retriever"));
    assert.ok(tokens.includes("build"));
    assert.ok(tokens.includes("chat"));
    assert.ok(tokens.includes("context"));
  });

  it("emits overlapping bigrams for CJK text", () => {
    const tokens = tokenize("数据库查询");
    // "数据", "据库", "库查", "查询"
    assert.ok(tokens.includes("数据"));
    assert.ok(tokens.includes("据库"));
    assert.ok(tokens.includes("库查"));
    assert.ok(tokens.includes("查询"));
  });

  it("mixes CJK bigrams with ASCII words", () => {
    const tokens = tokenize("使用 Scaffold Agent 生成顶层模块图");
    assert.ok(tokens.includes("scaffold"));
    assert.ok(tokens.includes("agent"));
    assert.ok(tokens.includes("顶层"));
    assert.ok(tokens.includes("模块"));
  });

  it("drops common CJK stopwords", () => {
    const tokens = tokenize("这个是一个文档");
    assert.ok(!tokens.includes("这个"));
    assert.ok(!tokens.includes("一个"));
    assert.ok(tokens.includes("文档"));
  });

  it("returns empty array for null/undefined/empty input", () => {
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize([]), []);
  });

  it("handles array input by joining", () => {
    const tokens = tokenize(["scaffold", "decomposer"]);
    assert.ok(tokens.includes("scaffold"));
    assert.ok(tokens.includes("decomposer"));
  });
});
