# clue

**本地优先、白盒可控、跨 7 大 Harness 通用的 AI 个人记忆与历史会话检索系统。**

[English](./README.md) | 简体中文

---

`clue`（线索）让你电脑上的所有 AI 编程工具——**Antigravity (AGY)**、**Claude Code**、**Codex**、**OMP**、**pi**、**OpenCode**、**Hermes**——共享同一份 Git 留痕的本地个人记忆。

零云端、零常驻 MCP、零向量库、零后台模型费用；除 [Bun](https://bun.sh) 与 `git` 外没有运行依赖。

## 它怎么工作

- **规则归 `AGENTS.md`，记忆归 `clue`。** clue 记的是关于你和你做的事：偏好与习惯、个人事实、项目方向、踩过的坑、拍过的板，以及跨工具的历史原话。
- **先起草，你确认后才写。** 模型在干活时随手把值得记的内容放进「待确认草稿箱」（不生效、不打扰）。你说「收尾」或结束对话时，它把草稿清单给你看；你点头后 `clue apply` 一次性写入，并输出系统生成的回执（commit 号 + 每条改动），说「撤回记忆」即可整批撤回。
- **旧经验是参考基线，不是规定动作。** 踩坑记录把「根因」和「当时解法」分开。新模型用到旧条目时，收尾要逐条表态：仍是最优 → `verify`（记下确认时间）；有更好办法 → `supersede`（替换旧解法，历史保留）。长期没人确认也没人查的条目会在体检时被列出来淘汰。
- **按需读取。** 开场只注入一份冻结快照（名片 + 当前项目意图卡 + 几行目录 + 提醒），详情按需 `clue search`；发消息时本地匹配到高置信的旧坑才递 1~2 行闪回。

| 层 | 文件 | 内容 | 上下文开销 |
| :--- | :--- | :--- | :--- |
| 常驻 | `PROFILE.md` · `PROJECTS.md` · `INTENTS.json` | 个人名片、项目习惯、项目 4 格意图卡（目标方向 / 已定思路 / 明确不做 / 当前停点） | 开场冻结注入，约 2~3k 字 |
| 按需 | `notes.jsonl` · `pitfalls.jsonl` · `decisions.jsonl` | 记忆条目、踩坑（根因 vs 当时解法）、关键决定（前提、推翻条件） | 开场几行目录；`clue search` 查详情 |
| 原文 | `recall.db`（可重建缓存） | 7 大 Harness 原始对话的增量全文索引 | 平时 0；`clue recall` / `clue show` |
| 草稿 | `drafts.jsonl`（不进 git） | 待你确认的改动 | 收尾时列出 |

所有真源都是 git 跟踪的纯文本，`clue undo` 用 `git revert` 撤回，所见即所存。文件默认只读；绕过 clue 的改动会在下次开场报警，`clue restore` 丢弃、`clue accept` 保留。

## 快速上手

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

clue install --all       # 给本机检测到的所有 Harness 接上 clue（改配置前自动备份）
clue index               # 首次建立历史会话索引
clue doctor --adapters   # 检查接入状态
```

`clue install <agy|claude|codex|hermes|omp|pi|opencode>` 可单独接入；加 `--dry-run` 先预览。Hermes 会打印需要你手动加进 `config.yaml` 的几行。升级 clue 后重跑一次 `clue install --all`。

## 常用命令

- **看**：`clue status` · `clue view` · `clue intent` · `clue drafts` · `clue log`
- **查**：`clue search "说法1 | 说法2"` · `clue recall "<词>"` · `clue show <id> --around <序号>`
- **起草**（stdin JSON，不会直接写入）：`clue note` · `clue pitfall` · `clue decision` · `clue intent` · `clue curate`
- **写入与撤回**：`clue apply <编号|all>` · `clue drop <编号|all>` · `clue undo`
- **体检与修复**：`clue dream` · `clue restore` · `clue accept "<原因>"` · `clue doctor`
- **其他**：`clue wrap`（打印收尾清单）· `clue export`（脱敏上下文包，贴给网页版聊天）

`CLUE_ROLE=worker` 会让该进程只读：能看记忆、不能起草或写入，适合分工执行窗格。

## 可选配置（`$CLUE_HOME/clue.config.json`）

```json
{
  "readOnlyGuard": true,
  "autoRecall": true,
  "limits": { "profileChars": 1500, "intentCardChars": 450, "entryChars": 160, "noteChars": 300, "coldDays": 60 },
  "worktreeSuffixes": ["fix", "wt", "worktree", "dev"],
  "workspaceRoots": ["workspace", "projects", "code"],
  "projectWorkflows": [
    {
      "name": "my-handoff",
      "detectFile": "docs/STATUS.md",
      "wrapUpHint": "先更新 {file}，再整理 clue 草稿。",
      "intentSkipSlots": ["checkpoint"]
    }
  ]
}
```

`projectWorkflows` 让带有特定文件的项目在开工/收尾时多一条提示；`intentSkipSlots` 表示这些意图卡槽位由项目自己的文件维护，clue 不写。

## 从 v0.5 升级

第一次运行时自动迁移：`pitfalls.db` 不再进 git（jsonl 成为唯一真源），命中统计移到 `stats.json`，迁移单独提交一次。然后重跑 `clue install --all` 去掉旧的 `hook guard` 钩子。

## 开发

```bash
bun run typecheck
bun test
```

## 开源协议

[MIT](./LICENSE)
