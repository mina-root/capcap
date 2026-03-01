use serde::Serialize;
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
        .invoke_handler(tauri::generate_handler![list_windows, capture_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
