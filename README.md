# pi-codex

> 在 [Pi](https://github.com/earendil-works/pi) 中获得和 [OpenAI Codex](https://github.com/openai/codex) 桌面应用一致的 AI 编程体验。

pi-codex 是 Pi 的一个插件包，复刻了 Codex 中最核心的两项能力：**异步 Shell 工具**（后台运行命令不阻塞 agent）和 **Goal 长任务管理**（持久化目标 + 自动续跑 + token/时间预算）。

安装后，你的 Pi agent 将拥有与 Codex 几乎相同的工具集和行为模式。

---

## 功能一览

| 功能 | 对应 Codex 能力 | 说明 |
|------|----------------|------|
| `bash_bg` + `bash_io` 工具 | unified-exec / `write_stdin` | 后台运行长命令、可轮询输出、可写入 stdin、可中断 |
| `/goal` 命令族 | `/goal` + goal widget | 目标设定 / 编辑 / 暂停 / 恢复 / 清除，带 token 和时间预算 |
| `create_goal` / `get_goal` / `update_goal` 工具 | `create_goal` / `get_goal` / `update_goal` | agent 可编程的 goal 状态机 |
| Steering 注入 | 同 Codex | 运行中途编辑 goal 通过 steering 消息注入，**当前 agent run 内立即生效** |
| 自动续跑 | auto-continuation | agent settled 后若 goal 仍 active 且预算充足，自动开启下一 turn |
| 持久化 | 同 Codex | goal 状态写入 session entry，重启/fork 后自动恢复 |

---

## 快速开始

### 安装

```bash
# 从 GitHub 安装
pi install github:lyhue1991/pi-codex

# 本地开发
pi install /path/to/pi-codex
```

验证安装：

```bash
pi list
```

### 推荐搭配 pi-web

为了获得完整的 Codex 式 UI 体验（包括 goal 面板、内联编辑、暂停/恢复按钮），推荐同时安装 [lyhue1991/pi-web](https://github.com/lyhue1991/pi-web)：

```bash
pi install github:lyhue1991/pi-web
```

pi-web 是 Pi 的 Web 前端，已内置 GoalPanel 组件，支持多行目标展示、内联编辑、以及运行中途的 pause/resume/clear 操作。不安装 pi-web 也能用，但只能通过命令行操作 goal。

### 使用 Goal

在对话中直接输入：

```
/goal 实现用户登录功能，支持邮箱和 OAuth
```

agent 会围绕这个目标持续工作。随时可以：

```
/goal pause       # 暂停自动续跑
/goal resume      # 恢复
/goal edit        # 修改目标内容（运行中途也可，通过 steering 注入立即生效）
/goal clear       # 清除目标
/goal             # 查看当前状态
```

### 使用后台 Shell

agent 会自动选择 `bash_bg` / `bash_io` 来处理长时间运行的命令（构建、测试、dev server 等），无需手动干预。

---

## 核心机制

### Goal 状态机

```
active ──pause──► paused ──resume──► active
  │                                     │
  ├── 预算耗尽 ──► budget_limited       ├── 达成 ──► complete
  ├── 连续 3 轮无进展 ──► blocked       └── 用户清除 ──► (删除)
  └── 用户清除 ──► (删除)
```

- **complete / budget_limited** 为终态，只能 `edit` 重新激活或 `clear` 清除
- **paused / blocked** 可以 `resume` 恢复
- `edit` 会将 `complete` / `budget_limited` 的目标重新拉回 `active`

### Steering 注入（mid-run 编辑）

当 agent 正在运行时编辑 goal，新 objective 以 **steering 消息**形式注入队列。agent 在每个 turn 边界轮询 steering 队列，下一次 LLM 请求就会包含更新后的目标 — 在当前 agent run 内生效，无需等待当前 run 结束。

```
turn N: LLM 请求 (旧 objective)
           │
用户编辑 goal → 注入 steering 消息
           │
turn N+1: 轮询到 steering → 塞进 context
turn N+1: LLM 请求 (已包含新 objective)  ← 当前 run 内生效
```

### 异步 Shell 架构

```
bash_bg("npm run build")
  └─ spawn 子进程，等待 yield_time_ms
  └─ 仍在运行 → 返回 session_id

bash_io(session_id, chars="")
  └─ 轮询增量输出
  └─ 进程结束 → 返回 exit code
```

输出采用 head+tail 滚动缓冲（4 KiB 头部 + 252 KiB 尾部），单进程内存占用有上限。

---

## 对比 Codex

| 方面 | Codex | pi-codex |
|------|-------|----------|
| 后台进程 | PTY (tokio) | pipe (`child_process.spawn`) |
| 输出截断 | HeadTailBuffer (1 MiB) | RollingBuffer (256 KiB) |
| Goal 持久化 | session entries | session entries |
| Mid-run 编辑 | steering 注入 | steering 注入 |
| 自动续跑 | turn 边界 auto-continue | agent_settled 触发新 turn |
| Goal UI 面板 | 桌面端原生 widget | pi-web GoalPanel（多行 + 内联编辑） |

---

## 开发

```bash
npm install
npm run typecheck
npm test
```

测试覆盖 goal 全部操作（28 个用例）。

## 要求

- Pi v0.83.0+
- Node.js 22+

## License

MIT
