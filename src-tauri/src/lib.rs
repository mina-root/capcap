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

        let file_path = save_path.join(FILE_PENDING_IMAGE);

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

const DIR_PROJECTS: &str = "projects";
const DIR_CAPTURES: &str = "captures";
const FILE_PROJECT_JSON: &str = "project.json";
const FILE_PENDING_IMAGE: &str = "_pending_cap.png";

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub text: String,
    pub created_at: u64,
    pub dir_path: String,
    #[serde(default)]
    pub discord_thread_id: Option<String>,
    #[serde(default)]
    pub notion_page_id: Option<String>,
    #[serde(default)]
    pub discord_webhook_url: Option<String>,
}

#[command]
fn list_projects(app_data_dir: String) -> Vec<ProjectInfo> {
    let mut projects = Vec::new();
    let projects_dir = PathBuf::from(&app_data_dir).join(DIR_PROJECTS);

    if !projects_dir.exists() {
        return projects;
    }

    if let Ok(entries) = std::fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let json_path = path.join(FILE_PROJECT_JSON);
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
    
    let projects_dir = PathBuf::from(&app_data_dir).join(DIR_PROJECTS);
    let target_dir = projects_dir.join(&id);
    let captures_dir = target_dir.join(DIR_CAPTURES);
    
    // ディレクトリ作成
    std::fs::create_dir_all(&captures_dir).map_err(|e| format!("ディレクトリ作成に失敗しました: {}", e))?;
    
    let info = ProjectInfo {
        id,
        name,
        text,
        created_at: timestamp,
        dir_path: target_dir.to_string_lossy().into_owned(),
        discord_thread_id: None,
        notion_page_id: None,
        discord_webhook_url: None,
    };
    
    // JSON保存
    let json_path = target_dir.join(FILE_PROJECT_JSON);
    let json_content = serde_json::to_string_pretty(&info).map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
    std::fs::write(json_path, json_content).map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
    
    Ok(info)
}

#[command]
fn update_project(project: ProjectInfo) -> Result<(), String> {
    let path = PathBuf::from(&project.dir_path).join(FILE_PROJECT_JSON);
    if !path.exists() {
        return Err("プロジェクトファイルが見つかりません".to_string());
    }
    
    let json_content = serde_json::to_string_pretty(&project).map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
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
    image: Option<String>,
    text: String,
    timestamp: u64,
    #[serde(default)]
    discord_posted: bool,
    #[serde(default)]
    discord_message_id: Option<String>,
    #[serde(default)]
    notion_posted: bool,
    #[serde(default)]
    notion_block_id: Option<String>,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub json_path: String,
    pub image_path: Option<String>,
}


#[command]
fn save_capture_text(image_path: String, text: String) -> Result<SaveResult, String> {
    let old_path = PathBuf::from(&image_path);
    if !old_path.exists() {
        return Err("Pending capture image not found".to_string());
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let new_filename = format!("cap_{timestamp}.png");
    let new_path = old_path.with_file_name(&new_filename);
    let json_path = new_path.with_extension("json");

    // Rename temp file to official filename
    std::fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to finalize image: {}", e))?;

    let data = CaptureData {
        image: Some(new_filename),
        text,
        timestamp,
        discord_posted: false,
        discord_message_id: None,
        notion_posted: false,
        notion_block_id: None,
    };

    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;

    std::fs::write(&json_path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;

    Ok(SaveResult {
        json_path: json_path.to_string_lossy().into_owned(),
        image_path: Some(new_path.to_string_lossy().into_owned()),
    })
}


#[command]
fn save_text_only(project_dir: String, text: String) -> Result<SaveResult, String> {
    let captures_dir = PathBuf::from(&project_dir).join(DIR_CAPTURES);
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
        image: None,
        text,
        timestamp,
        discord_posted: false,
        discord_message_id: None,
        notion_posted: false,
        notion_block_id: None,
    };
    
    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&json_path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;
        
    Ok(SaveResult {
        json_path: json_path.to_string_lossy().into_owned(),
        image_path: None,
    })
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
async fn edit_discord_message(webhook_url: String, message_id: String, text: String, thread_id: Option<String>) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut url = format!("{}/messages/{}", webhook_url, message_id);
    
    if let Some(t_id) = thread_id {
        if !t_id.is_empty() {
            url.push_str(&format!("?thread_id={}", t_id));
        }
    }

    let mut map = std::collections::HashMap::new();
    map.insert("content", text);

    let res = client.patch(&url)
        .json(&map)
        .send()
        .await
        .map_err(|e| format!("Discordメッセージの編集に失敗しました: {}", e))?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Discordからエラーが返されました: {}", res.status()))
    }
}

#[command]
async fn delete_discord_message(webhook_url: String, message_id: String, thread_id: Option<String>) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut url = format!("{}/messages/{}", webhook_url, message_id);
    
    if let Some(t_id) = thread_id {
        if !t_id.is_empty() {
            url.push_str(&format!("?thread_id={}", t_id));
        }
    }

    let res = client.delete(&url)
        .send()
        .await
        .map_err(|e| format!("Discordメッセージの削除に失敗しました: {}", e))?;

    if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("Discordからエラーが返されました: {}", res.status()))
    }
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
    discord_posted: bool,
    discord_message_id: Option<String>,
    notion_posted: bool,
    notion_block_id: Option<String>,
}

#[command]
fn get_project_captures(project_dir: String) -> Result<Vec<HistoryItem>, String> {
    let captures_dir = PathBuf::from(&project_dir).join(DIR_CAPTURES);
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
                    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or_default();
                    if filename == FILE_PENDING_IMAGE {
                        continue;
                    }
                    let json_path = path.with_extension("json");
                    let mut text = String::new();
                    let mut timestamp = 0;
                    let mut discord_posted = false;
                    let mut discord_message_id = None;
                    let mut notion_posted = false;
                    let mut notion_block_id = None;

                    if json_path.exists() {
                        if let Ok(content) = std::fs::read_to_string(&json_path) {
                            if let Ok(data) = serde_json::from_str::<CaptureData>(&content) {
                                text = data.text;
                                timestamp = data.timestamp;
                                discord_posted = data.discord_posted;
                                discord_message_id = data.discord_message_id;
                                notion_posted = data.notion_posted;
                                notion_block_id = data.notion_block_id;
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
                            discord_posted,
                            discord_message_id,
                            notion_posted,
                            notion_block_id,
                        });
                } else if ext == Some("json") {
                    // txt-only case or standalone json. If it corresponds to a PNG, it's already handled.
                    // We check if image is empty to treat as text-only.
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(data) = serde_json::from_str::<CaptureData>(&content) {
                            let is_empty = match &data.image {
                                Some(s) => s.is_empty(),
                                None => true,
                            };
                            if is_empty {
                                history.push(HistoryItem {
                                    image_path: "".to_string(), // 画像なし
                                    json_path: path.to_string_lossy().into_owned(),
                                    image_name: "".to_string(),
                                    text: data.text,
                                    timestamp: data.timestamp,
                                    discord_posted: data.discord_posted,
                                    discord_message_id: data.discord_message_id,
                                    notion_posted: data.notion_posted,
                                    notion_block_id: data.notion_block_id,
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

#[command]
fn mark_discord_posted(json_path: String, message_id: Option<String>) -> Result<(), String> {
    let path = PathBuf::from(&json_path);

    let mut data: CaptureData = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("ファイル読み込みに失敗しました: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("JSONのパースに失敗しました: {}", e))?
    } else {
        let image_filename = path.with_extension("png").file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
            
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        CaptureData {
            image: Some(image_filename),
            text: "".to_string(),
            timestamp,
            discord_posted: false,
            discord_message_id: None,
            notion_posted: false,
            notion_block_id: None,
        }
    };

    data.discord_posted = true;
    data.discord_message_id = message_id;

    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;

    Ok(())
}

#[command]
async fn post_to_discord(webhook_url: String, text: String, image_path: String, thread_id: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut form = reqwest::multipart::Form::new();
    
    if !text.is_empty() {
        form = form.text("content", text);
    }

    if !image_path.is_empty() && PathBuf::from(&image_path).exists() {
        if let Ok(bytes) = std::fs::read(&image_path) {
            let file_name = PathBuf::from(&image_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name);
            form = form.part("file", part);
        }
    }

    let mut url = webhook_url;
    if let Some(t_id) = thread_id {
        if !t_id.is_empty() {
            let sep = if url.contains('?') { "&" } else { "?" };
            url.push_str(&format!("{}thread_id={}", sep, t_id));
        }
    }
    
    let sep = if url.contains('?') { "&" } else { "?" };
    url.push_str(&format!("{}wait=true", sep));

    // Send
    let res = client.post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Webhook送信に失敗しました: {}", e))?;

    if res.status().is_success() {
        let body = res.text().await.map_err(|e| format!("レスポンスボディの取得に失敗しました: {}", e))?;
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("レスポンスのパースに失敗しました: {}", e))?;
        if let Some(id) = v["id"].as_str() {
            Ok(id.to_string())
        } else {
            Ok("".to_string())
        }
    } else {
        Err(format!("Discordからエラーが返されました: {}", res.status()))
    }
}

pub fn compress_image(image_path: &str, max_bytes: u64) -> Result<String, String> {
    let path = std::path::PathBuf::from(image_path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("ファイル情報取得失敗: {}", e))?;
    if meta.len() <= max_bytes {
        return Ok(image_path.to_string());
    }

    let img = image::open(&path).map_err(|e| format!("画像を開けませんでした: {}", e))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_path = std::env::temp_dir().join(format!("compressed_{}.jpg", timestamp));
    
    // Convert to RGB8 to allow JPEG saving without alpha channel
    let img = img.into_rgb8();
    
    let mut out_file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Temp file作成失敗: {}", e))?;
    
    // image 0.25 supports JpegEncoder
    use image::codecs::jpeg::JpegEncoder;
    let mut encoder = JpegEncoder::new_with_quality(&mut out_file, 80);
    encoder.encode(&img, img.width(), img.height(), image::ColorType::Rgb8.into())
        .map_err(|e| format!("JPEG圧縮失敗: {}", e))?;
        
    Ok(temp_path.to_string_lossy().to_string())
}

#[command]
fn mark_notion_posted(json_path: String, block_id: Option<String>) -> Result<(), String> {
    let path = PathBuf::from(&json_path);
    if !path.exists() {
        return Err("JSON File not found".to_string());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("ファイル読み込みに失敗しました: {}", e))?;
    let mut data: CaptureData = serde_json::from_str(&content)
        .map_err(|e| format!("JSONのパースに失敗しました: {}", e))?;

    data.notion_posted = true;
    data.notion_block_id = block_id;

    let json_content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("JSONのシリアライズに失敗しました: {}", e))?;
        
    std::fs::write(&path, json_content)
        .map_err(|e| format!("ファイル保存に失敗しました: {}", e))?;

    Ok(())
}

#[command]
async fn post_to_notion(notion_api_token: String, page_id: String, text: String, image_path: String) -> Result<String, String> {
    let mut page_id = page_id.trim();
    // If it looks like a URL, extract the last part (the ID)
    if page_id.contains("notion.so/") {
        if let Some(last_part) = page_id.split('/').last() {
            // Remove any query params
            page_id = last_part.split('?').next().unwrap_or(last_part);
            // Some IDs are at the end of the URL like page-name-UUID
            if let Some(pos) = page_id.rfind('-') {
                let potential_uuid = &page_id[pos+1..];
                if potential_uuid.len() >= 32 {
                    page_id = potential_uuid;
                }
            }
        }
    }

    if page_id.is_empty() {
        return Err("Notion Page ID is empty".to_string());
    }
    log::info!("post_to_notion started. PageID: {}", page_id);
    let client = reqwest::Client::new();
    let notion_version = "2022-06-28";
    let mut upload_id_to_attach = None;

    if !image_path.is_empty() && PathBuf::from(&image_path).exists() {
        log::info!("Processing image for Notion: {}", image_path);
        // Notion free tier is 5MB
        let final_image_path = compress_image(&image_path, 5 * 1024 * 1024)?;
        let file_name = PathBuf::from(&final_image_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        if let Ok(bytes) = std::fs::read(&final_image_path) {
            let content_type = if file_name.to_lowercase().ends_with(".jpg") || file_name.to_lowercase().ends_with(".jpeg") {
                "image/jpeg"
            } else {
                "image/png"
            };

            log::info!("Initiating Notion file upload (Step 1)... Filename: {}, Type: {}", file_name, content_type);
            // STEP 1: Create File Upload Object
            let upload_res = client.post("https://api.notion.com/v1/file_uploads")
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
                .header("Notion-Version", notion_version)
                .json(&serde_json::json!({
                    "filename": file_name,
                    "content_type": content_type
                }))
                .send()
                .await
                .map_err(|e| format!("Notion Upload APIの呼び出しに失敗: {}", e))?;

            if upload_res.status().is_success() {
                let upload_body: serde_json::Value = upload_res.json().await.map_err(|_| "Invalid JSON from Notion".to_string())?;
                if let (Some(upload_id), Some(upload_url)) = (upload_body["id"].as_str(), upload_body["upload_url"].as_str()) {
                    log::info!("Uploading file contents to Notion (Step 2)... ID: {}", upload_id);
                    // STEP 2: Send File Content
                    let part = reqwest::multipart::Part::bytes(bytes)
                        .file_name(file_name)
                        .mime_str(content_type)
                        .map_err(|e| format!("Invalid MIME type: {}", e))?;
                    let form = reqwest::multipart::Form::new().part("file", part);
                    
                    let send_res = client.post(upload_url)
                        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
                        .header("Notion-Version", notion_version)
                        .multipart(form)
                        .send()
                        .await
                        .map_err(|e| format!("Notionへの実ファイルアップロードに失敗: {}", e))?;

                    if send_res.status().is_success() {
                        upload_id_to_attach = Some(upload_id.to_string());
                    } else {
                        let text = send_res.text().await.unwrap_or_default();
                        return Err(format!("Notion File Upload Step 2 failed: {}", text));
                    }
                }
            } else {
                let status = upload_res.status();
                let err_text = upload_res.text().await.unwrap_or_default();
                return Err(format!("Notion File Upload Step 1 failed: Status={}, Body={}", status, err_text));
            }
        }
        
        // Cleanup temp file if it was compressed
        if final_image_path != image_path {
            let _ = std::fs::remove_file(&final_image_path);
        }
    }

    // STEP 3: Append Block Children
    let mut children = Vec::new();
    
    if let Some(uid) = upload_id_to_attach {
        children.push(serde_json::json!({
            "object": "block",
            "type": "image",
            "image": {
                "type": "file_upload",
                "file_upload": {
                    "id": uid
                }
            }
        }));
    }

    let rich_text = if text.is_empty() {
        vec![]
    } else {
        vec![serde_json::json!({
            "type": "text",
            "text": { "content": text }
        })]
    };

    children.push(serde_json::json!({
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": rich_text
        }
    }));

    if children.is_empty() {
        log::info!("No children to append to Notion block.");
        return Ok("".to_string());
    }

    log::info!("Appending blocks to Notion page... Total blocks: {}", children.len());
    let append_res = client.patch(format!("https://api.notion.com/v1/blocks/{}/children", page_id))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
        .header("Notion-Version", notion_version)
        .json(&serde_json::json!({
            "children": children
        }))
        .send()
        .await
        .map_err(|e| format!("Notion Append Block API呼び出し失敗: {}", e))?;

    if append_res.status().is_success() {
         let body: serde_json::Value = append_res.json().await.unwrap_or_default();
         let mut ids = Vec::new();
         if let Some(arr) = body["results"].as_array() {
             for res in arr {
                 if let Some(id) = res["id"].as_str() {
                     ids.push(id.to_string());
                 }
             }
         }
         Ok(ids.join(","))
    } else {
         let text = append_res.text().await.unwrap_or_default();
         Err(format!("Notionからエラーが返されました: {}", text))
    }
}

#[command]
async fn delete_notion_block(notion_api_token: String, block_id: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let ids: Vec<&str> = block_id.split(',').filter(|s| !s.trim().is_empty()).collect();
    
    let mut last_err = None;
    for id in ids {
        let res = client.delete(&format!("https://api.notion.com/v1/blocks/{}", id))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
            .header("Notion-Version", "2022-06-28")
            .send()
            .await;
            
        if let Err(e) = res {
            last_err = Some(e.to_string());
        }
    }

    if let Some(e) = last_err {
        Err(format!("Notion Block削除に一部失敗しました: {}", e))
    } else {
        Ok(())
    }
}

#[command]
async fn edit_notion_block(notion_api_token: String, block_id: String, text: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let ids: Vec<&str> = block_id.split(',').filter(|s| !s.trim().is_empty()).collect();
    
    // The text block is always the LAST block we appended.
    let text_block_id = ids.last().ok_or("No block ID to edit")?;
    
    let rich_text = if text.is_empty() {
        vec![]
    } else {
        vec![serde_json::json!({
            "type": "text",
            "text": { "content": text }
        })]
    };

    let res = client.patch(&format!("https://api.notion.com/v1/blocks/{}", text_block_id))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
        .header("Notion-Version", "2022-06-28")
        .json(&serde_json::json!({
            "paragraph": {
                "rich_text": rich_text
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Notion Block編集に失敗しました: {}", e))?;

    if res.status().is_success() {
        Ok(())
    } else {
        let err_text = res.text().await.unwrap_or_default();
        Err(format!("Notionからエラーが返されました: {}", err_text))
    }
}

// ─── App entry ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            update_project,
            read_file_bytes,
            save_capture_text,
            get_project_captures,
            save_text_only,
            update_capture_text,
            delete_capture_item,
            mark_discord_posted,
            post_to_discord,
            edit_discord_message,
            delete_discord_message,
            post_to_notion,
            mark_notion_posted,
            delete_notion_block,
            edit_notion_block
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
