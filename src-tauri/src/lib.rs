use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    PatBlt, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLACKNESS,
    DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, GW_HWNDNEXT,
};

// ─── Window listing ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
}

unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd);
        if length > 0 {
            let mut buffer = vec![0u16; (length + 1) as usize];
            if GetWindowTextW(hwnd, &mut buffer) > 0 {
                let title = String::from_utf16_lossy(&buffer[..length as usize]);
                let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
                list.push(WindowInfo { hwnd: hwnd.0 as isize, title });
            }
        }
    }
    windows::core::BOOL::from(true)
}

#[command]
fn list_windows() -> Vec<WindowInfo> {
    let mut list: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window_callback), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

// ─── Auto-mode helpers ───────────────────────────────────────────────────────

/// Window classes that should never be selected as capture target in Auto mode.
const SKIP_CLASSES: &[&str] = &[
    "Shell_TrayWnd",           // メインタスクバー
    "Shell_SecondaryTrayWnd",  // マルチモニタのタスクバー
    "WorkerW",                 // デスクトップ背景
    "Progman",                 // Windows デスクトップ
    "DV2ControlHost",          // Windows スタートメニュー
    "Windows.UI.Core.CoreWindow", // UWP シェルウィンドウ
];

unsafe fn is_system_window(hwnd: HWND) -> bool {
    let mut class_buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut class_buf);
    if len > 0 {
        let class = String::from_utf16_lossy(&class_buf[..len as usize]);
        return SKIP_CLASSES.iter().any(|s| class.as_str() == *s);
    }
    false
}

/// Walk z-order from the current foreground window and return the first visible
/// window that (a) does NOT belong to our process AND (b) is not a system shell window.
unsafe fn find_non_own_foreground(our_pid: u32) -> Option<HWND> {
    let mut hwnd = GetForegroundWindow();
    for _ in 0..500 {
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != our_pid && IsWindowVisible(hwnd).as_bool() && !is_system_window(hwnd) {
            return Some(hwnd);
        }
        hwnd = GetWindow(hwnd, GW_HWNDNEXT).unwrap_or_default();
    }
    None
}

// ─── Screenshot capture ──────────────────────────────────────────────────────

/// Helper to get window title by HWND for logging
unsafe fn get_window_title(hwnd: HWND) -> String {
    let length = GetWindowTextLengthW(hwnd);
    if length > 0 {
        let mut buffer = vec![0u16; (length + 1) as usize];
        if GetWindowTextW(hwnd, &mut buffer) > 0 {
            return String::from_utf16_lossy(&buffer[..length as usize]);
        }
    }
    "Unknown Window".to_string()
}

/// Capture an arbitrary window by HWND regardless of focus or z-order.
#[command]
fn capture_window(hwnd: isize, save_dir: String) -> Result<String, String> {
    unsafe {
        // バックエンドに届いた生の数値をまず出力
        log::info!("!!! Backend received request: hwnd={}, save_dir={}", hwnd, save_dir);

        // ── 1. Target HWND ────────────────────────────────────────────────────
        let target_hwnd: HWND = if hwnd == 0 {
            let our_pid = GetCurrentProcessId();
            let resolved = find_non_own_foreground(our_pid)
                .ok_or_else(|| {
                    log::error!("Auto-mode resolution failed: no suitable window found");
                    "Auto: フォアグラウンドに適切なウィンドウが見つかりません".to_string()
                })?;
            log::info!("Resolved Auto-target: HWND={:?}, Title={}", resolved, get_window_title(resolved));
            resolved
        } else {
            let provided = HWND(hwnd as *mut _);
            log::info!("Resolved Manual-target: HWND={:?}, Title={}", provided, get_window_title(provided));
            provided
        };

        if target_hwnd.0.is_null() {
            log::error!("Target HWND is null. hwnd arg was: {}", hwnd);
            return Err("Target HWND is null".to_string());
        }

        // ── 2. Full-window size (GetWindowRect) ───────────────────────────────
        // GetWindowRect returns screen coordinates => width/height of the full window.
        // This matches what PrintWindow(PW_RENDERFULLCONTENT) renders.
        let mut win_rect = RECT::default();
        GetWindowRect(target_hwnd, &mut win_rect)
            .map_err(|e| format!("GetWindowRect failed: {e}"))?;

        let width  = win_rect.right  - win_rect.left;
        let height = win_rect.bottom - win_rect.top;

        if width <= 0 || height <= 0 {
            return Err(format!("Invalid window dimensions: {width}x{height}"));
        }

        // ── 3. Memory DC + bitmap ─────────────────────────────────────────────
        let screen_dc = GetDC(None);
        let mem_dc    = CreateCompatibleDC(Some(screen_dc));
        let bitmap    = CreateCompatibleBitmap(screen_dc, width, height);
        let old_obj   = SelectObject(mem_dc, bitmap.into());

        // Clear bitmap to black so we get a visible black frame instead of
        // garbage pixels if PrintWindow doesn't write to all areas.
        let _ = PatBlt(mem_dc, 0, 0, width, height, BLACKNESS);

        // ── 4. PrintWindow – works for background / unfocused windows ─────────
        // PW_RENDERFULLCONTENT (2): renders DWM/DirectX content as displayed.
        // Do NOT combine with PW_CLIENTONLY here because the bitmap is sized
        // to the full window (GetWindowRect), not just the client area.
        let ok = PrintWindow(target_hwnd, mem_dc, PRINT_WINDOW_FLAGS(2));

        if !ok.as_bool() {
            SelectObject(mem_dc, old_obj);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err(
                "PrintWindow failed – ウィンドウが保護されているか、対応していない可能性があります".to_string()
            );
        }

        // ── 5. Extract pixel data ─────────────────────────────────────────────
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize:        std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth:       width,
                biHeight:      -height, // negative = top-down DIB
                biPlanes:      1,
                biBitCount:    32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            bmiColors: [Default::default()],
        };

        let mut pixels: Vec<u8> = vec![0u8; (width * height) as usize * 4];
        let scan_lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // ── 6. Cleanup GDI ────────────────────────────────────────────────────
        SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if scan_lines == 0 {
            return Err("GetDIBits returned 0 scan lines".to_string());
        }

        // ── 7. BGRA → RGBA ────────────────────────────────────────────────────
        for chunk in pixels.chunks_mut(4) {
            chunk.swap(0, 2);
        }

        // ── 8. PNG 保存 ───────────────────────────────────────────────────────
        let save_path = PathBuf::from(&save_dir);
        std::fs::create_dir_all(&save_path)
            .map_err(|e| format!("Failed to create save dir: {e}"))?;

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let file_path = save_path.join(format!("cap_{timestamp}.png"));

        image::save_buffer(
            &file_path,
            &pixels,
            width as u32,
            height as u32,
            image::ColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to save PNG: {e}"))?;

        Ok(file_path.to_string_lossy().to_string())
    }
}

// ─── Project Management ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub text: String,
    pub created_at: u64,
    pub dir_path: String,
}

#[command]
fn list_projects(app_data_dir: String) -> Vec<ProjectInfo> {
    let mut projects = Vec::new();
    let projects_dir = PathBuf::from(&app_data_dir).join("projects");

    if !projects_dir.exists() {
        return projects;
    }

    if let Ok(entries) = std::fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let json_path = path.join("project.json");
                if json_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&json_path) {
                        if let Ok(mut info) = serde_json::from_str::<ProjectInfo>(&content) {
                            // dir_path が古い環境や移動によってずれても良いように動的に設定し直す
                            info.dir_path = path.to_string_lossy().into_owned();
                            projects.push(info);
                        }
                    }
                }
            }
        }
    }

    // 作成日時で新しい順にソート
    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    projects
}

#[command]
fn create_project(app_data_dir: String, name: String, text: String) -> Result<ProjectInfo, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
        
    let id = format!("proj_{}", timestamp);
    
    let projects_dir = PathBuf::from(&app_data_dir).join("projects");
    let target_dir = projects_dir.join(&id);
    let captures_dir = target_dir.join("captures");
    
    // ディレクトリ作成
    std::fs::create_dir_all(&captures_dir).map_err(|e| format!("ディレクトリ作成に失敗しました: {}", e))?;
    
    let info = ProjectInfo {
        id,
        name,
        text,
        created_at: timestamp,
        dir_path: target_dir.to_string_lossy().into_owned(),
    };
    
    // JSON保存
    let json_path = target_dir.join("project.json");
    let json_content = serde_json::to_string_pretty(&info).map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
    std::fs::write(json_path, json_content).map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
    
    Ok(info)
}

#[command]
fn update_project_text(project_dir: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(&project_dir).join("project.json");
    if !path.exists() {
        return Err("プロジェクトファイルが見つかりません".to_string());
    }
    
    let content = std::fs::read_to_string(&path).map_err(|e| format!("ファイル読み込みに失敗しました: {}", e))?;
    let mut info: ProjectInfo = serde_json::from_str(&content).map_err(|e| format!("JSONのパースに失敗しました: {}", e))?;
    
    info.text = text;
    
    let json_content = serde_json::to_string_pretty(&info).map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
    std::fs::write(&path, json_content).map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
    
    Ok(())
}

// ─── Capture Preview Features ────────────────────────────────────────────────

#[command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("ファイル読み込みに失敗しました: {}", e))
}

#[derive(Serialize, Deserialize)]
struct CaptureData {
    image: String,
    text: String,
    timestamp: u64,
}

#[command]
fn save_capture_text(image_path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(&image_path);
    let json_path = path.with_extension("json");
    
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
        
    let image_filename = path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let data = CaptureData {
        image: image_filename,
        text,
        timestamp,
    };
    
    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&json_path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
        
    Ok(())
}

#[command]
fn save_text_only(project_dir: String, text: String) -> Result<(), String> {
    let captures_dir = PathBuf::from(&project_dir).join("captures");
    if !captures_dir.exists() {
        return Err("Projects captures directory not found".to_string());
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
        
    let json_filename = format!("text_{timestamp}.json");
    let json_path = captures_dir.join(&json_filename);

    let data = CaptureData {
        image: "".to_string(), // 空文字でテキストのみであることを示す
        text,
        timestamp,
    };
    
    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&json_path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
        
    Ok(())
}

#[command]
fn update_capture_text(json_path: String, new_text: String) -> Result<(), String> {
    let path = PathBuf::from(&json_path);
    if !path.exists() {
        return Err("JSON File not found".to_string());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("ファイル読み込みに失敗しました: {}", e))?;
        
    let mut data: CaptureData = serde_json::from_str(&content)
        .map_err(|e| format!("JSONのパースに失敗しました: {}", e))?;

    data.text = new_text;

    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;

    Ok(())
}

#[command]
fn delete_capture_item(image_path: String, json_path: String) -> Result<(), String> {
    let i_path = PathBuf::from(&image_path);
    if !image_path.is_empty() && i_path.exists() {
        let _ = std::fs::remove_file(&i_path);
    }

    let j_path = PathBuf::from(&json_path);
    if !json_path.is_empty() && j_path.exists() {
        let _ = std::fs::remove_file(&j_path);
    }

    Ok(())
}

#[derive(Serialize)]
struct HistoryItem {
    image_path: String,
    json_path: String,
    image_name: String,
    text: String,
    timestamp: u64,
}

#[command]
fn get_project_captures(project_dir: String) -> Result<Vec<HistoryItem>, String> {
    let captures_dir = PathBuf::from(&project_dir).join("captures");
    if !captures_dir.exists() {
        return Ok(Vec::new());
    }

    let mut history = Vec::new();

    if let Ok(entries) = std::fs::read_dir(captures_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let ext = path.extension().and_then(|s| s.to_str());
                if ext == Some("png") {
                    let json_path = path.with_extension("json");
                    let mut text = String::new();
                    let mut timestamp = 0;

                    if json_path.exists() {
                        if let Ok(content) = std::fs::read_to_string(&json_path) {
                            if let Ok(data) = serde_json::from_str::<CaptureData>(&content) {
                                text = data.text;
                                timestamp = data.timestamp;
                            }
                        }
                    } else {
                        // JSONがない場合はファイルの更新日時をフォールバックとして使う
                        timestamp = std::fs::metadata(&path)
                            .and_then(|m| m.modified())
                            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
                            .unwrap_or(0);
                    }

                    history.push(HistoryItem {
                        image_path: path.to_string_lossy().into_owned(),
                        json_path: json_path.to_string_lossy().into_owned(),
                        image_name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                        text,
                        timestamp,
                    });
                } else if ext == Some("json") {
                    // txt-only case or standalone json. If it corresponds to a PNG, it's already handled.
                    // We check if image is empty to treat as text-only.
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(data) = serde_json::from_str::<CaptureData>(&content) {
                            if data.image.is_empty() {
                                history.push(HistoryItem {
                                    image_path: "".to_string(), // 画像なし
                                    json_path: path.to_string_lossy().into_owned(),
                                    image_name: "".to_string(),
                                    text: data.text,
                                    timestamp: data.timestamp,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 最新のものが上に来るようにソート
    history.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    
    Ok(history)
}

// ─── App entry ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .filter(|metadata| {
                    let target = metadata.target();
                    if target.contains("tao::platform_impl::platform::event_loop::runner") {
                        return metadata.level() < log::Level::Warn;
                    }
                    true
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_windows,
            capture_window,
            list_projects,
            create_project,
            update_project_text,
            read_file_bytes,
            save_capture_text,
            get_project_captures,
            save_text_only,
            update_capture_text,
            delete_capture_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
