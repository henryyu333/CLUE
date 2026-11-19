# clue

**本地优先、硬上限防膨胀、防锚定、跨 7 大 Harness 通用的 AI 个人记忆与历史会话检索系统。**

[English](./README.md) | 简体中文

---

`clue`（线索）让你在电脑上使用的所有 AI 编程工具——**Antigravity (AGY)**、**Claude Code**、**Codex**、**OMP**、**pi**、**OpenCode**、**Hermes**——共享同一份极简、Git 留痕的本地个人记忆与历史对话召回底座。

零云端服务、零常驻 MCP 负担、零重型向量数据库、除 [Bun](https://bun.sh) 外零外部运行依赖。

## 为什么做 `clue`？

两项近期研究点破了当下 Agent 记忆系统的核心痛点：

1. **重型记忆框架常常不如直接搜原始历史**（*[Memory Tax](https://arxiv.org/abs/2610.34073)*）：让模型反复摘要、重构记忆会交三笔“记忆税”——信息失真、换词搜不到、以及**跨模型脆皮**（用模型 A 整理的复杂记忆，换模型 B 读效果大跌）。
2. **开局预加载必须极薄，记错一条比没记更危险**（*[The Components of Agent Memory](https://www.anthropic.com/research/components-of-agent-memory)*）：指令越长模型越不听话；而未经验证的过时笔记会把后续会话牢牢锚定在错误路径上。

`clue` 直接围绕这些实证结论设计，只留四层最薄、最稳的结构：

| 层级 | 文件 | 职责 | 上下文开销 |
| :--- | :--- | :--- | :--- |
| **热层薄页** | `PROFILE.md` + `PROJECTS.md` | 你是谁、怎么跟你协作 + 全局习惯 + **仅当前项目块**（自动把 worktree 归一到主项目） | 极薄且整场冻结（`≤1500` + `≤900` 字），不破 Prompt Cache |
| **冷层错题本** | `pitfalls.db` + `pitfalls.jsonl` | 防锚定踩坑库：强制拆分 `root_cause`（客观根因）与 `historical_fix`（历史解法仅供参考），附 `rethink_hint` 与 `evidence` 溯源锚点 | 平时 **0 Token**，排障按需 `clue search` |
| **原话召回** | `recall.db` *(可随时重建缓存)* | 跨 7 大 Harness 原始对话增量 SQLite FTS5 索引（含 Codex `.jsonl.zst` 解压） | 平时 **0 Token**，翻旧账按需 `clue recall` / `clue show --around` |
| **安检与审计** | 本地 `.git` + Hook 门禁 | 硬字数上限、凭据/注入扫描、行级锁、跨进程文件锁、自动 Git 提交与 `clue undo` | **0 Token** |

## 核心特性

- **代码级硬安检，不靠模型自觉**：单条 ≤ 160 字且禁止换行、固定分区、整页字数硬封顶。超标原子拒收，逼模型合并或淘汰旧条目，永远保持薄薄一页。
- **日常静默只读 + 统一草稿确认制**：平时干活绝不后台黑箱偷写；收尾或日常结束时，模型先出简短草稿给你过目，点头确认后再调用 `clue curate` / `clue pitfall` 落盘。
- **防锚定错题本 + 可溯源 `evidence`**：只信客观根因、历史解法仅供参考；带上 commit / 文件路径 / 会话 ID 锚点，更新更强的模型可直接核对一手真相并用 `supersede` 演进替换旧方案。
- **跨 7 工具零记忆税原话召回（`clue recall`）**：统一增量索引 **AGY、Claude Code、Codex（原生支持 `.jsonl.zst`）、OMP、pi、OpenCode、Hermes** 历史对话；自动脱敏密钥为 `[REDACTED]`、降权子代理与定时任务噪音、单条展开硬截断防撑爆上下文。
- **本地 0 费用健康信号灯 + `clue dream` 深度整理**：本地免费监控水位（`≥80%`）、间隔天数、写入次数与疑似重复项；平时安静隐身，亮黄灯时轻声提醒运行 `clue dream`，对照近期原话完成纠偏、合并与冷热升降级。
- **安全与并发防护**：写入前自动拦截 API Key / Token / 私钥 / Prompt 注入；跨进程文件锁 + 原子替换写入；`PreToolUse` 钩子拦住模型直接改文件；所有写入自动 Git commit，一条 `clue undo` 秒回滚。

## 快速上手

### 1. 克隆并安装 `clue` 命令

依赖：[Bun](https://bun.sh) `>= 1.2.0` 与 `git`。

```bash
git clone https://github.com/henryyu333/CLUE.git ~/workspace/clue
mkdir -p ~/.local/bin
cat <<'EOF' > ~/.local/bin/clue
#!/bin/sh
set -eu
BUN="$(command -v bun 2>/dev/null || echo /opt/homebrew/bin/bun)"
export CLUE_HOME="${CLUE_HOME:-$HOME/.clue}"
if [ "${1:-}" = "hook" ]; then
  "$BUN" "$HOME/workspace/clue/src/cli.ts" "$@" || printf '{}\n'
  exit 0
fi
exec "$BUN" "$HOME/workspace/clue/src/cli.ts" "$@"
EOF
chmod +x ~/.local/bin/clue
```

### 2. 初始化与建立跨工具索引

```bash
clue doctor      # 检查并初始化 $CLUE_HOME（Markdown + SQLite + Git）
clue status      # 查看水位、健康度与近期踩坑（纯本地 0 Token）
clue index       # 增量索引本机已装 Harness 的历史原始会话
clue sources     # 查看各 Harness 已收录的会话与消息数
```

### 3. 一键接入你的 Harness（绝不污染 `AGENTS.md`）

```bash
clue install agy      # 安装 AGY 原生本地插件（~/.gemini/config/plugins/clue/）
clue install claude   # 自动备份并合并 Claude Code Hooks + Skill
clue install codex    # 自动备份并合并 Codex Hook + Skill
clue install hermes   # 安装 Skill 并输出 config.yaml 接入配置
```

加 `--dry-run` 可先预览改动不落盘。OMP / pi / OpenCode 可通过极薄的扩展直接复用 `src/core/index.ts` 或调用 `clue`。

## 常用命令速查

- **本地巡检与兜底**：`clue status` · `clue view` · `clue log` · `clue undo` · `clue doctor`
- **踩坑与原话检索**：`clue search "<关键词>"` · `clue recall "<关键词>"` · `clue show <id前缀> --around <序号>`
- **整理与维护**：`clue dream` · `clue dream --mark-done` · `clue curate`（stdin JSON）· `clue pitfall`（stdin JSON）

## 私有扩展配置（`$CLUE_HOME/clue.config.json`）

字数上限、自定义分区以及团队/个人项目交班联动规则均可放在私有数据目录的 `clue.config.json` 中，不污染源码仓库（配置示例见 [README.md](./README.md)）。

## 开发与测试

```bash
bun test
```

## 开源协议

[MIT](./LICENSE)
