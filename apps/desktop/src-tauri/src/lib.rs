// Reading and writing a user-chosen path (from the native open/save dialogs)
// with tauri-plugin-fs would need a blanket "**" filesystem scope, since a
// dialog-picked path isn't covered by any narrower scope. These two commands
// are a much smaller grant: plain std::fs, with io errors mapped to strings
// for the frontend to surface via the dialog plugin's message().
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
  std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![read_file, write_file])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
