// Reading and writing a user-chosen path (from the native open/save dialogs)
// with tauri-plugin-fs would need a blanket "**" filesystem scope, since a
// dialog-picked path isn't covered by any narrower scope. These two commands
// are a much smaller grant: plain std::fs, with io errors mapped to strings
// for the frontend to surface via the dialog plugin's message().
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
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

/// Per-window "has unsaved changes" flags, keyed by window label. Dirty
/// state lives in each window's JS (`isDirty()` in document.ts); this is
/// Rust's own copy of it, pushed from the frontend via `set_dirty` below
/// rather than pulled, since Rust has no way to reach into a webview's JS
/// state on demand. The quit flow (`advance_quit` below) needs this to know
/// *before* prompting anything whether there's anything to prompt about.
///
/// A window's entry MUST be removed when it's destroyed (see the
/// `on_window_event` handler in `run()`) — a stale `true` left behind for a
/// window that no longer exists would block quit forever with no window
/// left to show a prompt in, and a destroyed webview can't clean up after
/// itself.
struct DirtyWindows(Mutex<HashMap<String, bool>>);

/// Guards the quit flow against re-entrancy. Cmd-Q pressed a second time —
/// whether the OS just re-delivers the keystroke, or the user genuinely
/// presses it again while a dirty-window prompt from the first press is
/// still open — must not start a second walk through the dirty windows on
/// top of the first one. Reset to `false` whenever a flow ends, either by
/// finishing (`advance_quit`'s `app.exit(0)` path) or being cancelled
/// (`quit_response`'s `proceed: false` path), so an aborted quit never
/// leaves the app unable to start a new one.
struct QuitInProgress(AtomicBool);

#[tauri::command]
fn set_dirty(app: tauri::AppHandle, label: String, dirty: bool) {
  app.state::<DirtyWindows>().0.lock().unwrap().insert(label, dirty);
}

/// Reports the outcome of the unsaved-changes prompt a `menu-quit` event
/// (from `advance_quit` below) triggered in `label`'s window, and drives the
/// rest of the quit flow forward.
///
/// `proceed: false` is Cancel — abort the whole quit. Nothing else is
/// prompted and no window closes; just clear the re-entrancy guard so a
/// later Cmd-Q can start over.
///
/// `proceed: true` covers both Save (already written to disk, with the
/// document's changed state already cleared) and Don't Save (changed state
/// *also* already cleared on the frontend — see `confirmQuit` in
/// document.ts for why that matters here). Either way this window is done,
/// so its entry is marked clean right here rather than waiting on
/// `set_dirty`'s own separate `invoke()` call to arrive first: that call
/// and this one are sent in order from the same webview, but nothing
/// guarantees Rust *processes* two independent IPC calls in send order, and
/// racing that would make the quit flow's progress non-deterministic.
#[tauri::command]
fn quit_response(app: tauri::AppHandle, label: String, proceed: bool) {
  if !proceed {
    app.state::<QuitInProgress>().0.store(false, Ordering::SeqCst);
    return;
  }
  app
    .state::<DirtyWindows>()
    .0
    .lock()
    .unwrap()
    .insert(label, false);
  advance_quit(&app);
}

/// Drives the quit flow one step: finds the next dirty window (if any),
/// focuses it, and asks its frontend to run the unsaved-changes prompt.
/// Used both to start the flow (from the "quit" menu event) and to continue
/// it (from `quit_response` once a window resolves) — there's no real
/// difference between "start" and "continue" here, since both just mean
/// "find the next dirty window, or exit if there isn't one."
fn advance_quit(app: &tauri::AppHandle) {
  let next_dirty = {
    let dirty_windows = app.state::<DirtyWindows>();
    let dirty = dirty_windows.0.lock().unwrap();
    dirty.iter().find(|(_, &d)| d).map(|(label, _)| label.clone())
  };

  let Some(label) = next_dirty else {
    // Nothing left to ask about — the dirty map is genuinely empty, so
    // ExitRequested's own check (in run()'s event handler below) will see
    // that and let this exit through instead of bouncing it back here.
    app.state::<QuitInProgress>().0.store(false, Ordering::SeqCst);
    app.exit(0);
    return;
  };

  let Some(window) = app.get_webview_window(&label) else {
    // The map is stale — the window closed through some other route
    // (Close Window, the traffic light) without on_window_event's cleanup
    // having run yet, or in the gap between the lock above and here. Drop
    // the entry and move on rather than getting stuck asking about a
    // window that no longer exists.
    app.state::<DirtyWindows>().0.lock().unwrap().remove(&label);
    advance_quit(app);
    return;
  };

  // WebviewWindow::set_focus() is a plain Rust method (see window/mod.rs in
  // the tauri crate — no #[tauri::command] attribute), called directly here
  // rather than invoked from JS, so it needs no core:window:allow-set-focus
  // entry in capabilities/default.json: the ACL only gates frontend-to-
  // backend invoke() calls, the same reasoning the README's design notes
  // already give for focused_window()/emit_to() needing no capability
  // grant either. A window that can't be focused still gets the prompt —
  // emit_to below doesn't depend on set_focus succeeding. Ignoring the
  // error here, rather than aborting the whole quit, is what keeps an
  // unfocusable window from hanging the flow forever with no way to quit
  // at all.
  let _ = window.set_focus();
  let _ = app.emit_to(&label, "menu-quit", ());
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
    .title("GeekityFlow")
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
/// items (Cut/Copy/Paste, Close Window, ...) don't have this problem:
/// macOS routes them through the responder chain to the focused window on
/// its own. Custom items (New, Open, Save, Save As, Keyboard Shortcuts,
/// Quit) are routed explicitly in `on_menu_event` below, by resolving the
/// focused window and emitting *to* it specifically — Quit is the one
/// exception that doesn't resolve a focused window at all, since it may
/// need to work through *several* windows in turn; see its own doc comment
/// below and `advance_quit`.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
  // Custom item, NOT the predefined `.quit()`, even though every other
  // native item in this submenu is predefined. The predefined Quit item
  // maps to Cocoa's `sel!(terminate:)` (muda's macOS backend), which sends
  // `terminate:` straight to NSApplication — and nothing in this app, or in
  // tao underneath it, ever gets a chance to intervene first (verified
  // against tao 0.35.3's source: there is no `applicationShouldTerminate`
  // handler anywhere in it). That means Tauri's `RunEvent::ExitRequested` —
  // the hook the "just add ExitRequested + prevent_exit()" fix relies on —
  // never fires for Cmd-Q at all: the process tears down mid-edit,
  // discarding whatever's unsaved in every open window, and no amount of
  // Rust-side event handling can catch it after the fact. A *custom* item
  // does emit a menu event, routed through on_menu_event below like every
  // other custom item here, which is what keeps Cmd-Q inside code this app
  // controls. Do not "simplify" this back to `.quit()` — see the "Quit"
  // design note in README.md first.
  let quit_item = MenuItemBuilder::with_id("quit", "Quit GeekityFlow")
    .accelerator("CmdOrCtrl+Q")
    .build(app)?;

  let app_submenu = SubmenuBuilder::new(app, "GeekityFlow")
    .about(None)
    .separator()
    .services()
    .separator()
    .hide()
    .hide_others()
    .show_all()
    .separator()
    .item(&quit_item)
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

  // Modeled on Dave Winer's Drummer (drummer.land) Outliner menu, not
  // classic Mac MORE's View menu this used to mirror. Grouped the way
  // Drummer groups them: expand/collapse granularity, then the hoist
  // stack, then find.
  //
  // Find… and Find again are the only items here with accelerators
  // (CmdOrCtrl+F / CmdOrCtrl+G) — everything else is menu-only, on purpose,
  // even though MORE (and, for some of these, Drummer too) gives several
  // of these items one:
  //   - Expand / Collapse (formerly "Expand Subheads" / "Collapse
  //     Subheads"): MORE uses Cmd-, and Cmd-. respectively, but Cmd-, is
  //     already bound to `toggle-expand` in CONCORD_KEYSTROKES
  //     (packages/outliner/src/util.ts) — an accelerator here would shadow
  //     that existing outliner keystroke, so neither item gets one.
  //   - Hoist / Dehoist: MORE uses Cmd-H and Cmd--, but Cmd-H is Hide
  //     Application on modern macOS and already does that job in the
  //     GeekityFlow app menu above — reusing it here would be ambiguous, so
  //     neither Hoist nor Dehoist gets an accelerator either.
  //   - Expand All Subs (formerly "Expand All") no longer gets Cmd-E, which
  //     the old MORE-modeled menu assigned it: Drummer's own Outliner menu
  //     gives this item no accelerator at all, and mirroring Drummer means
  //     mirroring its restraint here too.
  //
  // Cmd-F and Cmd-G are safe: Cmd-F (`meta-F`) maps to `find` in
  // CONCORD_KEYSTROKES (packages/outliner/src/util.ts), but
  // keyboard.ts's `case 'find': break` is a no-op that never calls
  // preventDefault — so the accelerator was already free, and is now
  // backed by a real implementation (find.ts). Cmd-G (`meta-G`) is absent
  // from CONCORD_KEYSTROKES entirely, so it shadows nothing either.
  let expand_item = MenuItemBuilder::with_id("expand", "Expand").build(app)?;
  let expand_all_subs_item = MenuItemBuilder::with_id("expand-all-subs", "Expand All Subs").build(app)?;
  let expand_everything_item = MenuItemBuilder::with_id("expand-everything", "Expand Everything").build(app)?;
  let collapse_item = MenuItemBuilder::with_id("collapse", "Collapse").build(app)?;
  let collapse_everything_item =
    MenuItemBuilder::with_id("collapse-everything", "Collapse Everything").build(app)?;
  let hoist_item = MenuItemBuilder::with_id("hoist", "Hoist").build(app)?;
  let dehoist_item = MenuItemBuilder::with_id("dehoist", "Dehoist").build(app)?;
  let find_item = MenuItemBuilder::with_id("find", "Find…")
    .accelerator("CmdOrCtrl+F")
    .build(app)?;
  let find_again_item = MenuItemBuilder::with_id("find-again", "Find again")
    .accelerator("CmdOrCtrl+G")
    .build(app)?;

  // Drummer greys out items that don't apply to the current state (e.g.
  // Dehoist when nothing is hoisted). Reproducing that here would need a
  // frontend round trip on every cursor move just to ask "is isHoisted()
  // true right now" — skipped. hoist()/deHoist() already return false
  // harmlessly when they don't apply (see their doc comments in
  // packages/outliner/src/outliner.ts), so clicking a greyed-out-in-Drummer
  // item here is a harmless no-op instead.
  let outliner_submenu = SubmenuBuilder::new(app, "Outliner")
    .item(&expand_item)
    .item(&expand_all_subs_item)
    .item(&expand_everything_item)
    .separator()
    .item(&collapse_item)
    .item(&collapse_everything_item)
    .separator()
    .item(&hoist_item)
    .item(&dehoist_item)
    .separator()
    .item(&find_item)
    .item(&find_again_item)
    .build()?;

  // Modeled on Dave Winer's Drummer (drummer.land) Reorg menu, accelerators
  // included — this is the one custom submenu in this app that binds
  // CONCORD_KEYSTROKES accelerators at all, and that's a deliberate
  // difference from the Outliner menu above, not an inconsistency:
  //
  // On macOS the app menu gets first crack at a key equivalent, so every
  // accelerator below (Cmd-U/D/L/R, Cmd-\, Cmd-/, Cmd-[, Cmd-]) SHADOWS the
  // outliner's own keydown handling of the same keys (CONCORD_KEYSTROKES in
  // packages/outliner/src/util.ts maps them to 'reorg-up'/'reorg-down'/
  // 'reorg-left'/'reorg-right'/'toggle-comment'/'run-selection'/'promote'/
  // 'demote'). That's exactly the failure mode design note 3 in README.md
  // warns about for Edit > Undo/Select All — except here it's safe, because
  // it was checked against packages/outliner/src/keyboard.ts directly:
  // every one of those eight `case`s is a thin, unconditional wrapper
  // around the very same Outliner method this menu calls (e.g. `case
  // 'reorg-up': ... op.reorg(UP); break`, `case 'promote': ... op.promote();
  // break`) with no text-mode branching and no cursor-state guard that the
  // menu path would skip. Shadowing a call with an identical call is
  // behavior-preserving. Undo/Select All were different: a *predefined*
  // menu item there would invoke the webview's native undo/select-all
  // instead of the outliner's own, actually changing behavior — which is
  // also why the Edit menu above still must not add them.
  let reorg_move_up_item = MenuItemBuilder::with_id("reorg-move-up", "Move Up")
    .accelerator("CmdOrCtrl+U")
    .build(app)?;
  let reorg_move_down_item = MenuItemBuilder::with_id("reorg-move-down", "Move Down")
    .accelerator("CmdOrCtrl+D")
    .build(app)?;
  let reorg_move_left_item = MenuItemBuilder::with_id("reorg-move-left", "Move Left")
    .accelerator("CmdOrCtrl+L")
    .build(app)?;
  let reorg_move_right_item = MenuItemBuilder::with_id("reorg-move-right", "Move Right")
    .accelerator("CmdOrCtrl+R")
    .build(app)?;
  let reorg_toggle_comment_item = MenuItemBuilder::with_id("reorg-toggle-comment", "Toggle comment")
    .accelerator("CmdOrCtrl+\\")
    .build(app)?;
  let reorg_run_selection_item = MenuItemBuilder::with_id("reorg-run-selection", "Run selection")
    .accelerator("CmdOrCtrl+/")
    .build(app)?;
  let reorg_delete_line_item = MenuItemBuilder::with_id("reorg-delete-line", "Delete Line").build(app)?;
  let reorg_promote_item = MenuItemBuilder::with_id("reorg-promote", "Promote")
    .accelerator("CmdOrCtrl+[")
    .build(app)?;
  let reorg_demote_item = MenuItemBuilder::with_id("reorg-demote", "Demote")
    .accelerator("CmdOrCtrl+]")
    .build(app)?;
  let reorg_sort_item = MenuItemBuilder::with_id("reorg-sort", "Sort").build(app)?;

  let reorg_submenu = SubmenuBuilder::new(app, "Reorg")
    .item(&reorg_move_up_item)
    .item(&reorg_move_down_item)
    .item(&reorg_move_left_item)
    .item(&reorg_move_right_item)
    .separator()
    .item(&reorg_toggle_comment_item)
    .item(&reorg_run_selection_item)
    .separator()
    .item(&reorg_delete_line_item)
    .separator()
    .item(&reorg_promote_item)
    .item(&reorg_demote_item)
    .separator()
    .item(&reorg_sort_item)
    .build()?;

  MenuBuilder::new(app)
    .item(&app_submenu)
    .item(&file_submenu)
    .item(&edit_submenu)
    .item(&outliner_submenu)
    .item(&reorg_submenu)
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
      app.manage(DirtyWindows(Mutex::new(HashMap::new())));
      app.manage(QuitInProgress(AtomicBool::new(false)));

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

        // Quit doesn't act on "the document the user is looking at" either
        // — it may need to work through *several* dirty windows in turn,
        // not just the focused one, so it's handled by advance_quit
        // instead of falling into the focused-window branch below. See the
        // "quit" MenuItemBuilder's doc comment in build_menu for why this
        // is a custom item at all.
        if id == "quit" {
          let quitting = app.state::<QuitInProgress>();
          if quitting.0.swap(true, Ordering::SeqCst) {
            // A quit flow is already in progress — e.g. Cmd-Q pressed
            // twice in a row, or again while a dirty-window prompt from
            // the first press is still open. Let that flow finish instead
            // of stacking a second one on top of it.
            return;
          }
          advance_quit(app);
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
          // Outliner menu — same routing rationale as above: these
          // read/mutate one document's outliner state (expansion, hoist
          // stack, search), so they must land on just the focused window's
          // label, never broadcast.
          "expand" => {
            let _ = app.emit_to(label, "menu-expand", ());
          }
          "expand-all-subs" => {
            let _ = app.emit_to(label, "menu-expand-all-subs", ());
          }
          "expand-everything" => {
            let _ = app.emit_to(label, "menu-expand-everything", ());
          }
          "collapse" => {
            let _ = app.emit_to(label, "menu-collapse", ());
          }
          "collapse-everything" => {
            let _ = app.emit_to(label, "menu-collapse-everything", ());
          }
          "hoist" => {
            let _ = app.emit_to(label, "menu-hoist", ());
          }
          "dehoist" => {
            let _ = app.emit_to(label, "menu-dehoist", ());
          }
          "find" => {
            let _ = app.emit_to(label, "menu-find", ());
          }
          "find-again" => {
            let _ = app.emit_to(label, "menu-find-again", ());
          }
          // Reorg menu — same focused-window-only routing as the Outliner
          // menu above; see build_menu's reorg_submenu doc comment for why
          // these are the one submenu here that binds accelerators that
          // shadow the outliner's own keydown handling.
          "reorg-move-up" => {
            let _ = app.emit_to(label, "menu-reorg-move-up", ());
          }
          "reorg-move-down" => {
            let _ = app.emit_to(label, "menu-reorg-move-down", ());
          }
          "reorg-move-left" => {
            let _ = app.emit_to(label, "menu-reorg-move-left", ());
          }
          "reorg-move-right" => {
            let _ = app.emit_to(label, "menu-reorg-move-right", ());
          }
          "reorg-toggle-comment" => {
            let _ = app.emit_to(label, "menu-reorg-toggle-comment", ());
          }
          "reorg-run-selection" => {
            let _ = app.emit_to(label, "menu-reorg-run-selection", ());
          }
          "reorg-delete-line" => {
            let _ = app.emit_to(label, "menu-reorg-delete-line", ());
          }
          "reorg-promote" => {
            let _ = app.emit_to(label, "menu-reorg-promote", ());
          }
          "reorg-demote" => {
            let _ = app.emit_to(label, "menu-reorg-demote", ());
          }
          "reorg-sort" => {
            let _ = app.emit_to(label, "menu-reorg-sort", ());
          }
          _ => {}
        }
      });

      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    // Registered once here, on the Builder, so it covers every window this
    // app ever creates — including ones spawned later by New/Open — not
    // just whatever exists at startup.
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        // See DirtyWindows's doc comment: a stale `true` left behind for a
        // window that no longer exists would block quit forever with no
        // window left to prompt in, and a destroyed webview can't clean up
        // after itself — so this has to happen here, not in the frontend.
        window.state::<DirtyWindows>().0.lock().unwrap().remove(window.label());
      }
    })
    .invoke_handler(tauri::generate_handler![
      read_file,
      write_file,
      open_path_in_new_window,
      set_dirty,
      quit_response
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // The other two-thirds of the Cmd-Q fix (see the "quit" item's doc
      // comment in build_menu for the first third). `.run(context)` alone
      // never surfaces ExitRequested at all; `.build(context)?.run(handler)`
      // is what makes it observable, letting `api.prevent_exit()` below
      // stop an exit that would otherwise discard unsaved changes.
      //
      // `code: None` is an exit "requested by user interaction" — in
      // practice here, the OS-driven "last window closed" exit, since
      // Quit itself never reaches the OS anymore (it's the custom item
      // above). By the time that fires, the closing window's own guard
      // (`onCloseRequested` in main.ts) has already prompted if needed,
      // and this crate's on_window_event Destroyed handler above has
      // already dropped that window's entry — so checking the dirty map
      // here is correct for both Cmd-Q *and* the last-window-close case.
      //
      // `code: Some(_)` is a *programmatic* exit — the only one this crate
      // ever triggers is advance_quit's `app.exit(0)`, which only runs once
      // the dirty map is confirmed empty. Skipping the dirty check entirely
      // for Some(_) is what keeps that call from deadlocking against this
      // very handler: prevent_exit() firing on our own already-verified
      // exit would leave the app unquittable.
      if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if code.is_none() {
          // Only a dirty window that STILL EXISTS may veto the exit. The
          // map alone isn't safe to trust here: this fires on the
          // last-window-closed path, and it would be a bet on Destroyed
          // being delivered before ExitRequested that the entry for the
          // window that just closed is already gone. Lose that bet and
          // prevent_exit() fires with no windows left to prompt in — an
          // invisible process the user can only end from Activity Monitor,
          // which is a worse failure than the data loss this whole flow
          // exists to prevent. Cross-checking against the live window list
          // makes the outcome independent of that ordering.
          let dirty_windows = app.state::<DirtyWindows>();
          let dirty = dirty_windows.0.lock().unwrap();
          let any_live_dirty = dirty
            .iter()
            .any(|(label, &d)| d && app.get_webview_window(label).is_some());
          if any_live_dirty {
            api.prevent_exit();
          }
        }
      }
    });
}
