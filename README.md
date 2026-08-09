# pi-codex

> 在 [Pi](https://github.com/earendil-works/pi) 中获得和 [OpenAI Codex](https://github.com/openai/codex) 桌面应用一致的 AI 编程体验。

pi-codex 是 Pi 的一个插件包，复刻了 Codex 中核心的两项能力：**Goal 长任务管理**（持久化目标 + 自动续跑 + token预算） 和 **异步 Bash 工具**（后台运行命令不阻塞 agent).

安装后，你的 Pi agent 在执行长任务时拥有 与 Codex 几乎相同的工具集和行为模式，。

* 许愿式开发：打开goal模式，开始许愿，把目标钉在墙上，摸鱼20分钟后回来，啊哈，愿望达成。🌈🌈

* 长命令追踪：在数据分析和训练模型等长命令场景，agent会像人那样隔几分钟看看执行日志并决定继续等待或者杀掉命令调整，而不是一直傻等任务跑完再调整。🤗🤗

---

## 一，功能一览

| 功能 | 对应 Codex 能力 | 说明 |
|------|----------------|------|
| `/goal` 命令族 | `/goal` + goal widget | 目标设定 / 编辑 / 暂停 / 恢复 / 清除，带 token预算 |
| `bash` + `bash_io` 工具 | unified-exec / `write_stdin` | 覆盖内置 bash：短命令直接返回，长命令 2s 后返回 session_id 可轮询/写入/中断 |


---

## 二，快速开始

### 1，安装

```bash
# 从 npm 安装
pi install npm:@lyhue1991/pi-codex

# 从 GitHub 安装
pi install github:lyhue1991/pi-codex

# 本地开发
pi install /path/to/pi-codex
```

验证安装：

```bash
pi list
```

### 2，推荐搭配 pi-web

为了获得完整的 Codex 式 UI 体验（包括 goal 面板、内联编辑、暂停/恢复按钮），推荐同时安装 [lyhue1991/pi-web](https://github.com/lyhue1991/pi-web)：

```bash
# 安装
npm install @lyhue1991/pi-web

# 打开
pi-web
```

pi-web 是 Pi 的 Web 前端，已内置 GoalPanel 组件，支持目标展示、内联编辑、以及运行中途的 pause/resume/clear 操作，类似codex中的体验。

不安装 pi-web 也能用，但只能通过命令行操作 goal。


### 3，使用 Goal

在对话中自然语言直接输入 (方便设置具体token预算)：

```
设一个goal，预算100万token。开发一个黄金矿工html网页游戏。测试确保游戏可玩无BUG。
```

也可以打 /goal 命令输入 (默认不限制token预算)。

```
/goal 开发一个黄金矿工html网页游戏。测试确保游戏可玩无BUG。
```



### 4，使用后台 Shell

`bash` 覆盖了 Pi 内置的同步 bash，成为唯一的 shell 工具。短命令（ls、grep、git status 等）在默认 2 秒内完成，直接返回完整输出；长命令（构建、测试、数据分析、模型训练等）超过 2 秒后返回 `session_id`，agent 会自动用 `bash_io` 每隔几分钟轮询输出、发送输入或 Ctrl-C 中断，无需手动干预。

```
帮我下载并跑通这个torch训练脚本。
https://github.com/lyhue1991/torchkeras/blob/master/kerasmodel_example.py
```


## 三，核心机制

### 1，异步 Shell 架构

```
bash("python train.py", yield_time_ms = 2000)
  └─ spawn 子进程，等待 yield_time_ms（默认 2s）
  └─ 仍在运行 -> 返回 session_id

bash_io(session_id, yield_time_ms = 2000)
  └─ 轮询增量输出
  └─ 进程结束 -> 返回 exit code
```



### 2，Goal 状态机

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

### 3，Steering 注入（mid-run 编辑）

当 agent 正在运行时编辑 goal，新 objective 以 **steering 消息**形式注入队列。agent 在每个 turn 边界轮询 steering 队列，下一次 LLM 请求就会包含更新后的目标 - 在当前 agent run 内生效，无需等待当前 run 结束。

```
turn N: LLM 请求 (旧 objective)
           │
用户编辑 goal -> 注入 steering 消息
           │
turn N+1: 轮询到 steering -> 塞进 context
turn N+1: LLM 请求 (已包含新 objective)  ← 当前 run 内生效
```
