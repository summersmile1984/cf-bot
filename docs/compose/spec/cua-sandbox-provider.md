---
feature: cua-sandbox-provider
status: delivered
updated: 2026-11-06
source: cua-sandbox-provider
---

# CuaSandbox：Mastra Sandbox Provider（host 直控 / cua Space VM 双模式）+ 桌面端打包

## Report

**What was built** — `CuaSandbox`（`src/l2/cua-sandbox.ts`）实现 `@mastra/core/workspace` 1.81 的 `WorkspaceSandbox`+`SandboxComputer`：host 模式直控本机（专用机）、vm 模式 get-or-create cua Space（`--name` 与 spaceId 对齐，find/connect/create 原语），VM 镜像默认与 host OS 同族（Mac Studio → `ghcr.io/trycua/macos:26-slim`）。computer 10 方法/executeCommand（双调用形态安全引号）/setEnv（接 secrets-inject）/streamUrl（cua viewer 深链）/suspend-resume-destroy 全接通。专家装配：`tools_json` 带 `{"id":"cua"}` 即挂 Workspace 工具面；权限快照随任务下发，顶层 `beforeToolCall` 钩子按工具名分发（deny→`{proceed:false}` 真拦、ask→审计放行）。桌面端 Tauri sidecar 打包 cua（198MB arm64，`externalBin`+`CUA_BIN` 绝对路径注入，无 sidecar 回退系统 cua）。

**Verification** — `npm run cf:build` PASS；`tauri:build` PASS（app 205MB 含 sidecar / DMG 85MB）。T5 vm 产品链路 E2E **12/12 PASS**（生产 L1→dispatch→专家 workspace→macOS VM `sw_vers=26.5.2`→回流；policies 快照非空验证）；host 产品链路 PASS（本机 `alex-mac.local` 真执行，T5-E2E-HOST-OK）。deny 钩子活体验证 PASS（`denied by policy (computer_click)`）；`--name` get-or-create PASS（`outcome:'created'`→exec→destroy）。效果证据：macOS VM 桌面截图+四帧录屏（开终端/打字/执行）+专家驱动 `EXPERT-WAS-HERE-MAC`。独立评审 2 CRITICAL+2 MAJOR 全修复并复审 PASS。**环境限制**：host 模式 GUI（截图/点击）需 macOS TCC 屏幕录制授权（用户侧待授）；host 端到端已用 shell 通道证毕。

## [S1] Problem

L2 专家的 CUA 能力目前是独立 kind（`runCuaTask` 脚本式 MVP），不是 Mastra Agent 的工具面。Mastra 文档的正解是 **WorkspaceSandbox + SandboxComputer provider**：实现了 `computer` 能力接口，workspace 就自动注册 `mastra_workspace_computer_*` 工具（逐工具 `requireApproval` / `screenshotAfterAction`），并带沙箱生命周期管理。用户定调：**PC 上不用 LocalSandbox**；**cua 打包进桌面端安装包**；CUA 双模式——专用机直接控制 host、日常机起 VM（cua Space）而 host 归用户。Mastra 无 trycua 官方集成，但 sandbox provider 是开放接口——本片把 cua 包成 provider。

## [S2] Design

### S2.1 CuaSandbox provider（核心契约，对齐 `@mastra/core/workspace` 1.81 类型）

`src/l2/cua-sandbox.ts`（desktop 与 pull-worker 共用）实现 `WorkspaceSandbox` + `SandboxComputer`：

| 接口 | cua 实现 |
|---|---|
| `screenshot()` | `do screenshot --save <tmp>.png` 读回 → `{data: Uint8Array, mediaType:'image/png'}` |
| `leftClick/rightClick/doubleClick/moveMouse/drag/scroll/type/press` | `do click/right-click/double-click/move/drag/scroll/type/key`（`press(['ctrl','s'])` → hotkey） |
| `getScreenSize()/getCursorPosition()` | `do` 同名 |
| `streamUrl()` | vm：cua Space viewer/stream 端点；host：null |
| `executeCommand(cmd, args, {env,cwd,timeout})` | `do shell -- '/bin/bash -lc …'` 单命令串（引号语义沿用已修实现）；env 并入 setEnv 环境 |
| `filesystem`（read/write/list） | **未实现**（递延）：workspace 自动回退 `executeCommand`（文档原生支持），file API 后补 |
| `setEnv/getEnv` | 运行时 env 合并进每次命令；**接 secrets-inject 物化 env**（vault 管道复用） |
| `start/stop/destroy` | host：探测 cua-spacesd+权限 → `{outcome:'connected'}`；vm：按 `spaceId` get-or-create cua Space（find/connect/create 原语，`created`/`connected` 语义对齐接口） |
| `getInstructions()/getInfo()` | 模式说明注入系统消息；状态/资源信息 |

- 构造：`new CuaSandbox({ mode: 'host'|'vm', spaceId?, bin?, workingDirectory?, env?, onStart? })`。`bin` 默认解析顺序：桌面端 sidecar 绝对路径 → `CUA_BIN` → PATH。
- 秘钥：`env` 构造参数 + `setEnv` 接 `materializeSecrets` 产物（env + 0600 文件双通道语义不变）。

### S2.2 桌面端打包（Tauri sidecar）

- `apps/l2-desktop`：`tauri.conf.json` `bundle.externalBin: ["bin/cua"]`，打包 cua CLI 本体；调用一律绝对路径。
- **VM 镜像不进安装包**（GB 级）：vm 模式首次使用按需拉镜像（cua 镜像目录）或用云 Space；`cua-spacesd` 视体积决定是否同捆（不超 ~30MB 则捆）。
- macOS：sidecar 随 app 同签名/公证；app 统一引导 Screen Recording / Accessibility 授权（host 模式）。
- 无 sidecar 的部署形态（pull-worker/裸 Node）：退回系统 `cua`（现状 `resolveCuaBin`），行为一致。

### S2.3 专家装配 + HITL

- JIT 工厂（`buildL2Agent`）：`tools_json` 条目 `{"id":"cua","options":{"mode":"vm"|"host"}}`（或 `"computer"`）触发挂载 `workspace: new Workspace({ sandbox: new CuaSandbox(...), tools: {...} })`——cua 从独立 kind 收敛为专家工具面（旧 kind 路由保留兼容）。
- HITL：workspace 工具配置 `requireApproval` 钩子接 **permissions 策略快照**（派发时从 `user_permission_rules` 取 `computer_*`/`execute` 类策略随任务下发）：`deny` 拒绝；`allow` 放行；`ask` 首期放行但写审计行（弹窗式审批路由递延，已知安全债）。钩子日志只记操作类型/坐标，不记截图内容。

### S2.4 模式选择

- 设备级：`~/.config/mastra-l2/device.json` 新增 `cuaMode: 'host' | 'vm' | 'auto'`（默认 `vm`；`auto` = 有 VM 能力用 vm 否则 host）。
- 任务/专家级覆盖：`tools_json` 条目 options.mode 优先于设备配置。专用机场景用户把设备配成 `host` 即可。
- **VM 镜像必须与 host OS 一致**（用户定调）：macOS host → `ghcr.io/trycua/macos:26-slim|26`（lume/vz 运行时）；Windows host → `windows:2022`；Linux host → `linux:24.04*`。镜像 ref 可用 `options.image` / `CUA_IMAGE` 覆盖，但默认走 host 同族——保证 agent 操作的环境与用户自己的系统同构（同应用/同文件格式/同工具链）。

## [S3] Out of Scope

- resolver 按任务/线程起独立 Space + 手写 computer 工具集（文档限制：resolver 沙箱不自动注册 computer 工具——下一切片）
- VM 镜像随安装包分发（明确不打包）
- 弹窗式 HITL 审批路由（安全债 #1 弹窗片）
- 移除 `kind=cua` 旧路由（保留兼容，后续收敛）

## Tasks

- [x] T1: `CuaSandbox` provider 类——host 模式全接口（computer/executeCommand/setEnv/start）— acceptance: 实现 WorkspaceSandbox+SandboxComputer（1.81 类型对齐），host 模式 shell 真跑、computer 接口经 vm 模式真跑（host GUI 待 TCC，见 Report）(covers: S2.1)
- [x] T2: Tauri sidecar 打包 cua — acceptance: desktop 产物内置 cua，app/pull-worker 绝对路径调用生效，无 sidecar 时回退系统 cua（covers: S2.2）
- [x] T3: 专家 workspace 装配 + 权限快照钩子 — acceptance: 带 cua 工具的专家以 workspace 工具面真跑，deny 策略真拒绝（活体验证 `denied by policy`）(covers: S2.3, S2.4)
- [x] T4: vm 模式（cua Space 生命周期） — acceptance: get-or-create Space（--name 对齐）→ computer/命令操作 → streamUrl 可看 → stop/destroy；host 会话不受影响（covers: S2.1, S2.4, depends: T1）
- [x] T5: 双模式真 E2E — acceptance: host（shell 通道）与 vm（GUI+shell）各一条端到端（专家派发→workspace 工具→产物回流），证据入 Report（covers: S2.2, S2.3, depends: T1–T4）

## Journey log

- **@mastra/core 1.81 workspace 工具钩子只认顶层** `toolsConfig.hooks`——per-tool `hooks` 会被静默丢弃（deny 直接变 no-op）。统一钩子按 `workspaceToolName` 分发是正确姿势；钩子上下文的入参字段是 `input` 不是 `args`。
- **`cua sb create` 必须带 `--name <spaceId>`**：省略会生成 `sb-*` 名字，而 `do switch local:<spaceId>` 找不到（exit 3）——get-or-create 的 find/create/destroy 必须同一把名字。
- **host 模式 GUI 受 macOS TCC 约束**（屏幕录制授给 Cua Spaces）；shell 通道不受限。VM 模式截图走客机 spacesd，完全绕开 host TCC——这本身是 VM 模式的一条产品优势。
- `cua do shell --` 只吃一个命令串（多 argv 拼平毁引号）；`streamUrl` = 常驻 `cua viewer --no-open` + `&id=` 深链。
