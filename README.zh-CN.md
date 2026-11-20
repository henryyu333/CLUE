# clue

**本地优先、防漂移、防锚定、跨 7 大 Harness 通用的 AI 个人记忆与历史会话检索系统。**

[English](./README.md) | 简体中文

---

`clue`（线索）让你在电脑上使用的所有 AI 编程工具——**Antigravity (AGY)**、**Claude Code**、**Codex**、**OMP**、**pi**、**OpenCode**、**Hermes**——共享同一份极简、Git 留痕的本地个人记忆底座。

零云端黑箱、零常驻 MCP 负担、零重型向量库、零额外后台模型费用、除 [Bun](https://bun.sh) 外零外部运行依赖。

## 为什么做 `clue`？

1. **把“规则”还给 `AGENTS.md`，让 `clue` 专注做真正的“活记忆”**：记下你的本地环境与判断眼光、每个项目当下的 **4 格意图卡**、拍过的**关键决定**、踩过的**客观坑点**，以及跨 7 个工具的真实历史原话。
2. **用固定槽位和隐形护栏防漂移**：无论强模型还是弱模型，更新项目意图只需按固定槽位局部填空，不改写未变动内容；平时 10 毫秒纯本地精准闪回，不再赌 AI 自己记不记得去搜。

| 抽屉 | 文件 | 职责 | 上下文开销 |
| :--- | :--- | :--- | :--- |
| **背景与 4 格意图卡** | `PROFILE.md` + `INTENTS.json` | 你的本地环境与眼光名片 + 当前项目的 **4 格意图卡**（目标方向 / 已定思路 / 明确不做 / 当前停点）+ 未收尾跨工具对话自动兜底 | 极薄且整场冻结（约 `1000` 字），不破 Prompt Cache |
| **踩坑与关键决定** | `pitfalls.db` + `pitfalls.jsonl` + `decisions.jsonl` | 防锚定 Bug 根因库 + 关键决定库（含前提、推翻条件与溯源），附本地命中统计 | 开场仅 1 行目录；详情按需 `clue search` 或 10ms 自动闪回 |
| **全历史原话库** | `recall.db` *(可随时重建缓存)* | 跨 7 大 Harness 原始对话真增量 SQLite FTS5 索引（含 Codex `.jsonl.zst` 解压） | 平时 **0 Token**，按需 `clue recall` / `clue show --around` |
| **隐形防漂移地基** | `.git` + OS 只读 `0444` + 哨兵 | 核心文件默认只读防任意工具偷改、Git 脏改哨兵、强制原文行级锁、`[pin]` 锁钉、密钥安检与 `clue undo` | **0 Token** |

## 核心特性

- **项目 4 格意图卡（`clue intent`）**：固定 4 格（目标方向 / 已定思路 / 明确不做 / 当前停点，总计 ≤ 450 字），支持局部单格更新，未动槽位原样保留；昨天强模型定下的设计，第二天换弱模型做调研也能一睁眼就懂。
- **10 毫秒纯本地主动闪回**：发消息时本地 `<15ms` 极速比对踩坑与决定库，短句与未高置信命中时彻底闭嘴（0 字打扰），精准撞上时悄悄递 1~2 行小纸条，同一场对话绝不复读。
- **自然收尾分级落盘 + 透明回执**：自然说“收尾 / OK 没事了”时，低风险项（刷新意图卡槽位、新增坑/决定）一轮安全落盘并在末尾亮出 3~5 行清晰变更回执（附 commit 号，支持秒撤）；修改核心名片或 `[pin]` 条目则强制先出对比草稿等你点头。
- **防锚定踩坑与决定库（`clue pitfall` / `clue decision`）**：客观根因/原因与历史解法分离，记录推翻条件、溯源锚点与命中次数。
- **OS 级只读护栏 + Git 篡改哨兵**：所有核心文本文件默认只读（`0444`），`clue` 写入时毫秒级解锁写完立刻锁回，一次管住全部 7 个工具；`clue doctor --adapters` 一键巡检 7 工具接入状态。
- **防腐烂体检（`clue dream`）与网页端导出（`clue export`）**：自动检查 `evidence` 对应的源码文件和 Git 提交是否还存活，列出长期 0 命中冷门条目；`clue export` 一键导出脱敏后的紧凑上下文包，直接贴给网页版 Gemini / ChatGPT。

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

### 2. 巡检与建立跨工具索引

```bash
clue doctor --adapters  # 初始化 $CLUE_HOME 并巡检全部 7 大 Harness 接入状态
clue status             # 查看意图卡、关键决定、踩坑、累计闪回命中次数与版本记录
clue index              # 真增量索引本机已装 Harness 的历史原始会话
clue sources            # 查看各 Harness 已收录的会话与消息数
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

- **查看与巡检**：`clue status` · `clue view` · `clue intent` · `clue doctor --adapters` · `clue log` · `clue undo`
- **检索与闪回**：`clue search "<关键词>"` · `clue recall "<关键词>"` · `clue show <id前缀> --around <序号>`
- **沉淀与维护**：`clue intent`（stdin JSON）· `clue decision`（stdin JSON）· `clue pitfall`（stdin JSON）· `clue curate`（stdin JSON）
- **体检、锁与导出**：`clue dream` · `clue export` · `clue lock` / `clue unlock`

## 开发与测试

```bash
bun run typecheck
bun test
```

## 开源协议

[MIT](./LICENSE)
