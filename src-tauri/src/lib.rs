use serde::Serialize;
use tauri::command;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
};

#[derive(Serialize)]
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
                let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
                windows.push(WindowInfo {
                    hwnd: hwnd.0 as isize,
                    title,
                });
            }
        }
    }
    windows::core::BOOL::from(true)
}

#[command]
fn list_windows() -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window_callback), LPARAM(&mut windows as *mut _ as isize));
    }
    windows
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .invoke_handler(tauri::generate_handler![list_windows])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
