---
feature: harness-registry
status: delivered
updated: 2026-11-10
source: harness-registry
---

# Harness 目录与调度：ACP 多 harness（检测 / 一键安装 / 三级选择）

## Report

**状态：已交付**（独立评审 partial → 6 MAJOR + MINOR 全部修复 → 复审通过后合入）。证据集：`docs/compose/spec/harness-registry-evidence/`。

### 交付物

- **P1 目录+运行时**：`src/l2/harnesses.json`（10 条内置）+ `src/l2/harness-registry.ts`（loadCatalog 合并用户自定义 / detectOne 版本探活 / resolveHarness 三级解析）+ `src/l2/harness-check.ts`（L1 校验纯函数）+ `apps/l2-desktop/scripts/harness-cli.ts`（detect|install CLI，单一实现复用 registry，无双实现漂移）。
- **P2 桌面面板**：l2-desktop Harness 卡片（检测列表 / 一键安装 / 设为默认单选）+ Rust `harness_detect/install` 命令 + L1 `GET/PUT /harness-settings`（账号默认 user_settings，设备令牌路径 device_defaults）。
- **P3 非 ACP 兜底**：dispatch 层对 `acp:'none'` 明确报错指引 CUA 通道；未知 id 显式报错不再静默降级。
- **三级选择链**（实装语义）：任务级显式 `harness` 参数 > 账号默认（`user_settings.harness`，dispatch 时烤入 `l2_tasks.harness`）> 设备默认（`device.json.harness`，L2 `resolveHarness` 兜底）> dsh。专家级 = `tools_json` `{"id":"acp","options":{"harness":…}}` 的 `run_harness` 子任务默认。

### Acceptance 证据

| 项 | 证据 |
|---|---|
| T1 本机检测 10/10（含版本） | `9-detect-and-resolve.txt`；打包 app 脱离源码树检测同 10/10 |
| T2 双 harness 真跑（dsh/codebuddy） | 早前 E2E 2/2 PASS（claim→真 harness 回话）；`6-deny-allow-terminal.png`：codebuddy 真弹权限请求，deny→`cancelled` 文件未写、allow→写入 `hello` |
| T3 面板/一键安装/设默认 | `1-panel-full-list.png`（11 条列表+版本+单选）、`2-install-click.png`+`3-install-log.png`（点「一键安装」→ install 命令真跑（/tmp 标记生成）→ 日志入面板→自动复检）、`4-set-default-dsh.png`+`5-radio-selected.png`（点 DeepSeek 单选→radio 选中→`device.json.harness=dsh`） |
| T3 设默认→派发生效 | 账号默认烤入 dispatch（index.ts）+ 设备默认 resolve 兜底 + `reportDefaultHarness` 变化重报 L1；resolve 链本机实测（9-detect-and-resolve.txt） |
| T4 dispatch 校验 | `7-dispatch-unknown-harness-sse.txt`：生产 L1 会话 E2E，`harness=dshh` 被拒且 reason 原样回传；`8-harness-settings-e2e.txt`：生产设备令牌 PUT/GET 200、坏格式 400、自定义 id 放行、无鉴权 401 |
| 打包可移植性 | tauri bundle resources（l2-pkg/）+ `package_root` 运行时探测；从 .app 包内 cwd=/tmp 检测 10/10（9-detect-and-resolve.txt） |

### 验证矩阵

- `tsc -p apps/l2-desktop/tsconfig.json --noEmit` 绿（顺手修掉 main 上已存在的 acp-worker/cua-sandbox 三处类型错误）；`tsconfig.ui` 绿。
- `cf:build` 绿；生产部署 Version `9029862f`（`http://localhost:4120`）。
- `cargo check` 绿；`tauri:build` 绿（204.9MB app + 85MB DMG，resources 落位 `Contents/Resources/l2-pkg/`）。
- 单测（tsx 直跑）：checkHarnessId（typo/acp:none/格式）全过；resolveHarness（未知抛错/显式覆盖/设备默认）全过；detectOne（npx 无 zeroInstall 不再恒 installed、启动器版本不冒充）全过。

### 评审修复记录（先修后合）

首轮独立评审 partial，修复项：① 三级链打通 dispatch/claim（含 `loadConfig` 漏返回 harness 的隐性 bug）；② 设备令牌鉴权补 tokenOk 路径；③ dispatch_to_sandbox 补 checkHarness + schema 文案改准；④ bundle resources + package_root 运行时探测，并修打包路径含空格时 `URL.pathname` 百分号编码读不到 harnesses.json 的实弹 bug（改 `fileURLToPath`）；⑤ 未知 id/`acp:'none'` 抛错；⑥ harness.mjs 双实现删除（harness-cli.ts 单实现）。npx 语义改为 `zeroInstall`/`requires`（codebuddy 假 bundledPaths 移除；claude-code/codex 适配器要求本体在位）。

### 已知边界（不阻合入）

- 打包 app 的 claim loop 仍需 node/tsx 源码树（sidecar 架构既有形态，归 AGENTS.md §7.4「L2 PC app 成熟度」backlog）；harness 检测/安装已可脱离源码树。
- mimo ACP 会话无文本输出（allow/deny 差分一致，非本片引入；目录条目保留，待后续跟进）。
- claude-code 适配器需 `claude` CLI 已登录（`Authentication required`），目录 `requires` 判定已如实显示。

## [S1] Problem

L2 要能通过 ACP 调度 PC 上安装的各家 harness（Codex / Claude Code / DeepSeek dsh / 小米 MiMo / 腾讯 WorkBuddy…）。现状 `acpProfile()` 是**单 harness 环境变量配置**（默认 `dsh --profile acp`），无法：自动检测装了哪些、给用户一份 ACP harness 清单、一键安装、让用户选用哪个。调研结论（已实证）：五家全部支持 ACP——dsh 原生、`mimo acp` 原生、WorkBuddy/CodeBuddy `codebuddy --acp` 原生（含 `--acp-transport`）、claude/codex 走 npx 适配器（`@agentclientprotocol/*-acp`）；Mastra `@mastra/acp` 的 `AcpAgent` 是统一插座。本片落地 P1 目录+运行时、P2 桌面面板+安装、P3 非 ACP 兜底。

## [S2] Design

### S2.1 Harness 目录（数据驱动，不写死）

- `src/l2/harnesses.json` 内置清单 + 运行时合并用户自定义（`~/.config/mastra-l2/harnesses.json`）。条目：`{id, name, vendor, acp:'native'|'adapter'|'none', command, args, detectBins?, versionArgs?, install?: {type:'npx'|'brew'|'script'|'manual', cmd, note}, bundledPaths?, zeroInstall?, requires?, homepage}`（`zeroInstall`：npx/node 启动器按需拉包即用；`requires`：适配器之于本体命令的硬依赖）。
- 内置条目（实证启动命令）：`dsh`（`dsh --profile acp`）、`codebuddy`（官方 npx `@tencent-ai/codebuddy-code --acp`；App 捆绑 shim 已实证不可用，lite-wb 变体 ACP 不回话）、`mimo`（`acp` 子命令）、`claude-code`（adapter：`npx -y @agentclientprotocol/claude-agent-acp`，requires claude）、`codex`（adapter：`npx -y @agentclientprotocol/codex-acp`，requires codex）、`gemini`（`--acp`）、`opencode`（`acp`）、`cline`（`--acp`）、`cursor-agent`（`acp`）、`copilot`（`npx @github/copilot --acp`）。
- **检测**（`harness-registry.ts`）：bundledPaths 绝对文件 → `requires`/detectBins PATH → `--version` 探活（只探本体，启动器版本不冒充）→ `{installed, version, path}`。检测是**本机行为**：桌面端跑 `harness-cli.ts detect`。

### S2.2 运行时与选择（三级）

- `acpProfile` 升级为 `resolveHarness(id?)`：目录解析 command/args（兼容旧 env：`ACP_COMMAND` 仍是自定义覆盖通道）；`runAcpPrompt(prompt, runtime, opts?: {harness, extraEnv})` 按 harness 起 `AcpAgent`（persistSession 按 harness 独立）。
- 三级选择（优先级从高到低）：**任务级** dispatch 显式 `harness` 参数（对照内置目录校验，未知/`acp:'none'` 报错）> **账号级** `user_settings.harness`（dispatch 时烤入 `l2_tasks.harness`）> **设备级** `device.json.harness`（L2 `resolveHarness` 兜底）> dsh。**专家级** = `tools_json` 的 `{"id":"acp","options":{"harness":"codebuddy"}}`（与 cua 条目同构，defJson 随任务下发，作 `run_harness` 子任务默认）。
- **权限**：`AcpAgent.onPermissionRequest` 接 permissions 策略快照（随任务下发，同 cua 模式）：`deny` 拒绝该动作、`ask/allow` 审计放行（Grok 语义，不弹窗）。

### S2.3 桌面面板 + 一键安装（P2）

- 桌面端（l2-desktop）新增 **Harness 卡片**：本地检测列表（已装/未装/版本/路径）、**一键安装**按钮（spawn 目录 install.cmd，日志流入面板，装完自动复检）、**设为默认**（写 `device.json.harness`，claim loop 检测变化即 `PUT /harness-settings` 报 L1 存档；设备令牌路径存 `device_defaults`，账号会话路径存 `user_settings`）。
- L1 轻端点：`GET/PUT /harness-settings`（id 格式校验，自定义目录项放行；记录默认选择，供派发参考；检测数据不上云，隐私留本机）。
- npx 零安装类（zeroInstall）= 启动器在位即用（一键=预热拉包），适配器类还需 `requires` 本体在位；原生类给官方安装命令。

### S2.4 非 ACP 兜底（P3）

- 目录条目 `acp:'none'`（如未来收编的纯 GUI 应用）：dispatch 层校验——指定到非 ACP harness 时**明确报错并指引走 CUA 通道**（`dispatch_to_sandbox`/专家 `tools_json` 的 cua 条目已有）；不做隐式转换。

## [S3] Out of Scope

- harness 会话跨任务复用/池化（persistSession 进程生命周期先按任务管理）
- WorkBuddy 的 `streamable-http` 传输（先 stdio）
- 沙箱/云电脑里的 harness 检测（本片只做本机）
- 非 ACP 应用的自动 CUA 驱动（只做指引，不自动转）

## Tasks

- [x] T1: harness-registry（harnesses.json 目录 + 检测 + resolve）— acceptance: 本机真检出 dsh/codebuddy/mimo/claude/codex 等，版本可读 — ✅ 10/10（9-detect-and-resolve.txt）
- [x] T2: runAcpPrompt(harnessId) + 专家/任务 harness 传递 + 权限快照钩子 — acceptance: 同一任务分别用 ≥2 种 harness 真跑通；deny 策略真拒 — ✅ dsh/codebuddy 2/2；deny 真拒 + allow 差分（6-deny-allow-terminal.png）
- [x] T3: 桌面 Harness 卡片 + 一键安装 + 默认选择（L1 /harness-settings 存档）— acceptance: 面板显示检测结果；一键安装真装上一条（cline 3.0.74 真装成功，见面板 ✓；点击链路另有探针 install 命令真跑证据 2/3 号截图）；设默认生效到后续派发 — ✅ 1/2/3/4/5 号截图 + 8 号生产存档 E2E
- [x] T4: dispatch 校验 + 非 ACP 指引 CUA + 双模式 E2E + **截图证据** — acceptance: 非 ACP 条目报错指引正确；端到端跑通并截图入 Report — ✅ 7 号 SSE E2E（未知 id 拒）+ acp:'none' 单测 + 全部截图入 evidence/

## Journey log

- 2026-11-07 spec 起草（调研五家 ACP 启动命令实证；WorkBuddy 三坑：App 捆绑 shim 坏 / lite-wb 不回话 / App 登录不通用 → codebuddy 改官方 npx 路由）。
- 2026-11-10 T1–T3 实现 + T4 部分（双 harness E2E 2/2、cline 一键安装、/harness-settings PUT/GET、cf:build/tauri:build、生产部署 3b73adb9）。
- 2026-11-10 独立评审 partial（6 MAJOR + MINOR）→ 逐项修复（三级链/鉴权/校验/打包可移植/未知 id 抛错/双实现消除；顺带修 main 既有 tsc 错误与 `loadConfig` 漏 harness、打包空格路径实弹 bug）→ 复审。
- 2026-11-10 证据采集：桌面面板/一键安装/设默认截图（System Events 驱动真 UI）、deny/allow 终端差分、生产 /harness-settings 与 dispatch SSE E2E、打包内脱离源码树检测；生产部署 9029862f。Report 定稿。
