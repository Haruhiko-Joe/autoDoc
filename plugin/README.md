# kioku — 记忆树 Agent System(Claude Code plugin)

kioku 不是一个"记笔记的 skill",而是一个**维护记忆树的 agent system**:普通 agent 只负责把"值得记住的事"投递为提案,一个专职的 **memory-curator agent** 拥有记忆树的全部写权,hooks 在每一次写入上做确定性把关,引擎负责溯源盖戳与 git 提交。记忆本体是纯 Markdown + JSON,任何生产力 agent(Claude Code / Codex / Copilot)都能直接消费。

## 架构

```
                    ┌──────────────────────────────────────────────┐
 主 agent(任意)    │  .agent-memory/            (项目根,独立 git) │
   │ ① 读:Read/Grep │  ├── top.json     树索引(curator 维护)      │
   │ ② 记:Write 提案 │  ├── tree/<path>/<name>.md  记忆页(树状)   │
   ▼                │  ├── staging/     ← 普通 agent 唯一可写处     │
 [PreToolUse hook]──┤  └── update-log.jsonl  巩固日志(引擎)       │
   schema 校验/放行  └──────────────────────────────────────────────┘
   ③ 轮次结束               ▲ 写树本体(同样被 hook 校验)
 [Stop/SessionEnd hook]     │
   staging 非空 → headless 运行 memory-curator agent(claude -p)
   → curator 语义巩固:归类/合并/建节点/拒收
   → 引擎盖戳(sourceSession/sourceSha/时间)→ git commit
   ④ 下次会话 [SessionStart hook] 注入树索引
```

三层写权限(全部由 hooks 强制,不依赖自觉):

| 主体 | 可写范围 | 把关方式 |
|---|---|---|
| 普通 agent | 仅 `staging/*.md` | PreToolUse 即时 schema 校验,合法自动放行、非法带原因拒绝 |
| memory-curator | `tree/**` + `top.json` | 同一 hook 校验结构;headless 运行时默认权限下,记忆库之外的写一律被拒 |
| 引擎(脚本) | 溯源戳、update-log、git | 确定性代码,LLM 不参与 |

设计借鉴了 OpenAI codex plugin 的两个模式:**专职 agent 作为薄编排层**(`agents/codex-rescue.md`)与 **Stop 时间网关同步运行 LLM 并转译其裁决**(`stop-review-gate-hook.mjs`)。

## 组件

```
plugin/
├── .claude-plugin/plugin.json
├── agents/memory-curator.md     # 树的唯一维护者:巩固协议、树健康规则、边界
├── skills/memory/SKILL.md       # 消费协议:何时记/怎么记/何时委派 curator(跨 agent 可移植)
├── prompts/consolidate.md       # headless 巩固任务模板
├── hooks/hooks.json             # SessionStart / PreToolUse / Stop / SessionEnd
└── scripts/
    ├── lib.mjs                  # 目录解析、frontmatter、页/索引校验器
    ├── session-start.mjs        # 注入树索引(预算内裁剪,超限降级为节点摘要)
    ├── validate-write.mjs       # 双层写权限闸门
    └── consolidate-gate.mjs     # 巩固网关:短路 → headless curator → 盖戳 → commit
```

## 安装

```bash
# 方式一(推荐,免 marketplace):skills-dir 插件,下次会话自动加载为 kioku@skills-dir
cp -r plugin ~/.claude/skills/kioku

# 方式二:单次会话试用
claude --plugin-dir ./plugin

# 方式三:项目级共享(进 git,克隆者经 workspace trust 后生效)
cp -r plugin .claude/skills/kioku
```

前置:`node`(>=18)与 `git` 在 PATH;巩固网关额外需要 `claude` CLI(缺失时提案安全地留在 staging,仅打印提示)。

## 使用

- **记**:任何会话里,agent 学到durable 的事实(用户纠正、项目决策、环境坑)→ 按 memory skill 协议写 `staging/<name>.md`,hook 即时校验。轮次结束自动巩固进树。
- **忆**:每次会话开始自动注入树索引;细节按需 `Read .agent-memory/tree/<path>/<name>.md`。
- **管**:对用户说"整理/审计/清理一下项目记忆"→ 主 agent 委派 memory-curator(交互式),做树重组、去重、过期清理。
- 首次使用无需初始化:第一条提案写入时创建目录(经一次常规权限确认),之后全链路自动。

配置(环境变量):`AGENT_MEMORY_DIR` 改库位置;`KIOKU_MODEL` 指定巩固用模型(默认继承 CLI 默认)。建议把 `.agent-memory/` 加进项目 `.gitignore`(库自带独立 git 历史;要团队共享可改为直接纳入项目仓库并删除库内 `.git`)。

## 其他 agent 怎么消费(Codex / Copilot 等)

记忆本体是纯文件,零依赖消费:

1. **协议移植**:`skills/memory/SKILL.md` 是开放的 SKILL.md 标准,复制到 `.codex/skills/memory/` 即可让 Codex 获得同一套记/忆协议;Copilot 等可在 AGENTS.md 里加一句:*"Project memory lives in `.agent-memory/tree/` (index: `top.json`); read relevant pages before large tasks; propose durable learnings as Markdown files in `.agent-memory/staging/` following the schema in any existing page."*
2. **直接读写**:非 Claude agent 写入 staging 时没有 PreToolUse 即时校验,但巩固网关(任一 Claude Code 会话结束时)会统一复检——非法提案不会进树,只会留在 staging 等待修复。
3. **溯源**:`git -C .agent-memory log / blame` 查每条记忆的演化;`update-log.jsonl` 记录每次巩固消费了什么、拒绝了什么。

## 已知边界

- 巩固时机绑定 Claude Code 的 Stop/SessionEnd;纯 Codex 工作流需手动触发一次 Claude 会话(或后续提供独立 CLI)。
- PreToolUse 只拦 Write/Edit,经 Bash 绕写记忆库不被即时拦截——但巩固网关的复检与 git 历史兜底。
- curator 的语义质量依赖模型;结构正确性由 hook 保证,内容正确性靠提案纪律 + git 可回滚。
