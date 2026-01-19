mod commands;
mod config;
mod engine;
mod fs;
mod opkg;
mod paths;
mod platform;
mod types;
mod updater;
mod utils;
mod workspace;

pub use types::*;

use commands::config::{read_opencode_config, write_opencode_config};
use commands::engine::{engine_doctor, engine_info, engine_install, engine_start, engine_stop};
use commands::http::http_request;
use commands::misc::{reset_opencode_cache, reset_openwork_state};
use commands::opkg::{import_skill, opkg_install};
use commands::updater::updater_environment;
use commands::workspace::{
  workspace_add_authorized_root,
  workspace_bootstrap,
  workspace_create,
  workspace_openwork_read,
  workspace_openwork_write,
  workspace_set_active,
  workspace_template_delete,
  workspace_template_write,
};
use engine::manager::EngineManager;

pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init());

  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build());

  builder
    .manage(EngineManager::default())
    .invoke_handler(tauri::generate_handler![
      engine_start,
      engine_stop,
      engine_info,
      engine_doctor,
      engine_install,
      http_request,
      workspace_bootstrap,
      workspace_set_active,
      workspace_create,
      workspace_add_authorized_root,
      workspace_template_write,
      workspace_template_delete,
      workspace_openwork_read,
      workspace_openwork_write,
      opkg_install,
      import_skill,
      read_opencode_config,
      write_opencode_config,
      updater_environment,
      reset_openwork_state,
      reset_opencode_cache
    ])
    .run(tauri::generate_context!())
    .expect("error while running OpenWork");
}
