---
feature: multi-device
status: delivered
updated: 2026-11-14
source: main
---

# 多设备支持：设备身份、配对与任务路由

## Report

**What was built** — 设备身份（`devices`/`pairing_codes` 表 + `src/mastra/devices.ts`）：web「管理→设备」生成一次性配对码（10 分钟）→ 桌面 `POST /devices/pair` 换 `deviceId + device token`（存 `device.json`，可单独吊销）。`/l2-claim` 与全部 L2 端点（callback/progress/ask/artifact/secret/vault/mcp）认 device token（`l2Auth`），共享 PUSH_TOKEN 老路径兼容（匿名）。任务路由（S2.1）：`dispatch_to_sandbox`/`dispatch_to_expert` 增 `device` 参数，派发时解析——显式 > 默认设备 > NULL（抢单），落 `l2_tasks.device_id`；claim 过滤 `device_id IS NULL OR device_id=me`；`job_status` 附 device。管理面：设备列表（默认徽标/最后活跃/能力）、设默认/改名/吊销/生成配对码。桌面端 `ui/main.ts` 配对码流程 + `l2-pull-worker` 认 `L2_DEVICE_TOKEN`。实现中回归抓到并修复 `setDefaultDevice` SQL 占位符错配+缺 user 作用域（devices.ts:104）。

**Verification** — `scripts/spike-multi-device.ts` 22/22（配对一次性/认证/吊销失效/解析链/默认回落抢单）；`scripts/spike-multi-device-e2e.ts` 生产 15/15（双设备配对、定向单只被目标设备领、抢单单可被任一设备领、callback 认设备 token、吊销后 claim/callback 双 401、配对码一次性）；`scripts/spike-multi-device-dispatch.ts` 真模型 3/3（未指定→绑默认设备、无效设备名→秘书式报错不落库、显式指定→绑该设备，device_id 落库核对 D1）。浏览器截图 verify-shots/multi-device-console-{devices,paircode}.png（设备行+默认徽标、配对码展示）。桌面 Tauri 端配对 UI 仅 esbuild 语法校验（本机未跑 Tauri 构建），其调用的 /devices/pair API 已生产 E2E。

## [S1] Problem

一个用户可能有多台 PC（家里/公司）。现状：所有设备共享 `PUSH_TOKEN` 抢单，设备无身份、任务无归属——`runtime='local'` 的「本地」没有指向，A 机的本地文件任务会被 B 机领走；AGENTS.md 写的「任务分配由 L1 协调」未落地；设备不可见、无法单独吊销。单设备场景无碍，多设备场景语义崩坏。

## [S2] Design

### S2.1 决策：本地任务绑定语义（2026-11-13 拍板）

**默认设备 + 可指定**：
- `dispatch` 显式指定 device → 定向该设备；
- 未指定 → 用户的「默认设备」（若设置）；
- 无默认 → **在线设备池抢单**（`device_id IS NULL` 的任务任何设备可领），单设备零回归。
- 解析发生在**派发时**（写入 `l2_tasks.device_id`），claim 端只需过滤，语义简单可审计。

### S2.2 设备身份与配对（P0）

- `devices` 表：`id(device-xxx)/user_id/name/token_hash/capabilities(json)/last_seen_at/status(active|revoked)/is_default/created_at`。
- **配对流程**：web「设备」tab 生成一次性配对码（`pairing_codes`，10 分钟有效、用后作废）→ 桌面端输入 → `POST /devices/pair {code, name, capabilities}` → 返回 `deviceId + device token`（长期、可单独吊销）→ 存 `device.json`。
- **claim 认证**：`/l2-claim` 优先认 device token（`devices.token_hash` 匹配）；共享 `PUSH_TOKEN` 仍兼容（老路径，身份=匿名）。认领时刷新 `last_seen_at`。
- `l2_tasks` 加 `device_id`（NULL=任意设备）；新增 `user_settings.default_device_id`。

### S2.3 任务路由（P1）

- `dispatch_to_sandbox` / `dispatch_to_expert` 增加可选 `device` 参数（设备名或 id）。
- 派发时解析：显式 > 默认设备 > NULL（抢单）；显式指向离线/不存在的设备 → 明确报错不闷派。
- claim SQL：`state='queued' AND (device_id IS NULL OR device_id=:me)`，原子领取不变。
- `job_status` 增加 `device` 显示。

### S2.4 管理面（P2）— L2 控制台「设备」tab

- 设备列表：名称 / 能力 / 最后活跃 / 默认徽标 / 状态；操作：设默认、改名、吊销、生成配对码（展示一次性码）。
- 吊销后设备 token 失效（claim 401）。

### S2.5 桌面端接入（最小改动）

- `l2-pull-worker`：读 `device.json` 的 deviceId/deviceToken（env 兜底 `L2_DEVICE_ID/L2_DEVICE_TOKEN`），claim 带设备标识。
- 桌面 UI：原「device pairing token」输入升级为「配对码」——输入配对码 → `/devices/pair` → 保存设备凭据到 device.json。

## [S3] Out of Scope

- 能力标签精细路由（屏幕/harness 匹配）与任务粘性（P3）
- 设备级并发配额、离线积压与补跑
- 移动端作为执行位

## Tasks

- [x] T1: 设备身份后端（devices/pairing 表 + /devices/* 路由 + claim 设备认证）— acceptance: 配对码→注册→设备 token 认证 claim 全通，吊销后 401 (covers: S2.2)
- [x] T2: 任务路由（device_id + 默认设备 + dispatch device 参数 + 解析链）— acceptance: 定向任务只被目标设备领；未指定走默认/抢单；错误设备名报错 (covers: S2.1/S2.3)
- [x] T3: 设备 tab + l2-pull-worker 设备标识 + 桌面配对接线 — acceptance: 控制台可生成配对码/设默认/吊销；sidecar 带设备身份 claim (covers: S2.4/S2.5)
- [x] T4: 回归交付（构建部署 + 多设备 E2E + 截图）— acceptance: 生产双设备模拟（两身份 claim）验证路由语义 (covers: S2.1)

## Journey log

- 2026-11-13：绑定语义选择「派发时解析」而非「claim 时过滤偏好」——任务表里 device_id 是显式事实，审计/调试都看得到「这单派给了谁」；抢单兜底保留单设备零回归。
- 2026-11-14：全 L2 端点统一 `l2Auth`（device token 优先、PUSH_TOKEN 兼容）——只改 claim 认设备 token 会导致配对后 callback/ask 等 401，认证面必须一次换齐。生产 E2E 发现 claim 会被历史积压 NULL 单干扰，测试单 `created_at` 回拨到 epoch 保证排最前；顺手清理 4 条 release-watch 测试遗留 queued 单。spike 抓到 setDefaultDevice 坏 SQL（占位符多传 userId 且缺 WHERE user_id）——D1 可能容忍、node:sqlite 直接报错，真 SQL 回归的价值点。
