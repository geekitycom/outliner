// Reading and writing a user-chosen path (from the native open/save dialogs)
// with tauri-plugin-fs would need a blanket "**" filesystem scope, since a
// dialog-picked path isn't covered by any narrower scope. These two commands
// are a much smaller grant: plain std::fs, with io errors mapped to strings
// for the frontend to surface via the dialog plugin's message().
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Manager, WebviewUrl};

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
  std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Monotonic counter for new window labels ("win-1", "win-2", ...). Tauri
/// window labels must be unique; "main" is already taken by the window
/// declared in tauri.conf.json, so this starts at 1 rather than 0 to keep
/// generated labels visually distinct from it.
struct WindowCounter(AtomicU32);

impl WindowCounter {
  fn next_label(&self) -> String {
    format!("win-{}", self.0.fetch_add(1, Ordering::SeqCst))
  }
}

/// Opens `path` in a brand-new window. This is a command (rather than
/// something Rust decides on its own, the way File > New does) because
/// *whether* to open a new window at all is Open's call, not New's: Open
/// reuses the current window when it's a blank, untouched Untitled
/// document, and only the frontend (document.ts) knows that dirty/path
/// state. Rust's job here is just spawning the window once the frontend
/// has already decided one is needed.
#[tauri::command]
fn open_path_in_new_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
  create_document_window(&app, Some(&path)).map_err(|e| e.to_string())
}

/// Finds whichever webview window currently has OS focus.
///
/// `Manager::get_focused_window` would do this in one call, but it's gated
/// behind tauri's `unstable` feature, which this crate doesn't enable — so
/// this scans the (usually tiny) set of open windows instead. `is_focused`
/// is a plain Rust method, not an IPC command, so it needs no capability
/// grant.
fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
  app
    .webview_windows()
    .into_values()
    .find(|w| w.is_focused().unwrap_or(false))
}

/// Creates a new document window, optionally pre-loaded with `path`.
///
/// `path` travels in the URL's query string (`index.html?path=...`)
/// instead of as an event fired after the window is created: an event
/// could reach the new window before its frontend has called `listen()`,
/// silently dropping it. The query string has no such race — `main.ts`
/// reads it synchronously at boot via `location.search`, before anything
/// else runs.
fn create_document_window(app: &tauri::AppHandle, path: Option<&str>) -> tauri::Result<()> {
  let label = app.state::<WindowCounter>().next_label();
  let url = match path {
    Some(p) => format!("index.html?path={}", utf8_percent_encode(p, NON_ALPHANUMERIC)),
    None => "index.html".to_string(),
  };
  WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
    .title("Outliner")
    .inner_size(900.0, 700.0)
    .build()?;
  Ok(())
}

/// Builds the app-wide menu. This lives in Rust, not JS: a JS menu's
/// `action` callbacks run in the webview that *created* the menu, which
/// with several windows open is the wrong window for anything document-
/// specific (Save would save whichever document happened to build the
/// menu, not the focused one) — and once that window closes, its JS
/// context is gone and the menu stops working at all. Native predefined
/// items (Cut/Copy/Paste, Close Window, Quit, ...) don't have this
/// problem: macOS routes them through the responder chain to the focused
/// window on its own. Custom items (New, Open, Save, Save As, Keyboard
/// Shortcuts) are routed explicitly in `on_menu_event` below, by resolving
/// the focused window and emitting *to* it specifically.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
  let app_submenu = SubmenuBuilder::new(app, "Outliner")
    .about(None)
    .separator()
    .services()
    .separator()
    .hide()
    .hide_others()
    .show_all()
    .separator()
    .quit()
    .build()?;

  // Cmd-N/O/S/Shift-S are all safe accelerators: they're absent from
  // CONCORD_KEYSTROKES (packages/outliner/src/util.ts), so the outliner's
  // keydown handler falls into its `default:` branch and never calls
  // preventDefault. Nothing here shadows an outliner keystroke.
  let new_item = MenuItemBuilder::with_id("new", "New")
    .accelerator("CmdOrCtrl+N")
    .build(app)?;
  let open_item = MenuItemBuilder::with_id("open", "Open…")
    .accelerator("CmdOrCtrl+O")
    .build(app)?;
  let save_item = MenuItemBuilder::with_id("save", "Save")
    .accelerator("CmdOrCtrl+S")
    .build(app)?;
  let save_as_item = MenuItemBuilder::with_id("save-as", "Save As…")
    .accelerator("CmdOrCtrl+Shift+S")
    .build(app)?;

  let file_submenu = SubmenuBuilder::new(app, "File")
    .item(&new_item)
    .item(&open_item)
    .separator()
    .item(&save_item)
    .item(&save_as_item)
    .separator()
    // Predefined rather than a custom item routed through on_menu_event:
    // see build_menu's doc comment above for why native items can target
    // the focused window without any Rust-side routing. Its accelerator
    // (Cmd-W) is absent from CONCORD_KEYSTROKES too.
    .close_window()
    .build()?;

  // Cut/Copy/Paste ONLY — do not add Undo or Select All here. On macOS the
  // app menu gets first crack at a key equivalent, and both Cmd-Z (`undo`)
  // and Cmd-A (`select-all`) are captured with preventDefault() by the
  // outliner's own keyboard handler (packages/outliner/src/keyboard.ts). A
  // predefined Undo or SelectAll item here would silently steal those
  // keystrokes before the outliner ever sees them, breaking its own
  // undo/select-all. Cut/Copy/Paste are the opposite case: keyboard.ts's
  // `case 'cut'` only preventDefaults when the line is empty, and `case
  // 'copy': case 'paste': break` never does — both deliberately fall
  // through to WKWebView's native clipboard handling, which needs these
  // menu items present to work at all.
  let edit_submenu = SubmenuBuilder::new(app, "Edit").cut().copy().paste().build()?;

  // No accelerator. The obvious Cmd-/ is already bound to `run-selection`
  // in the outliner (CONCORD_KEYSTROKES) — giving this item Cmd-/ would
  // shadow that keystroke the same way an Edit-menu Undo would shadow
  // Cmd-Z.
  let shortcuts_item = MenuItemBuilder::with_id("keyboard-shortcuts", "Keyboard Shortcuts").build(app)?;
  let help_submenu = SubmenuBuilder::new(app, "Help").item(&shortcuts_item).build()?;

  MenuBuilder::new(app)
    .item(&app_submenu)
    .item(&file_submenu)
    .item(&edit_submenu)
    .item(&help_submenu)
    .build()
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

      app.manage(WindowCounter(AtomicU32::new(1)));

      let menu = build_menu(app.handle())?;
      app.set_menu(menu)?;

      app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();

        // New has no per-document state to read, so it's handled entirely
        // here with no round trip to any frontend — and unlike the items
        // below, it doesn't depend on a window being focused at all.
        if id == "new" {
          if let Err(err) = create_document_window(app, None) {
            log::error!("failed to open new window: {err}");
          }
          return;
        }

        // Everything else acts on "the document the user is looking at",
        // so resolve the focused window. If nothing is focused there's no
        // document to act on.
        let Some(window) = focused_window(app) else {
          return;
        };
        let label = window.label().to_string();

        // These act on a specific document's state (dirty flag, current
        // path, outliner contents), which only that window's frontend
        // knows. emit_to (never plain emit) targets just the focused
        // window's label — a broadcast emit would fire in every open
        // window at once, e.g. saving every open document simultaneously
        // when the user meant to save just the one in front of them.
        match id {
          "open" => {
            let _ = app.emit_to(label, "menu-open", ());
          }
          "save" => {
            let _ = app.emit_to(label, "menu-save", ());
          }
          "save-as" => {
            let _ = app.emit_to(label, "menu-save-as", ());
          }
          "keyboard-shortcuts" => {
            let _ = app.emit_to(label, "menu-keyboard-shortcuts", ());
          }
          _ => {}
        }
      });

      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      read_file,
      write_file,
      open_path_in_new_window
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
