---
feature: voice
status: designed
updated: 2026-11-15
source: main
---

# 语音输入与播报：动口不动手

---
feature: voice
status: delivered
updated: 2026-11-15
source: main
---

# 语音输入与播报：动口不动手

## Report

**What was built** — 聊天输入按住说话（Web Speech API 本机识别，转写入输入框；不支持的浏览器按钮隐藏；首次使用隐私 toast「语音在本机识别，不会上传」）+ 回复朗读（speechSynthesis 系统音色，长文截 300 字，新朗读打断旧的，🔊/⏹ 切换）。

**Verification** — 生产 DOM 实测：麦克风按钮与多条回复朗读键（5 个）正确渲染；Chromium 下 SpeechRecognition 可用性分支正确。

## [S1] Problem

秘书产品高频场景是「边走边说」：手机上打字派任务别扭，桌面端想「听」回复而不是盯屏。语音是个人 agent 的自然入口（对标各家 Personal Agent 的标配），但 v1 不需要云 ASR/TTS 质量——浏览器原生 API 覆盖 80% 体验，隐私还更好（语音不出设备）。

## [S2] Design

### S2.1 语音输入（ASR）

- 聊天输入框旁麦克风按钮；`webkitSpeechRecognition`（Chrome/Edge/Safari 部分），`recognition.lang = navigator.language`，连续模式关、按住说话（按下开始、松开出字）。
- 转写文本填入输入框（可编辑后再发）；不支持 `SpeechRecognition` 的浏览器**隐藏按钮**不报错。
- 隐私提示：首次点击麦克风时 toast 一句「语音在本机识别，不会上传」。

### S2.2 回复播报（TTS）

- assistant 消息旁「朗读」小按钮；`speechSynthesis.speak(new SpeechSynthesisUtterance(text))`，取系统默认音色；播放中按钮变「停止」。
- 摘要化：长回复取前 300 字播报（可停止）；同一时间只播一条（新朗读打断旧的）。

## [S3] Out of Scope

- 云 ASR/TTS（质量更好但过隐私与成本，P3）、唤醒词、语音通话、多音色选择。

## Tasks

- [x] T1: 语音输入 — acceptance: 支持的浏览器按住说话出字入框；不支持时按钮隐藏；toast 隐私提示 (covers: S2.1) — ✅ 按住说话（pointer 事件）实现
- [x] T2: 回复播报 — acceptance: 每条回复可朗读/停止；长文截断 300 字；新朗读打断旧的 (covers: S2.2) — ✅

## Journey log

- 2026-11-15：选浏览器原生 ASR/TTS——零依赖零成本，macOS/iOS/Android 主流浏览器都有一档可用体验；云端方案等真实用户抱怨质量再上。
