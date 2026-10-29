# ChatGPT Web Skill

[![Windows CI](https://github.com/WhatYearIsNow/chatgpt-web-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/WhatYearIsNow/chatgpt-web-skill/actions/workflows/ci.yml)

仓库：[`WhatYearIsNow/chatgpt-web-skill`](https://github.com/WhatYearIsNow/chatgpt-web-skill) · Skill 名：`chatgpt-web`

可作为 agent skill 或独立 CLI 使用的 ChatGPT 网页自动化工具。支持纯文本、ZIP 附件审查、已有会话续问、参考图生图、本地用量记录，以及显式邮箱验证的 SSO 切号。

**v0.3.0 正式版，MIT，零第三方运行依赖。** 需要 Node.js 22.15+。未配置端点时自动启动隔离的托管浏览器（登录一次即持久复用）；也可显式指定已有 CDP 端点。它操作网页 UI，不是官方 API 客户端；UI、语言和账号功能变化可能需要更新选择器。

**当前验收状态（2026-10-25）：** Windows 本地与 GitHub Actions 的 Node 22/24 全部测试通过（含隔离真实 Chrome 集成）。邮箱 SSO、Google 已有登录、账号恢复、完整单图生成保存与托管浏览器生命周期已通过真实验收。完整范围见 [测试记录](docs/testing.md)。

## 安装

克隆或下载源码并在项目目录运行；运行命令不需要第三方依赖。维护源码时用 `npm ci --ignore-scripts` 安装锁定的开发格式工具。
也可从 [Releases](https://github.com/WhatYearIsNow/chatgpt-web-skill/releases) 下载 source.zip，按附带的 `SHA256SUMS` 核对文件；解压得到 `chatgpt-web/` 目录。

```sh
git clone https://github.com/WhatYearIsNow/chatgpt-web-skill.git
cd chatgpt-web-skill
```

作为 skill 使用时，将整个目录放入 agent 的技能目录并命名为 `chatgpt-web`；入口是 [SKILL.md](SKILL.md)。

## 浏览器：零配置从无到有（推荐）

**不需要手动准备浏览器。** 未配置任何 CDP 端点时，第一条命令会自动完成：

1. 找一个本机 Chromium 系浏览器（Chrome → Chromium → Edge → Brave，Linux 另查 PATH；可用 `CHATGPT_WEB_CHROME` 或 config.json `chromePath` 指定）。
2. 在**私有数据目录**下创建一个全新的隔离 profile（Windows 为 `%LOCALAPPDATA%\chatgpt-web\browser`，可用 `CHATGPT_WEB_DATA_DIR` 改位置），以动态调试端口启动它。你的日常浏览器、日常 profile 完全不被触碰——绝不读取、复制或修改。
3. 打开 chatgpt.com。**首次运行会报 `LOGIN_REQUIRED`**：在这个窗口里手动登录一次你的 ChatGPT 账号即可。

**这个浏览器就是之后所有命令复用的浏览器**：登录态持久保存在上面的托管 profile 里，之后每次运行自动连回同一个窗口，不会再次登录。可用 `browser` 子命令管理它：

```sh
node scripts/chatgpt-web.mjs browser status   # 免锁只读体检：可执行文件/是否在跑/端点
node scripts/chatgpt-web.mjs browser start    # 启动或复用托管浏览器（--headless 可选；无显示器环境用）
node scripts/chatgpt-web.mjs browser login    # 打开 chatgpt.com 并等你完成一次登录（--timeout 秒，默认 300）
node scripts/chatgpt-web.mjs browser stop     # 优雅关闭（冲刷 cookie）；下次命令会重新拉起
```

首跑推荐顺序：`browser start`（或直接跑任意命令）→ 在弹出的窗口登录一次（或用 `browser login` 等待）→ 之后全自动。机器上没有任何 Chromium 系浏览器时安装一个，或用 `CHATGPT_WEB_CHROME` 指向现有可执行文件。

## 高级：使用已有浏览器端点

不想用托管浏览器、要复用其他已登录的浏览器时，显式配置端点——**显式端点永远优先，配置了端点就绝不会启动托管浏览器**：

```powershell
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:LOCALAPPDATA 'chatgpt-web-browser'
& $chrome '--remote-debugging-port=9222' "--user-data-dir=$profile"
$env:CHATGPT_WEB_CDP_URL = 'http://127.0.0.1:9222'
node scripts/chatgpt-web.mjs ask --prompt '只回复：收到'
```

Linux 可用 `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.local/share/chatgpt-web-browser"`；macOS 使用 Chrome 应用的可执行路径与新的 profile 目录。
Chrome 136 起，默认浏览器数据目录不再支持旧式调试端口参数，需要非默认目录；参见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。不要复制现有 profile。

工具只连接 loopback HTTP/WS 端点。已有可信中继可直接配置 WebSocket 地址，例如 `CHATGPT_WEB_CDP_URL=ws://127.0.0.1:9333`；纯 WebSocket 中继与 Chrome 调试开关模式（`chrome://inspect/#remote-debugging`）没有 `/json/version` 页面，必须用 `ws://` 形态直连。
若已有自己的浏览器连接库，可显式指定 `CHATGPT_WEB_BROWSER_MODULE`，详见 [架构和适配器接口](docs/architecture.md)。
`.env.example` 只是变量示例；CLI 不自动加载 `.env`。也可在私有运行数据目录的 `config.json` 持久保存 `endpoint`、`browserModule`、`chromePath`、`headless` 或 `managed`（设为 `false` 关闭托管启动，恢复"未配置即报错"）；显式连接参数或环境变量优先，见 [迁移说明](docs/migration.md)。

## 命令

```sh
node scripts/chatgpt-web.mjs browser status
node scripts/chatgpt-web.mjs ask --prompt-file question.txt --out answer.md
node scripts/chatgpt-web.mjs review --zip source.zip --prompt-file review.txt --out report.md
node scripts/chatgpt-web.mjs followup --url https://chatgpt.com/c/CONVERSATION-ID --prompt "补充说明第三点" --out reply.md
node scripts/chatgpt-web.mjs image --prompt-file image.txt --ref reference.jpg --out image.png
node scripts/chatgpt-web.mjs image --prompt-file image.txt --out candidate.webp --candidates 2
node scripts/chatgpt-web.mjs quota --today
node scripts/chatgpt-web.mjs quota --tail 20
node scripts/chatgpt-web.mjs account --email user@example.com --provider google --keep-open
node scripts/chatgpt-web.mjs account --google --keep-open
```

每条命令有 `--help`。`scripts/ask.mjs`、`review.mjs`、`followup.mjs`、`image.mjs`、`quota.mjs`、`account.mjs`、`browser.mjs` 是同一实现的兼容入口。

| 参数 | 含义 |
| --- | --- |
| `--prompt` / `--prompt-file` | 二选一，不能为空 |
| `--out` | 文本可选；review/followup 默认生成文件；image 必填 |
| `--timeout` | 回复完成与正文稳定回收共用的等待秒数（账号命令用于切号流程），不包含前置连接、上传或锁等待 |
| `--lock-timeout` | 等待本机任务互斥锁的秒数，默认 600 |
| `--dry-run` | 准备真实网页但不发送；附件/参考图会上传；account 不切号 |
| `--keep-open` / `--keep-tab` | 保留本任务标签页，便于检查与人工接手 |
| `--account` | 显示名片段检查；quota 的 account 使用事件记录里的完整标签 |
| `--think` | 打开网页中可见的 Think 开关 |
| `--ref` | 可重复指定参考图，上传后逐个检查芯片 |
| `--candidates` | 1–20，独立候选按文件名加序号；失败后不继续发送 |

JSON 结果的 `outputs` 数组包含输出路径或正文。部分失败也会保留已完成输出。
网页偶尔为新对话返回浏览器本地的临时会话 URL；工具会以 `CONVERSATION_TRANSIENT` 提示它可能不能重开。需要继续新会话时可用 `--keep-open`，待网页给出持久会话地址后再续问。已有会话加载中跳走会明确报错，避免发到另一会话。
诊断写 stderr；`--help`/`--version` 输出文本。退出码：0 成功，1 执行失败，2 参数/输入错误，3 限额，4 发送状态不明。

发送状态不明时先查看会话，勿自动重试。所有命令只操作自己创建的页，且不会清除已有草稿。
文本回收需要约 15 秒正文稳定窗；设置过短的 timeout 会明确失败，不会跳过稳定检查。清理另有独立的有界等待。
切号会改变该浏览器 profile 的共享登录状态；邮箱 SSO 要求精确邮箱，`--google` 可使用已有 Google 登录并报告实际邮箱。目标邮箱已是当前账号时返回 `changed:false, verified:true`，不触发登出，可作为批量任务前的安全身份断言。遇到密码、验证码、注册或人机检查时停止，详见 [切号说明](docs/account.md)。

## 批量任务模板

批量生图等循环任务先跑通单张冒烟（例如 `ask --prompt "只回复：收到"`），确认端点与账号可用。**循环中不要丢弃 stderr**：诊断与进度只写 stderr，用 `2>/dev/null` 之类丢弃后，失败容易被误判为完成。每个条目核对退出码与 JSON 回执的 `ok`，非零退出码立即停止循环——限额（退出码 3）按 [切号说明](docs/account.md) 处理后重跑同一循环即可续作；发送状态不明（退出码 4）先人工检查会话；都不自动重试或换号。

```sh
mkdir -p gen
for f in prompts/*.txt; do
  name=$(basename "$f" .txt)
  out="gen/$name.png"
  [ -f "$out" ] && continue    # 重跑时跳过已完成
  CHATGPT_WEB_CDP_URL="ws://127.0.0.1:9333" \
  node scripts/chatgpt-web.mjs image --prompt-file "$f" --out "$out" \
    > "gen/$name.json" || { echo "stopped at $name (exit $?)"; break; }
done
```

stdout 回执逐张存档便于核对。示例端点是本机中继的 `ws://` 形态，按实际端点调整；`http://` 形态要求对端提供 `/json/version`。`--candidates N` 在一次命令内生成 N 张独立候选，不需要外层循环。

## 数据、测试与贡献

运行记录默认在平台用户数据目录，可用 `CHATGPT_WEB_DATA_DIR` 覆盖。没有账号清单、cookie、密码或硬编码用量基线随包分发。
本地台账只表示已观察到的事件，不是服务端余额。锁限同一主机；不同锁协议版本不能混跑。

```sh
npm run check
npm test
npm run test:coverage
```

配置 `CHATGPT_WEB_TEST_CHROME` 为本地 Chrome 可执行文件后，测试会额外运行真实浏览器与本机 HTML 夹具；不配置时明确跳过该集成测试。
[测试范围与验收结果](docs/testing.md) 区分离线测试、本地浏览器测试和真实站点验证，未实测的平台不宣称通过。

参阅 [重构方案](docs/refactor-plan.md)、[贡献规范](CONTRIBUTING.md)、[问题报告与隐私](SECURITY.md) 和 [迁移说明](docs/migration.md)。项目以 [MIT](LICENSE) 许可分发。

开发、测试、候选构建和回退约定见[维护流程](MAINTENANCE.md)。
