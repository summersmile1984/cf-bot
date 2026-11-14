use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

const DEFAULT_L1: &str = "http://localhost:4120";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub l1_url: String,
    pub token: String,
    pub interval_ms: u64,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

impl Default for DeviceSettings {
    fn default() -> Self {
        Self {
            l1_url: DEFAULT_L1.to_string(),
            token: String::new(),
            interval_ms: 2000,
            harness: None,
            device_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStatus {
    pub running: bool,
    pub online: bool,
    pub last_claim_at: Option<String>,
    pub last_task_id: Option<String>,
    pub last_kind: Option<String>,
    pub last_state: Option<String>,
    pub last_summary: Option<String>,
    pub queue_hint: Option<String>,
    pub error: Option<String>,
    pub pid: Option<u32>,
}

impl Default for LoopStatus {
    fn default() -> Self {
        Self {
            running: false,
            online: false,
            last_claim_at: None,
            last_task_id: None,
            last_kind: None,
            last_state: None,
            last_summary: None,
            queue_hint: None,
            error: None,
            pid: None,
        }
    }
}

struct AppState {
    child: Mutex<Option<Child>>,
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("mastra-l2")
}

fn device_path() -> PathBuf {
    config_dir().join("device.json")
}

fn status_path() -> PathBuf {
    config_dir().join("status.json")
}

fn read_device() -> DeviceSettings {
    let p = device_path();
    if !p.exists() {
        return DeviceSettings::default();
    }
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => DeviceSettings::default(),
    }
}

fn write_device(settings: &DeviceSettings) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(device_path(), raw).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_status_file() -> Option<LoopStatus> {
    let p = status_path();
    if !p.exists() {
        return None;
    }
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn package_root(app: &tauri::AppHandle, marker: &str) -> PathBuf {
    // 运行时探测（评审 MAJOR：编译期 CARGO_MANIFEST_DIR 绝对路径不可随包走）：
    // 打包资源 l2-pkg/ → exe 旁/上溯 Resources → cwd → 编译期源码树（本机 dev 兜底）
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        cands.push(rd.join("l2-pkg"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            cands.push(d.join("Resources").join("l2-pkg"));
            cands.push(d.join("..").join("Resources").join("l2-pkg"));
            cands.push(d.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(p) = dev.parent() {
        cands.push(p.to_path_buf());
    }
    for p in &cands {
        if p.join(marker).exists() {
            return p.clone();
        }
    }
    // 兜底仍返回 dev 树，让调用方给出「找不到 marker」的明确报错
    dev.parent().map(|p| p.to_path_buf()).unwrap_or(dev)
}

fn resolve_tsx(pkg: &PathBuf) -> (String, Vec<String>) {
    // Prefer local node_modules/.bin/tsx, then npx tsx, then node --import tsx
    let local = pkg.join("node_modules").join(".bin").join("tsx");
    if local.exists() {
        return (local.to_string_lossy().to_string(), vec!["src/main.ts".into()]);
    }
    let npx = which("npx");
    if let Some(npx) = npx {
        return (npx, vec!["tsx".into(), "src/main.ts".into()]);
    }
    ("node".into(), vec!["--import".into(), "tsx".into(), "src/main.ts".into()])
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    // common mac homebrew / local
    for extra in [
        "/opt/homebrew/opt/node@24/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ] {
        let cand = PathBuf::from(extra).join(bin);
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}

#[tauri::command]
fn get_settings() -> DeviceSettings {
    read_device()
}

#[tauri::command]
fn save_settings(settings: DeviceSettings) -> Result<DeviceSettings, String> {
    let mut s = settings;
    s.l1_url = s.l1_url.trim_end_matches('/').to_string();
    if s.interval_ms < 1000 {
        s.interval_ms = 1000;
    }
    write_device(&s)?;
    Ok(s)
}

/// 与 claim loop 同款运行时定位（package_root）：tsx scripts/<script> <args>（harness-cli/mcp-cli 共用）
fn run_node_cli(app: &tauri::AppHandle, script_name: &str, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let pkg = package_root(app, &format!("scripts/{script_name}"));
    let script = pkg.join("scripts").join(script_name);
    if !script.exists() {
        return Err(format!("{script_name} not found: {}", script.display()));
    }
    let local_tsx = pkg.join("node_modules").join(".bin").join("tsx");
    let (bin, mut argv): (String, Vec<String>) = if local_tsx.exists() {
        (local_tsx.to_string_lossy().to_string(), vec![])
    } else if let Some(npx) = which("npx") {
        (npx, vec!["tsx".into()])
    } else {
        ("node".into(), vec!["--import".into(), "tsx".into()])
    };
    argv.push(script.to_string_lossy().to_string());
    argv.extend(args.iter().map(|a| a.to_string()));
    use std::io::Write;
    let mut child = Command::new(&bin)
        .args(&argv)
        .current_dir(&pkg)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {script_name} failed: {e}"))?;
    if let Some(input) = stdin {
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(input.as_bytes());
        }
    }
    let out = child.wait_with_output().map_err(|e| format!("wait {script_name} failed: {e}"))?;
    if !out.status.success() {
        // 结果性错误 JSON 在 stdout：优先回 stdout，stderr 只兜底（评审 MAJOR：不能丢面板可见错误）
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Err(stdout.chars().take(400).collect());
        }
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(200).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn run_harness_cli(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    run_node_cli(app, "harness-cli.ts", args, None)
}

/// MCP 注册表操作（mcp-connections S2.3）：list | catalog | show | set | remove | test | connect | connect-key | disconnect
/// connect-key 的 API Key 经 stdin 传入（评审 MINOR：argv 会进 ps）
#[tauri::command]
fn mcp_cli(app: tauri::AppHandle, args: Vec<String>, stdin: Option<String>) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_node_cli(&app, "mcp-cli.ts", &refs, stdin.as_deref())
}

/// 本机 harness 检测（目录 + 安装状态），返回 JSON。
#[tauri::command]
fn harness_detect(app: tauri::AppHandle) -> Result<String, String> {
    run_harness_cli(&app, &["detect"])
}

/// 一键安装（目录 install.cmd），阻塞至完成，返回 JSON（含复检状态）。
#[tauri::command]
fn harness_install(app: tauri::AppHandle, id: String) -> Result<String, String> {
    run_harness_cli(&app, &["install", &id])
}

#[tauri::command]
fn get_loop_status(state: tauri::State<'_, AppState>) -> LoopStatus {
    let mut st = read_status_file().unwrap_or_default();
    let child_running = {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) => {
                    *guard = None;
                    false
                }
                Err(_) => false,
            }
        } else {
            false
        }
    };
    if child_running {
        st.running = true;
        if st.pid.is_none() {
            if let Ok(g) = state.child.lock() {
                if let Some(c) = g.as_ref() {
                    st.pid = Some(c.id());
                }
            }
        }
    } else if st.running && st.pid.is_some() {
        // status file may be stale after crash
        st.running = false;
        st.online = false;
    }
    st
}

#[tauri::command]
fn start_claim_loop(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<u32, String> {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(None) = child.try_wait() {
                return Ok(child.id());
            }
            *guard = None;
        }
    }

    let settings = read_device();
    if settings.token.trim().is_empty() {
        return Err("Device token is empty — save settings first".into());
    }

    let pkg = package_root(&app, "src/main.ts");
    let main_ts = pkg.join("src").join("main.ts");
    if !main_ts.exists() {
        return Err(format!("claim entry missing: {}", main_ts.display()));
    }

    let (bin, args) = resolve_tsx(&pkg);
    // ensure path relative to pkg
    if args.last().map(|s| s.as_str()) == Some("src/main.ts") {
        // ok
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&pkg)
        .env("L1_PULL_URL", &settings.l1_url)
        .env("PUSH_TOKEN", &settings.token)
        .env("L2_DEVICE_TOKEN", &settings.token)
        .env("L2_DEVICE_ID", settings.device_id.clone().unwrap_or_default())
        .env("L2_PULL_INTERVAL_MS", settings.interval_ms.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Help Node find tools on Mac
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in [
        "/opt/homebrew/opt/node@24/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        &format!("{}/.local/bin", std::env::var("HOME").unwrap_or_default()),
        &format!("{}/.cargo/bin", std::env::var("HOME").unwrap_or_default()),
    ] {
        if !path.split(':').any(|p| p == extra) {
            path = format!("{}:{}", extra, path);
        }
    }
    cmd.env("PATH", path);

    // cua sidecar（Tauri externalBin 随包分发）：绝对路径注入 CUA_BIN，无 sidecar 时 L2 回退系统 cua
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if e.path().is_file() && (n == "cua" || n.starts_with("cua-")) {
                        cmd.env("CUA_BIN", e.path());
                        break;
                    }
                }
            }
        }
    }

    let child = cmd.spawn().map_err(|e| format!("spawn claim loop failed ({bin}): {e}"))?;
    let pid = child.id();
    *state.child.lock().unwrap() = Some(child);

    // seed status
    let seed = LoopStatus {
        running: true,
        online: true,
        last_claim_at: None,
        last_task_id: None,
        last_kind: None,
        last_state: None,
        last_summary: Some(format!("started pid {pid}")),
        queue_hint: Some("starting".into()),
        error: None,
        pid: Some(pid),
    };
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(status_path(), serde_json::to_string_pretty(&seed).unwrap_or_default());

    Ok(pid)
}

#[tauri::command]
fn stop_claim_loop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(guard);
    let prev = read_status_file().unwrap_or_default();
    let stopped = LoopStatus {
        running: false,
        online: false,
        last_claim_at: prev.last_claim_at,
        last_task_id: prev.last_task_id,
        last_kind: prev.last_kind,
        last_state: prev.last_state,
        last_summary: Some("stopped from UI".into()),
        queue_hint: Some("stopped".into()),
        error: None,
        pid: None,
    };
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(status_path(), serde_json::to_string_pretty(&stopped).unwrap_or_default());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            harness_detect,
            harness_install,
            mcp_cli,
            get_loop_status,
            start_claim_loop,
            stop_claim_loop
        ])
        .setup(|app| {
            // Ensure config dir exists
            let _ = fs::create_dir_all(config_dir());
            let _ = app;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    let mut guard = state.child.lock().unwrap();
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mastra Desktop");
}
