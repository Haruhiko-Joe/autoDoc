# UserInteraction — 用户交互工具工厂

## 概述与职责

UserInteraction 模块属于 **ToolSystem → ToolDefinitions → BuiltinToolDefs** 层级，提供两个工厂函数，分别生成面向用户的交互工具定义：

- **`create_request_user_input_tool`**：构建一个结构化问卷工具，允许 Agent 向用户提出多选题并等待回答
- **`create_update_plan_tool`**：构建一个计划管理工具，允许 Agent 维护和更新任务步骤的执行进度

这两个工厂函数的产物都是 `ToolSpec::Function(ResponsesApiTool {...})`，即符合 OpenAI Responses API 格式的函数工具定义，最终由 RegistryPlan 模块在会话初始化时调用并注册到工具集中。

同级的兄弟模块还包括 shell 执行、apply-patch、agent 生命周期管理、MCP 桥接等工具工厂。

---

## 关键流程

### request_user_input 工具的构建与使用流程

1. **RegistryPlan** 在组装会话工具集时，先调用 `request_user_input_tool_description()` 生成描述文本（描述中包含当前允许使用该工具的协作模式列表）
2. 将描述传入 `create_request_user_input_tool(description)` 得到完整的 `ToolSpec`
3. Agent 运行时调用该工具时，传入的 JSON 参数会被反序列化为 `RequestUserInputArgs`
4. 系统调用 `normalize_request_user_input_args()` 进行校验和标准化：
   - 校验每个问题都有非空的 `options`，否则返回错误
   - 为每个问题设置 `is_other = true`（客户端会自动追加"其他"自由输入选项）
5. 如果当前协作模式不支持该工具，`request_user_input_unavailable_message()` 返回一条不可用提示

### update_plan 工具的构建流程

1. **RegistryPlan** 调用 `create_update_plan_tool()`（无参数）
2. 返回一个名为 `"update_plan"` 的 `ToolSpec`，Agent 可通过它提交计划步骤列表及其状态

---

## 函数签名与参数说明

### `create_request_user_input_tool(description: String) -> ToolSpec`

工厂函数，构建 `request_user_input` 工具定义。

- **description**：工具描述文本，通常由 `request_user_input_tool_description()` 生成，包含模式可用性信息
- **返回值**：`ToolSpec::Function`，工具名称为 `"request_user_input"`，`strict: false`

> 源码位置：`codex-rs/tools/src/request_user_input_tool.rs:11-95`

### `request_user_input_tool_description(default_mode_request_user_input: bool) -> String`

根据是否在 Default 模式下也启用该工具，生成包含允许模式列表的描述字符串。

- **default_mode_request_user_input**：`true` 表示 Default 模式也允许使用该工具
- **返回值**：形如 `"Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode."` 的描述

> 源码位置：`codex-rs/tools/src/request_user_input_tool.rs:129-134`

### `normalize_request_user_input_args(args: RequestUserInputArgs) -> Result<RequestUserInputArgs, String>`

校验并标准化用户输入请求参数。

- 校验每个 question 的 `options` 非空，否则返回 `Err`
- 为所有 question 设置 `is_other = true`
- **返回值**：标准化后的参数或错误消息

> 源码位置：`codex-rs/tools/src/request_user_input_tool.rs:111-127`

### `request_user_input_unavailable_message(mode: ModeKind, default_mode_request_user_input: bool) -> Option<String>`

检查当前模式下工具是否可用，不可用时返回提示消息。

- **mode**：当前协作模式（`Plan`、`Default`、`Execute` 等）
- **返回值**：`None` 表示可用，`Some(msg)` 表示不可用及原因

> 源码位置：`codex-rs/tools/src/request_user_input_tool.rs:97-109`

### `create_update_plan_tool() -> ToolSpec`

工厂函数，构建 `update_plan` 工具定义。无参数。

- **返回值**：`ToolSpec::Function`，工具名称为 `"update_plan"`，`strict: false`

> 源码位置：`codex-rs/tools/src/plan_tool.rs:6-51`

---

## 接口/类型定义

### request_user_input 工具的 JSON Schema 结构

工具参数的嵌套 schema 如下：

```
{
  "questions": [                          // 必填，1-3 个问题
    {
      "id": string,                       // snake_case 标识符，用于映射回答
      "header": string,                   // UI 显示的短标题（≤12 字符）
      "question": string,                 // 展示给用户的单句提问
      "options": [                        // 2-3 个互斥选项
        {
          "label": string,                // 用户可见标签（1-5 词）
          "description": string           // 选中后的影响/权衡说明
        }
      ]
    }
  ]
}
```

### update_plan 工具的 JSON Schema 结构

```
{
  "explanation": string,                   // 可选，更新说明
  "plan": [                               // 必填，步骤列表
    {
      "step": string,                     // 步骤描述
      "status": string                    // "pending" | "in_progress" | "completed"
    }
  ]
}
```

### `RequestUserInputArgs`（来自 codex-protocol）

```rust
pub struct RequestUserInputArgs {
    pub questions: Vec<RequestUserInputQuestion>,
}
```

其中 `RequestUserInputQuestion` 包含 `id`、`header`、`question`、`is_other`（bool）、`is_secret`（bool）和可选的 `options: Option<Vec<RequestUserInputQuestionOption>>`。

> 源码位置：`codex-rs/protocol/src/request_user_input.rs:14-34`

---

## 配置项与默认值

### 模式可用性逻辑

`request_user_input` 工具的可用性由两个因素决定（`codex-rs/tools/src/request_user_input_tool.rs:136-139`）：

| 条件 | 说明 |
|------|------|
| `mode.allows_request_user_input()` | `Plan` 模式始终返回 `true`；其他模式返回 `false` |
| `default_mode_request_user_input && mode == ModeKind::Default` | 如果该 feature flag 开启，Default 模式也允许 |

`TUI_VISIBLE_COLLABORATION_MODES` 常量定义了 UI 中可见的模式列表：`[ModeKind::Default, ModeKind::Plan]`。

### update_plan 工具约束

- `plan` 字段为必填，`explanation` 为可选
- 描述中约定**同一时刻最多只有一个步骤处于 `in_progress` 状态**

---

## 边界 Case 与注意事项

- **options 不能为空**：`normalize_request_user_input_args` 会拒绝任何 question 的 options 为 `None` 或空数组的请求，返回明确的错误消息
- **is_other 强制为 true**：无论 Agent 传入什么值，标准化后所有 question 的 `is_other` 都会被设为 `true`，确保客户端总是追加一个"其他"自由输入选项
- **strict: false**：两个工具的 `strict` 均为 `false`，意味着 LLM 不保证严格遵守 schema，系统需在运行时做额外校验
- **描述文本动态生成**：`request_user_input` 的描述包含允许模式列表，会根据 `default_mode_request_user_input` flag 动态变化。`format_allowed_modes` 会根据模式数量选择不同的自然语言格式（单模式用 "X mode"，两个用 "X or Y mode"，更多用逗号分隔）
- **Execute 模式不可用**：`ModeKind::Execute` 不在 `allows_request_user_input()` 的匹配范围内，该模式下调用会收到不可用提示