use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const NATIVE_DEEP_LINK_EVENT: &str = "openwork:deep-link-native";

static NATIVE_DEEPLINK_WEB_READY: AtomicBool = AtomicBool::new(false);
static PENDING_NATIVE_DEEPLINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn emit_native(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if NATIVE_DEEPLINK_WEB_READY.load(Ordering::SeqCst) {
        let _ = app.emit(NATIVE_DEEP_LINK_EVENT, urls);
        return;
    }
    if let Ok(mut list) = PENDING_NATIVE_DEEPLINKS.lock() {
        list.extend(urls);
    }
}

#[tauri::command]
pub fn set_native_deep_link_bridge_ready(app: AppHandle) {
    NATIVE_DEEPLINK_WEB_READY.store(true, Ordering::SeqCst);
    let mut flush: Vec<String> = Vec::new();
    if let Ok(mut list) = PENDING_NATIVE_DEEPLINKS.lock() {
        std::mem::swap(&mut flush, &mut *list);
    }
    if !flush.is_empty() {
        let _ = app.emit(NATIVE_DEEP_LINK_EVENT, flush);
    }
}
