// WakeDream 桌面壳（Tauri v2）——只做四件事：选端口、拉起 Node 边车、等它就绪、把窗口指过去。
// 业务全在边车里（app/src/**），这里不复制任何业务逻辑。
//
// 生命周期（顺序很重要）：
//   setup: 建菜单 → 立刻建一个「启动中」窗口（内嵌占位页，不用等边车，用户秒见窗口）
//   后台线程: 选端口 → 拉起 wakedream-server 边车 → 轮询 /api/health → 就绪后 navigate 到客户端
//   退出: 窗口关闭 / Cmd+Q / 菜单退出 → 显式 kill 边车（外加 kill_on_drop 兜底），不留孤儿进程
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 默认端口，与 app/src/shared/config.js 里的默认值一致
const DEFAULT_PORT: u16 = 4680;
/// 等边车就绪的上限：超时就不装死，直接把失败原因显示在窗口里
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_NAME: &str = "wakedream-server";
const MAIN_WINDOW: &str = "main";

/// 边车句柄 + 运行期状态，交给 Tauri 的 state 管，退出时统一收尸。
#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    port: Mutex<Option<u16>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Sidecar {
    fn push_log(&self, line: impl Into<String>) {
        let line = line.into();
        log_desktop(&line);
        if let Ok(mut buf) = self.log.lock() {
            buf.push(line);
            let len = buf.len();
            if len > 80 {
                buf.drain(0..len - 80);
            }
        }
    }

    fn tail(&self, n: usize) -> String {
        self.log
            .lock()
            .map(|buf| buf.iter().rev().take(n).rev().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }

    fn kill(&self) {
        let taken = self.child.lock().ok().and_then(|mut c| c.take());
        if let Some(child) = taken {
            // kill() 会顺带等子进程回收，避免留下僵尸
            match child.kill() {
                Ok(()) => self.push_log("[desktop] 边车已退出"),
                Err(err) => self.push_log(&format!("[desktop] 边车退出时出错（可能已自己退出）：{err}")),
            }
        }
    }
}

// ---------------------------------------------------------------- 小工具

/// 数据目录：WAKEDREAM_HOME 优先，否则 ~/.wakedream（与 app/src/shared/config.js 同口径）
fn data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("WAKEDREAM_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let base = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join(".wakedream")
}

/// 桌面壳自己的日志：<数据目录>/logs/desktop.log，排障时先看它
fn log_desktop(line: &str) {
    let dir = data_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let _ = writeln!(f, "{} {}", now_stamp(), line);
    }
}

fn now_stamp() -> String {
    // 不引时间库：直接用系统时间戳，够排障用了
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("[epoch {secs}]")
}

fn log(line: &str) {
    log_desktop(line);
    eprintln!("{line}");
}

/// 选端口：默认 4680；被占用就换一个内核给的空闲端口（先探测再释放，交给边车绑）
fn pick_port(preferred: u16) -> u16 {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        drop(l);
        return preferred;
    }
    if let Ok(l) = TcpListener::bind(("127.0.0.1", 0)) {
        let port = l.local_addr().map(|a| a.port()).unwrap_or(preferred);
        drop(l);
        return port;
    }
    preferred
}

/// 健康检查：手写最小 HTTP/1.1 GET，省掉一个 http 客户端依赖（也让首次编译快很多）
fn health_ok(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(600)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2000)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_ref(), ""));
    head.starts_with("HTTP/1.1 200") && body.replace(' ', "").contains("\"ok\":true")
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// web/ 静态资源目录：优先环境变量（CI/排障可覆盖），否则取 bundle 资源目录里的 web/
fn resolve_web_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("WAKEDREAM_WEB_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("web");
        if candidate.join("index.html").exists() {
            return candidate;
        }
    }
    // 开发态：src-tauri/../web
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("web");
    dev.canonicalize().unwrap_or(dev)
}

/// 打包边车在磁盘上的位置（与 tauri-plugin-shell 的 `relative_command_path` 同口径：
/// 可执行文件所在目录 + 边车名）。**必须自己判断存在性**——`shell.sidecar()` 只是拼路径、
/// 不检查文件在不在，缺文件时报错发生在 `spawn()` 里，光靠 `sidecar()` 的 Result 回退不到 node。
fn sidecar_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let name = if cfg!(windows) { "wakedream-server.exe" } else { SIDECAR_NAME };
    dir.join(name)
}

/// 开发态回退：没有边车二进制时，用系统的 node 跑 desktop/sidecar-entry.js。
///
/// 特意**不**直接跑 src/server/main.js：那个文件里只有业务启动，没有信号处理与「父进程没了就自杀」的
/// 看门狗；壳被强杀（SIGKILL/SIGTERM 来不及收尸）时它就会变成孤儿进程占着端口。
/// sidecar-entry.js 是 SEA 打包用的同一个入口，普通 node 也能直接跑（ESM），
/// 所以开发态与打包态的行为一致：同样的信号处理 + 同样的孤儿兜底。
fn dev_server_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("desktop").join("sidecar-entry.js")
}

// ---------------------------------------------------------------- 边车

fn spawn_sidecar(app: &AppHandle, port: u16) -> Result<(CommandChild, Arc<AtomicBool>), String> {
    let sidecar = app.state::<Sidecar>();
    let web_dir = resolve_web_dir(app);
    sidecar.push_log(&format!("[desktop] web 资源目录：{}", web_dir.display()));

    let shell = app.shell();
    let canned = sidecar_path();
    let dev_fallback = |why: String| {
        // 开发态（`tauri dev` 还没打边车）走这里，保证 tauri dev 也能跑起来
        let script = dev_server_script();
        let node = std::env::var("WAKEDREAM_NODE").unwrap_or_else(|_| "node".to_string());
        sidecar.push_log(&format!(
            "[desktop] 没有可用的边车二进制（{why}），回退系统 node：{node} {}",
            script.display()
        ));
        shell.command(node).args([script.to_string_lossy().to_string()])
    };
    let mut cmd = if canned.exists() {
        match shell.sidecar(SIDECAR_NAME) {
            Ok(cmd) => {
                sidecar.push_log(&format!("[desktop] 拉起打包边车：{}", canned.display()));
                cmd
            }
            Err(err) => dev_fallback(format!("{err}")),
        }
    } else {
        dev_fallback(format!("{} 不存在", canned.display()))
    };

    cmd = cmd
        .env("PORT", port.to_string())
        .env("WAKEDREAM_WEB_DIR", web_dir.to_string_lossy().to_string())
        .env("WAKEDREAM_DESKTOP", "1")
        // 兜底：即使显式 kill 的路径没走到，句柄被 drop 时也会杀掉子进程
        .kill_on_drop(true);

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("拉起边车失败：{e}"))?;

    let died = Arc::new(AtomicBool::new(false));
    let died_flag = died.clone();
    let log_handle = app.state::<Sidecar>().log.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) => format!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end()),
                CommandEvent::Stderr(bytes) => format!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end()),
                CommandEvent::Error(err) => format!("[sidecar] 错误：{err}"),
                CommandEvent::Terminated(payload) => {
                    died_flag.store(true, Ordering::SeqCst);
                    format!("[sidecar] 进程结束：{payload:?}")
                }
                _ => continue,
            };
            log_desktop(&line);
            if let Ok(mut buf) = log_handle.lock() {
                buf.push(line);
                let len = buf.len();
                if len > 80 {
                    buf.drain(0..len - 80);
                }
            }
        }
    });

    Ok((child, died))
}

/// 启动流程（跑在后台线程，别堵住主线程的事件循环）
fn boot(app: AppHandle) {
    let sidecar = app.state::<Sidecar>();
    let port = pick_port(DEFAULT_PORT);
    sidecar.push_log(&format!("[desktop] 端口：{port}（默认 {DEFAULT_PORT}）"));
    if let Ok(mut p) = sidecar.port.lock() {
        *p = Some(port);
    }

    let (child, died) = match spawn_sidecar(&app, port) {
        Ok(v) => v,
        Err(err) => return fail(&app, &err),
    };
    if let Ok(mut slot) = sidecar.child.lock() {
        *slot = Some(child);
    }

    let started = Instant::now();
    while started.elapsed() < HEALTH_TIMEOUT {
        if health_ok(port) {
            sidecar.push_log(&format!("[desktop] 边车就绪（{} ms）：http://127.0.0.1:{port}/", started.elapsed().as_millis()));
            return show_client(&app, port);
        }
        if died.load(Ordering::SeqCst) {
            let tail = app.state::<Sidecar>().tail(6);
            return fail(&app, &format!("边车刚启动就退出了。最近日志：\n{tail}"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let tail = app.state::<Sidecar>().tail(6);
    fail(
        &app,
        &format!(
            "等边车就绪超时（{} 秒）。最近日志：\n{tail}",
            HEALTH_TIMEOUT.as_secs()
        ),
    );
}

fn show_client(app: &AppHandle, port: u16) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log("[desktop] 主窗口不见了，无法导航");
        return;
    };
    match format!("http://127.0.0.1:{port}/").parse::<tauri::Url>() {
        Ok(url) => {
            if let Err(err) = window.navigate(url) {
                fail(app, &format!("窗口导航失败：{err}"));
                return;
            }
            // 标题就是「启动成功」的外部可观测信号：失败时标题会是「WakeDream — 启动失败：…」
            let _ = window.set_title("WakeDream");
        }
        Err(err) => fail(app, &format!("地址不合法：{err}")),
    }
}

/// 启动失败：不静默、不假成功——标题写明原因，占位页里也显示同一份原因，并落日志
fn fail(app: &AppHandle, message: &str) {
    log(&format!("[desktop] 启动失败：{message}"));
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let brief = message.lines().next().unwrap_or("未知错误").chars().take(80).collect::<String>();
    let _ = window.set_title(&format!("WakeDream — 启动失败：{brief}"));
    let js = format!(
        "window.dispatchEvent(new CustomEvent('wakedream:error', {{ detail: {{ message: \"{}\" }} }}));",
        json_escape(message)
    );
    if let Err(err) = window.eval(js) {
        log(&format!("[desktop] 把错误送进占位页失败：{err}"));
    }
}

// ---------------------------------------------------------------- 窗口 / 菜单

fn create_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    // 先建一个「启动中」窗口（内嵌占位页），不等边车——用户点开图标就立刻有反应
    let handle = app.clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("WakeDream — 正在启动本地服务…")
        .inner_size(1320.0, 880.0)
        .min_inner_size(980.0, 640.0)
        .center()
        .resizable(true)
        .on_navigation(move |url| {
            let scheme = url.scheme();
            // 1) 内嵌占位页（tauri://localhost）
            if scheme == "tauri" || scheme == "about" {
                return true;
            }
            // 2) 边车自己的页面：只放行我们这一轮真正选中的那个端口
            let port = handle.state::<Sidecar>().port.lock().ok().and_then(|p| *p);
            let is_own_service = match (scheme, url.host_str()) {
                ("http", Some(host)) => {
                    (host == "127.0.0.1" || host == "localhost") && url.port_or_known_default() == port
                }
                _ => false,
            };
            if is_own_service {
                return true;
            }
            // 3) 其余（外链、mailto:、别的本地服务）一律交给系统默认程序，不在自己窗口里打开
            let _ = handle.opener().open_url(url.to_string(), None::<&str>);
            false
        })
        .build()
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let wake = SubmenuBuilder::new(app, "WakeDream")
        .about(None)
        .separator()
        .text("open_data_dir", "打开数据目录")
        .text("open_in_browser", "在浏览器中打开")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .close_window()
        .separator()
        .fullscreen()
        .build()?;

    MenuBuilder::new(app).items(&[&wake, &edit, &window]).build()
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open_data_dir" => {
            let dir = data_dir();
            if let Err(err) = std::fs::create_dir_all(&dir) {
                log(&format!("[desktop] 建数据目录失败：{err}"));
            }
            if let Err(err) = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>) {
                log(&format!("[desktop] 打开数据目录失败：{err}"));
            }
        }
        "open_in_browser" => {
            let port = app.state::<Sidecar>().port.lock().ok().and_then(|p| *p);
            match port {
                Some(port) => {
                    if let Err(err) = app.opener().open_url(format!("http://127.0.0.1:{port}/"), None::<&str>) {
                        log(&format!("[desktop] 打开浏览器失败：{err}"));
                    }
                }
                None => log("[desktop] 边车还没就绪，暂时没有可打开的地址"),
            }
        }
        other => log(&format!("[desktop] 未处理的菜单项：{other}")),
    }
}

// ---------------------------------------------------------------- main

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;
            create_main_window(&handle)?;
            log(&format!(
                "[desktop] WakeDream 桌面壳启动，数据目录 {}",
                data_dir().display()
            ));
            // 边车启动放到后台线程：主线程要留着跑事件循环，否则窗口一直不出现
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 单窗口小工具：关窗即退出，顺带保证边车一定被收掉
                if window.label() == MAIN_WINDOW {
                    log("[desktop] 主窗口关闭，退出应用");
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app, event| match event {
            // ExitRequested：窗口全关/主动退出；Exit：真的收尾。两条路都杀掉边车。
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                let sidecar = app.state::<Sidecar>();
                sidecar.push_log("[desktop] 应用退出，回收边车");
                sidecar.kill();
            }
            _ => {}
        });
}
