# AGENTS.md — TUI Agent Project (paw)

> 本文件是 AI Agent 的稳定入口，定义项目边界与验证方式。README.md 保留使用说明，本文件不重复。

## 项目定位

基于 OpenTUI（Zig 渲染核心 + Bun + React）构建的终端 AI Agent 应用。
核心原则：**Agent 编排逻辑与 UI 渲染完全解耦**，两者只通过事件通信，互不感知内部实现。

## 常用命令

```
bun install                     # 安装依赖
bun run dev                     # 启动 TUI（src/main.tsx）
bun run start                   # 同 dev，生产环境入口
bunx tsc --noEmit                # 类型检查（不产出文件）
bun add <package>                # 新增依赖
```

当前无自动化测试，验证以「本地跑起来 + 类型检查通过」为最低标准。

## 技术栈版本

| 组件 | 版本 / 备注 |
|---|---|
| Bun | >= 1.3.14（首选运行时：`bun install` / `bun run`） |
| TypeScript | ^5.9 |
| React | ^19.2.7 |
| @opentui/core | ^0.4.3 |
| @opentui/react | ^0.4.3 |
| bun-types | 推荐（用于 Bun 类型提示） |
| 测试 | 使用内置 `bun test` |
| 工具（可选） | `eslint`（推荐 ^8），`prettier`（推荐 ^2） |

## Spec-First 工作流（中/高风险变更适用）

铁律：涉及 Agent-UI 通信协议、渲染框架、外部服务集成的中/高风险改动，必须先完成 Spec 确认，不得跳过直接写代码。低风险（纯样式、文案、新增展示组件）可直接改。

六步：需求 → 讨论(不写代码) → Spec(draft) → approved → Task → 执行+验证

> **AI Agent 强制行为约束**
> 1. 收到任何需求，第一步必须做风险评级（低/中/高），并明确告知用户。
> 2. 中/高风险：必须先起草 Spec 文档（docs/specs/），等用户将状态改为 approved 后，才能拆 Task；Task confirmed 后才能写代码。
> 3. 讨论阶段（Step 1）只做澄清，不得输出实现方案、改动计划或代码片段。
> 4. 低风险：可省略 Spec，但仍须先说明风险级别，再动手。
> 5. 违反以上任一条，均视为跳过流程，需重新从当前步骤开始。

### 文档目录

```
docs/
├── specs/       # 功能规格（需求确认后）
├── tasks/       # 开发任务拆解（Spec approved 后）
└── decisions/   # 架构决策（可选，高风险变更必填）
```

### 命名规范

```
Spec:     docs/specs/<序号>-YYYYMMDD-<模块>-<功能>.md   示例：docs/specs/1-20260709-agent-stream-cancel.md
Task:     docs/tasks/<序号>-YYYYMMDD-<模块>-<功能>.md
Decision: docs/decisions/<序号>-YYYYMMDD-<主题>.md
```

`<模块>` 用 `agent` / `ui` / `config`；`<功能>` 用 kebab-case，不超过 5 个单词。
`<序号>` 从 1 开始递增。

### Spec 模板（必填节）

```
状态 | 日期 | 风险级别
背景 / 目标 / 范围（包含与不包含）
技术方案（涉及的 AgentEvent 类型、组件、config 项）
验收标准（checkbox 列表）
验证方式（bun run dev 手动验证 / tsc 检查）
回滚策略
```

### Task 模板（必填节）

```
关联 Spec | 状态
任务清单（含改动文件与预期结果）
Agent Prompt（复制即用，引用 Spec + Task 路径）
完成记录（任务 / 状态 / 验证结果）
```

## 风险分级

| 级别 | 场景 | Agent 策略 |
|------|------|------------|
| 低 | UI 样式调整、文案、新增纯展示组件 | 直接改 + `bun run dev` 验证 |
| 中 | 新增工具、新增 AgentEvent 类型、修改 main.tsx 入口逻辑 | Spec → Task → 执行 |
| 高 | 更换渲染框架、修改 Agent-UI 通信协议、引入外部服务鉴权 | Spec + Decision → Task → 确认后执行 |

## 验证清单

```
bun install
bun run dev          # 手动验证 TUI 能启动、交互无报错
bunx tsc --noEmit    # 类型检查
```
