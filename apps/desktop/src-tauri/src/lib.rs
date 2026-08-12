// Reading and writing a user-chosen path (from the native open/save dialogs)
// with tauri-plugin-fs would need a blanket "**" filesystem scope, since a
// dialog-picked path isn't covered by any narrower scope. These two commands
// are a much smaller grant: plain std::fs, with io errors mapped to strings
// for the frontend to surface via the dialog plugin's message().
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;

// The Quit/Close Window state machine, as plain values with no `tauri` in
// sight — see flow.rs's own module comment for why that seam exists. What is
// left in this file for those two flows is an adapter: it reads the world
// (the dirty map, the live window labels), asks `flow::advance` what to do,
// and carries out the `Step`s it hands back. It decides nothing itself.
mod flow;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Manager, WebviewUrl};

// Native window tabs (grouping windows into one tab bar) has no tao/Tauri
// API of its own — see the "why native tabs needed raw AppKit" design note
// in README.md. `group_as_tab`, `tab_group_labels`, and `SendableNsWindow`
// below are the only places this crate touches AppKit directly.
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowOrderingMode};

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

/// Per-window "has unsaved changes" flags, keyed by window label — one
/// entry per *tab* now that each tab is its own native window (see the
/// "Multi-window" section of README.md). Dirty state lives in each
/// window's JS (`isDirty()` in document.ts); this is Rust's own copy of
/// it, pushed from the frontend via `set_dirty` below rather than pulled,
/// since Rust has no way to reach into a webview's JS state on demand.
/// Both flows in flow.rs (Quit, and Close Window's tab-group walk) need this
/// to know *before* prompting anything whether there's anything to prompt
/// about; `windows_snapshot` below is what hands it to them.
///
/// A window's entry MUST be removed when it's destroyed (see the
/// `on_window_event` handler in `run()`) — a stale `true` left behind for a
/// window that no longer exists would block a flow forever with no window
/// left to show a prompt in, and a destroyed webview can't clean up after
/// itself. `flow::Windows` survives such an entry (it ignores any label that
/// isn't live, and asks for it to be forgotten), but that is a backstop for
/// the gap before `Destroyed` arrives, not a reason to skip the cleanup:
/// without it the map grows an entry per window ever opened.
struct DirtyWindows(Mutex<HashMap<String, bool>>);

/// Which multi-window flow, if any, is currently walking windows one at a
/// time asking about unsaved changes. Nothing but storage: what the states
/// mean, when one may start, and when it ends all live in `flow.rs`, which
/// owns the `Flow` type this holds. Every write to this slot is an
/// `Outcome::pending` handed back by `flow::advance` and assigned verbatim
/// by `run_flow` below — this file never decides what should be in here,
/// including on the paths where the answer is "the same thing as before".
struct PendingFlow(Mutex<Option<flow::Flow>>);

/// A raw AppKit object pointer, made `Send` so it can travel into the
/// `run_on_main_thread` closures in `group_as_tab`/`tab_group_labels`
/// below. Sound because only the pointer *value* crosses threads — no
/// different from sending a `usize` — and it is never dereferenced
/// anywhere except inside a closure `run_on_main_thread` has already
/// routed onto the main thread, the only thread AppKit objects are safe to
/// actually use from.
#[cfg(target_os = "macos")]
struct SendableNsWindow(*mut std::ffi::c_void);
#[cfg(target_os = "macos")]
unsafe impl Send for SendableNsWindow {}
#[cfg(target_os = "macos")]
impl SendableNsWindow {
  // A method, not a public field: closures below capture by the paths they
  // actually use (Rust's "disjoint capture" rules), so reading `.0`
  // directly inside a `run_on_main_thread` closure would capture just that
  // raw-pointer *field* rather than the whole `SendableNsWindow` — silently
  // losing the `unsafe impl Send` above, since `*mut c_void` alone isn't
  // Send. Going through a method call forces capture of the whole value.
  fn ptr(&self) -> *mut std::ffi::c_void {
    self.0
  }
}

/// Per-window (per-tab) cache of which native `NSWindowTabGroup` each
/// window was last observed to belong to, keyed by window label — storing
/// the group object's own pointer address as a plain `usize`, not the
/// `Retained<NSWindowTabGroup>` itself, which is why this can be a plain
/// `Mutex<HashMap<...>>` like `DirtyWindows`/`PendingFlow` above with no
/// `SendableNsWindow`-style newtype needed for the map (only the one-shot
/// trip into `run_on_main_thread` needs that).
///
/// This is NOT a source of truth for group *membership* — `tab_group_labels`
/// still queries AppKit's `tabbedWindows` fresh every time for that, never
/// this map (see its own doc comment for why). This map exists purely as a
/// change-detector for `assert_tab_bar_visible_on_focus` below: it's what
/// lets that handler tell "the user refocused a window whose group hasn't
/// changed since last time" (skip — a deliberate View > Hide Tab Bar since
/// then must be respected) apart from "this window is in a materially
/// different group than last observed" (reassert) — see the "don't fight
/// the user" design note in README.md.
#[cfg(target_os = "macos")]
struct TabGroupSeen(Mutex<HashMap<String, usize>>);

#[tauri::command]
fn set_dirty(app: tauri::AppHandle, label: String, dirty: bool) {
  app.state::<DirtyWindows>().0.lock().unwrap().insert(label, dirty);
}

/// Reports the outcome of the unsaved-changes prompt that a `Step::Prompt`
/// triggered in `label`'s window, and drives whichever flow is running
/// forward. Shared by Quit and Close Window rather than each having its own
/// near-identical command: the two differ only in what the machine decides
/// to do next, and that decision is in flow.rs.
///
/// `proceed: false` is Cancel. `proceed: true` covers both Save (already
/// written to disk, with the document's changed state already cleared) and
/// Don't Save — which for Quit *also* clears the frontend's changed state
/// (see `confirmQuit` in document.ts), the honest-state property the
/// eventual `Step::Exit` depends on.
#[tauri::command]
fn flow_response(app: tauri::AppHandle, label: String, proceed: bool) {
  run_flow(
    &app,
    flow::Input::Resolved {
      label,
      response: if proceed {
        flow::Response::Proceed
      } else {
        flow::Response::Cancel
      },
    },
  );
}

/// The world as `flow::advance` needs to see it: this app's own dirty map,
/// intersected with the windows that actually exist right now.
///
/// Both halves are read here, in one place, at one moment — the labels come
/// from `webview_windows()` rather than being looked up one at a time as the
/// machine goes, so there is no window for a window to vanish *between* two
/// of the machine's own decisions. See `flow::Windows` for why that
/// intersection is the whole of this flow's staleness handling.
fn windows_snapshot(app: &tauri::AppHandle) -> flow::Windows {
  let dirty = app.state::<DirtyWindows>().0.lock().unwrap().clone();
  let live: Vec<String> = app.webview_windows().into_keys().collect();
  flow::Windows::new(&dirty, &live)
}

/// The adapter: hand an input to the state machine, store the flow state it
/// hands back, carry out the steps it asks for. Every Quit and Close Window
/// decision this app makes goes through this one function, and none of them
/// is made *in* it — there is no policy below this line, only effects.
///
/// The lock on `PendingFlow` is taken for the decision and released before
/// any step runs. A step re-entering this function while that lock was held
/// would deadlock the app on its own quit — and `Step::Exit` does exactly
/// that kind of re-entering, via `RunEvent::ExitRequested`.
///
/// The one place both locks are held at once is the `windows_snapshot` call
/// inside that block, which takes `DirtyWindows` while holding
/// `PendingFlow`. Nothing anywhere takes them in the other order — every
/// other reader of the dirty map (`set_dirty`, the `Destroyed` cleanup, the
/// `ExitRequested` check, and the step arms below) touches only that one —
/// so the ordering can't invert into a deadlock. Keep it that way.
fn run_flow(app: &tauri::AppHandle, input: flow::Input) {
  let steps = {
    let pending = app.state::<PendingFlow>();
    let mut guard = pending.0.lock().unwrap();
    let outcome = flow::advance(guard.as_ref(), input, &windows_snapshot(app));
    // Assigned verbatim: which flow is pending afterwards is the machine's
    // answer, on every path, including "the same one as before".
    *guard = outcome.pending;
    outcome.steps
  };

  // An observation to report back once the steps are done — see the `Prompt`
  // arm. Collected rather than acted on in place because feeding it in means
  // re-entering this function, and doing that from inside the loop would run
  // the rest of these steps *after* the machine had already moved on from
  // them. Fed in below, once the loop is over and nothing is in flight.
  let mut observed: Option<flow::Input> = None;

  for step in steps {
    match step {
      flow::Step::Forget { label } => {
        app.state::<DirtyWindows>().0.lock().unwrap().remove(&label);
      }
      flow::Step::MarkClean { label } => {
        app.state::<DirtyWindows>().0.lock().unwrap().insert(label, false);
      }
      flow::Step::Prompt { label, event } => {
        // set_focus() is a plain Rust method (see window/mod.rs in the tauri
        // crate — no #[tauri::command] attribute), called directly here
        // rather than invoked from JS, so it needs no
        // core:window:allow-set-focus entry in capabilities/default.json:
        // the ACL only gates frontend-to-backend invoke() calls, the same
        // reasoning the README's design notes give for focused_window() and
        // emit_to() needing no grant either.
        //
        // Both errors are ignored on purpose. A window that can't be focused
        // still gets its prompt, and aborting the flow on either would leave
        // an unfocusable window hanging the whole thing with no way to quit
        // at all.
        //
        // emit_to the one label, NEVER a broadcast emit: that would run the
        // unsaved-changes prompt in every open window at once instead of the
        // one whose turn it is.
        //
        // The liveness re-check is the one thing in this arm that is not
        // simply "do as told". The machine decided from a `Windows` snapshot
        // read at the top of this function, and the user can close a window
        // at any moment after that — including in the gap between that
        // decision and this line. Emitting into the gap is silent: `emit_to`
        // an unknown label is not an error worth reporting, no answer ever
        // comes back, `PendingFlow` stays `Some`, and the re-entrancy guard
        // then correctly refuses every later Cmd-Q. The app becomes
        // unquittable from its own menu with nothing on screen to explain it
        // — the same failure class design note 8 exists to prevent.
        //
        // So: no window, no emit, and report `Vanished` instead. Note the
        // shape of that — this arm decides nothing about what a dead target
        // means for the flow. It reports an observation; `flow::advance`
        // decides that the walk steps over it and carries on. Anything more
        // opinionated here (say, quietly moving to the next dirty window)
        // would be policy in the adapter, which is exactly what the flow.rs
        // seam exists to prevent.
        match app.get_webview_window(&label) {
          Some(window) => {
            let _ = window.set_focus();
            let _ = app.emit_to(&label, event, ());
          }
          None => observed = Some(flow::Input::Vanished { label }),
        }
      }
      flow::Step::Destroy { label } => {
        // Gone already is a fine outcome for "close this window" — the
        // machine was told what existed when it decided, and a window that
        // slipped away since needs nothing done to it.
        if let Some(window) = app.get_webview_window(&label) {
          let _ = window.destroy();
        }
      }
      flow::Step::Exit => {
        // This re-triggers RunEvent::ExitRequested, which re-checks the
        // dirty state through `windows_snapshot` above — see the handler in
        // run(). It passes because the machine only emits this step when
        // that same check already came back clean, not because anything
        // waved it through.
        app.exit(0);
      }
    }
  }

  // Re-entering with what the emit above could not do. Safe to recurse: the
  // `PendingFlow` lock was released before the step loop began (see this
  // function's doc comment), and each pass either delivers a prompt, reaches
  // a terminal step, or removes one more dead window from consideration — so
  // the depth is bounded by the number of windows that died in the gap, and
  // in practice is one.
  if let Some(input) = observed {
    run_flow(app, input);
  }
}

/// Opens `path` as a new tab, grouped into the tab bar of the window that
/// invoked this command (see `group_as_tab`). This is a command (rather
/// than something Rust decides on its own, the way File > New does)
/// because *whether* to open a new tab at all is Open's call, not New's:
/// Open reuses the current tab when it's a blank, untouched Untitled
/// document, and only the frontend (document.ts) knows that dirty/path
/// state. Rust's job here is just spawning the tab, grouped with the
/// window that asked for it, once the frontend has already decided one is
/// needed.
///
/// `window` is resolved by Tauri from the invoking webview itself (see the
/// `CommandArg` impl for `WebviewWindow` in the tauri crate), not
/// `focused_window(app)` — the two are normally the same window, but only
/// the former is guaranteed to still be accurate by the time this async
/// command actually runs, after the native Open dialog awaited in
/// `openDocument()` (document.ts) has already closed.
#[tauri::command]
fn open_path_in_new_tab(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
  create_document_window(&app, Some(&path), Some(&window)).map_err(|e| e.to_string())
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

/// Creates a new document window/tab, optionally pre-loaded with `path`,
/// and optionally grouped as a new tab in `group_with`'s tab group.
///
/// `group_with: None` starts a brand-new tab group (File > New Window) —
/// the window still gets `tabbing_identifier` below (on macOS, the only
/// platform with native window tabs at all), so the user (or macOS
/// itself, per its own "Prefer tabs when opening documents" setting) can
/// still merge it into another group later; nothing here does that
/// automatically for a standalone window.
/// `group_with: Some(window)` adds the new window as a tab in `window`'s
/// group (File > New, and File > Open when the invoking tab isn't a
/// reusable blank — see `open_path_in_new_tab` and `openDocument()` in
/// document.ts).
///
/// `path` travels in the URL's query string (`index.html?path=...`)
/// instead of as an event fired after the window is created: an event
/// could reach the new window before its frontend has called `listen()`,
/// silently dropping it. The query string has no such race — `main.ts`
/// reads it synchronously at boot via `location.search`, before anything
/// else runs.
fn create_document_window(
  app: &tauri::AppHandle,
  path: Option<&str>,
  group_with: Option<&tauri::WebviewWindow>,
) -> tauri::Result<()> {
  let label = app.state::<WindowCounter>().next_label();
  let url = match path {
    Some(p) => format!("index.html?path={}", utf8_percent_encode(p, NON_ALPHANUMERIC)),
    None => "index.html".to_string(),
  };
  let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
    .title("GeekityFlow")
    .inner_size(900.0, 700.0);

  // DO NOT fold this back into the chain above. `tabbing_identifier` is
  // `#[cfg(target_os = "macos")]` in the tauri crate — native window tabs
  // are an AppKit concept and no such method exists on Linux/Windows — so a
  // chained call is a hard compile error off macOS ("no method named
  // `tabbing_identifier` found for struct `WebviewWindowBuilder`"). An
  // attribute cannot be attached to one call in the middle of a method
  // chain, only to a whole statement, which is the entire reason the chain
  // is broken in two here and the builder rebound by a cfg-gated `let`.
  // It looks like ordinary Tauri API rather than the raw AppKit everything
  // else in this file guards, which is exactly how it stayed unguarded until
  // CI first ran cargo on Linux.
  //
  // What it buys, on the platform that has it: it makes every document
  // window *eligible* for the system's own tab affordances (drag-to-merge,
  // Merge All Windows, "Prefer tabs when opening documents") even when
  // group_with is None below. It is not what actually groups anything — see
  // the "why native tabs needed raw AppKit" design note in README.md for why
  // *explicit* grouping (group_as_tab) is still needed on top of this rather
  // than relying on tabbing_identifier alone. Elsewhere there is nothing to
  // be eligible for: group_as_tab's own non-macOS twin below is already a
  // no-op, and "New"/"Open"'s new tab is just an ordinary new window.
  #[cfg(target_os = "macos")]
  let builder = builder.tabbing_identifier("com.geekity.flow.document");

  let window = builder.build()?;

  if let Some(target) = group_with {
    group_as_tab(app, target, &window);
  }

  // Force this window's tab bar visible even though it's a lone tab (in a
  // brand-new group when group_with is None, or the newest tab in
  // target's group otherwise) — see assert_tab_bar_visible's doc comment
  // for why macOS's default auto-hide behavior here is a real bug, not
  // just cosmetic.
  #[cfg(target_os = "macos")]
  if let Ok(ptr) = window.ns_window() {
    assert_tab_bar_visible(app, ptr);
  }

  Ok(())
}

/// Adds `new_window` to `target`'s native tab group via AppKit's
/// `addTabbedWindow:ordered:` — tao/Tauri expose no such API themselves
/// (see the "why native tabs needed raw AppKit" design note in README.md),
/// so this drops to objc2 directly. `target`/`new_window` both already have
/// resolved `ns_window()` handles by the time this runs, since `build()`
/// has already returned for both.
///
/// Must run on the main thread — AppKit is not thread-safe — which is why
/// the actual message send happens inside `run_on_main_thread` rather than
/// directly in this function's body: `create_document_window` (and so this
/// function) can be reached from a `#[tauri::command]`
/// (`open_path_in_new_tab`), and Tauri does not guarantee commands run on
/// the main thread, as well as from the menu-event handler, which in
/// practice already does run there (see `close_window_group`'s doc comment)
/// but which this doesn't rely on. `run_on_main_thread` itself runs the
/// closure immediately, in place, when it's already called from the main
/// thread (checked in tauri-runtime-wry's `send_user_message`), so this has
/// no async delay in the common case — but the point of routing through it
/// is exactly to not have to know or care which case applies.
#[cfg(target_os = "macos")]
fn group_as_tab(app: &tauri::AppHandle, target: &tauri::WebviewWindow, new_window: &tauri::WebviewWindow) {
  let (Ok(target_ptr), Ok(new_ptr)) = (target.ns_window(), new_window.ns_window()) else {
    return;
  };
  let target_ptr = SendableNsWindow(target_ptr);
  let new_ptr = SendableNsWindow(new_ptr);
  let _ = app.run_on_main_thread(move || {
    // SAFETY: both pointers came from Tauri's own `ns_window()`, which
    // returns the window's live NSWindow* for as long as the window
    // exists — true here, since both windows are kept alive by this
    // closure's own captures for the duration of the call. Casting a
    // valid, correctly-typed Objective-C object pointer to `&NSWindow` and
    // sending it `addTabbedWindow:ordered:` (a normal AppKit message, and
    // one that doesn't mutate anything Rust owns) mirrors the pattern
    // Tauri's own docs use for `ns_window()` itself (see `with_webview`'s
    // example in the tauri crate's webview module). Now definitely on the
    // main thread (see this function's own doc comment), so safe to touch
    // AppKit at all.
    let target_ns: &NSWindow = unsafe { &*target_ptr.ptr().cast() };
    let new_ns: &NSWindow = unsafe { &*new_ptr.ptr().cast() };
    target_ns.addTabbedWindow_ordered(new_ns, NSWindowOrderingMode::Above);
  });
}

#[cfg(not(target_os = "macos"))]
fn group_as_tab(_app: &tauri::AppHandle, _target: &tauri::WebviewWindow, _new_window: &tauri::WebviewWindow) {
  // Native window tabs are a macOS concept; elsewhere "New"/"Open"'s "new
  // tab" is just an ordinary new window, so there's nothing to group.
}

/// Shows the tab bar for the window behind `ns_window_ptr` if it's
/// currently hidden — the same effect as the user choosing "Show Tab Bar"
/// (View menu on apps that have one; here, only reachable by right-
/// clicking the tab bar itself or Cmd-Shift-\, since this app has no View
/// menu). macOS auto-hides the tab bar whenever a group has only one
/// window, which is the actual bug this exists to work around: with the
/// bar hidden there's nothing to drag a tab to or from, making it
/// impossible to merge a lone window into another group (or receive one)
/// by dragging. See the "don't auto-hide the tab bar" design note in
/// README.md.
///
/// Always checks `isTabBarVisible()` first and only calls `toggleTabBar:`
/// when it's false — `toggleTabBar:` *toggles*, so calling it
/// unconditionally on a window whose bar is already showing would hide
/// it. A no-op if `tabGroup()` is nil, which the doc comment on the
/// generated binding itself calls "lazily created on demand" — observed
/// here to still be reliably non-nil immediately after
/// `WebviewWindowBuilder::build()` returns (this app's windows are shown
/// immediately on creation, never built with `.visible(false)`), but
/// nothing about that is a documented guarantee, which is why every call
/// site of this function is a best-effort attempt, not the only chance:
/// see `assert_tab_bar_visible_on_focus` below for the backstop that
/// catches it if a particular window ever *is* asked about too early.
///
/// Must run on the main thread; see `group_as_tab`'s doc comment for why
/// the actual AppKit calls happen inside `run_on_main_thread` rather than
/// here directly.
#[cfg(target_os = "macos")]
fn assert_tab_bar_visible(app: &tauri::AppHandle, ns_window_ptr: *mut std::ffi::c_void) {
  let ptr = SendableNsWindow(ns_window_ptr);
  let _ = app.run_on_main_thread(move || {
    // SAFETY: see group_as_tab's SAFETY comment — same reasoning, applied
    // to `tabGroup`/`isTabBarVisible`/`toggleTabBar` instead of
    // `addTabbedWindow:ordered:`.
    let ns_window: &NSWindow = unsafe { &*ptr.ptr().cast() };
    enable_automatic_window_tabbing();
    let Some(tab_group) = ns_window.tabGroup() else {
      return;
    };
    if !tab_group.isTabBarVisible() {
      ns_window.toggleTabBar(None);
    }
  });
}

/// Re-enables AppKit's automatic window tabbing, which `tao` turns *off*
/// during every window it builds (`setAllowsAutomaticWindowTabbing(false)`
/// in its `platform_impl/macos/window.rs`, gated on an `automatic_tabbing`
/// attribute Tauri does not expose).
///
/// This is what makes `toggleTabBar:` work at all. With automatic tabbing
/// disabled, AppKit refuses to show a tab bar for a group of one and
/// `toggleTabBar:` silently does nothing — `isTabBarVisible()` reads back
/// `false` immediately after the call, which is exactly the symptom that
/// led here. Explicit `addTabbedWindow:ordered:` keeps working regardless,
/// which is why tabs could be *created* while a lone window still showed no
/// bar to drag onto.
///
/// It has to be re-asserted per window rather than once at startup,
/// because tao flips it back off inside every `build()`.
///
/// Only call from the main thread — `MainThreadMarker::new()` returns
/// `None` elsewhere, and this then does nothing rather than panicking.
#[cfg(target_os = "macos")]
fn enable_automatic_window_tabbing() {
  if let Some(mtm) = MainThreadMarker::new() {
    NSWindow::setAllowsAutomaticWindowTabbing(true, mtm);
  }
}

// No non-macOS stub twin here (unlike group_as_tab/tab_group_labels above):
// `.ns_window()` itself is `#[cfg(target_os = "macos")]` in the tauri crate,
// so every call site below is already cfg-gated on macOS before it can even
// obtain the raw pointer this function needs — a stub would be unreachable
// dead code, not a platform-agnostic call site like those two.

/// The focus-driven backstop for `assert_tab_bar_visible` above: AppKit
/// forms a brand-new tab group — with the same single-window auto-hidden
/// bar `assert_tab_bar_visible` exists to override — whenever the user
/// drags the last tab out of an existing group, and there is no creation
/// hook of our own to catch that (this app never calls
/// `WebviewWindowBuilder::build()` for it; AppKit does the whole thing
/// itself in response to the drag). A window focus event is the nearest
/// substitute: a freshly detached window becomes key essentially
/// immediately after the drag completes, in every case exercised while
/// writing this, so hooking `WindowEvent::Focused(true)` on the existing
/// app-wide `on_window_event` handler (see `run()`) catches it without a
/// new event registration.
///
/// The one thing this must NOT do is reassert on *every* focus of *every*
/// window — `toggleTabBar:` would then fight the user's own explicit
/// "Show Tab Bar" / "Hide Tab Bar" choice (Cmd-Shift-\, or the tab bar's
/// own right-click menu — see `assert_tab_bar_visible`'s doc comment for
/// why there's no View menu item for it here) on every window they ever
/// refocus, popping a deliberately-hidden bar back on the moment they
/// click back into that window. `TabGroupSeen` above is what avoids that:
/// this only reasserts when `window`'s tab group is a *different* object
/// than the last one recorded for its label (or there's no record yet).
/// Comparing the group's own pointer identity, not
/// `NSWindowTabGroup.identifier()`, is deliberate — nothing here confirms
/// whether that identifier string varies per physical group the way the
/// pointer reliably does (every group is a distinct Objective-C object,
/// full stop), and guessing wrong would make this silently inert.
///
/// KNOWN GAP: dragging the last tab out and immediately dragging it back
/// into a group with the *exact same pointer identity* it started in
/// (unusual, but not impossible if AppKit ever reuses/keeps a group object
/// alive across such a round trip) would read as "unchanged" and skip the
/// reassert. Not verified either way without interactive testing — see
/// the "don't auto-hide the tab bar" design note in README.md.
#[cfg(target_os = "macos")]
fn assert_tab_bar_visible_on_focus(app: &tauri::AppHandle, label: String, ns_window_ptr: *mut std::ffi::c_void) {
  let ptr = SendableNsWindow(ns_window_ptr);
  let app_handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    // SAFETY: see group_as_tab's SAFETY comment.
    let ns_window: &NSWindow = unsafe { &*ptr.ptr().cast() };
    let Some(tab_group) = ns_window.tabGroup() else {
      return;
    };
    let group_ptr = Retained::as_ptr(&tab_group) as usize;

    // insert() both reads the previous value and writes the new one under
    // one lock — the atomicity matters here: a separate get-then-insert
    // could race a concurrent focus event on another window for the same
    // label (a real if narrow possibility, since Tauri does not promise
    // window events are delivered one at a time from a single thread).
    let seen = app_handle.state::<TabGroupSeen>();
    let previous = seen.0.lock().unwrap().insert(label, group_ptr);
    if previous == Some(group_ptr) {
      // Same group as last time this window was focused — leave it
      // alone, since the user may have deliberately hidden its tab bar
      // since then.
      return;
    }
    // First time seeing this window, or its group is materially
    // different from last time — a new/changed group defaults to hidden
    // when it has only one tab, which is exactly the behavior this app
    // wants overridden.
    if !tab_group.isTabBarVisible() {
      // Same reason as in assert_tab_bar_visible: without this,
      // toggleTabBar: is a no-op. Every window tao builds turns automatic
      // tabbing back off, so it can't be enabled once and left alone.
      enable_automatic_window_tabbing();
      ns_window.toggleTabBar(None);
    }
  });
}

/// The Tauri window labels of every tab in `window`'s tab group, including
/// `window` itself, queried fresh from AppKit's `tabbedWindows` on every
/// call — never cached in any Rust-side map — because the user can drag
/// tabs between groups (or pull one out into its own window) entirely
/// outside this app's control, and a cached map would silently drift out
/// of sync with reality the first time that happens. See the "why group
/// membership is queried, not tracked" design note in README.md.
///
/// Must run on the main thread; see `group_as_tab`'s doc comment for why
/// the AppKit query itself happens inside `run_on_main_thread` rather than
/// here directly, and why that's safe regardless of which thread called
/// this function. The `mpsc` round trip is what lets this function still
/// return a plain `Vec<String>` despite the query itself running inside a
/// `FnOnce() + Send + 'static` closure with no return value of its own.
#[cfg(target_os = "macos")]
fn tab_group_labels(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Vec<String> {
  let fallback = vec![window.label().to_string()];
  let Ok(target_ptr) = window.ns_window() else {
    return fallback;
  };

  // Gathered before hopping to the main thread so the closure below only
  // has to compare already-known pointers, not call back into `app`.
  let handles: Vec<(String, SendableNsWindow)> = app
    .webview_windows()
    .into_iter()
    .filter_map(|(label, w)| w.ns_window().ok().map(|ptr| (label, SendableNsWindow(ptr))))
    .collect();
  let target_ptr = SendableNsWindow(target_ptr);

  let (tx, rx) = std::sync::mpsc::channel();
  let _ = app.run_on_main_thread(move || {
    // SAFETY: see group_as_tab's SAFETY comment — same reasoning, applied
    // to `tabbedWindows` (a read-only query) instead of
    // `addTabbedWindow:ordered:`.
    let labels = unsafe {
      let target_ns: &NSWindow = &*target_ptr.ptr().cast();
      match target_ns.tabbedWindows() {
        Some(tabbed) => tabbed
          .iter()
          .filter_map(|tab: Retained<NSWindow>| {
            let tab_ptr = Retained::as_ptr(&tab) as *mut std::ffi::c_void;
            handles
              .iter()
              .find(|(_, h)| h.0 == tab_ptr)
              .map(|(label, _)| label.clone())
          })
          .collect::<Vec<_>>(),
        // No tab bar showing — either "Prefer tabs" is off and this window
        // was never grouped, or it's the sole tab left in its own group.
        // Either way the group is just this one window, reported via the
        // `fallback` this closure's caller falls back to below rather than
        // from in here (an empty Vec sent over `tx` and an unreachable
        // main thread are otherwise indistinguishable to the receiver).
        None => Vec::new(),
      }
    };
    let _ = tx.send(labels);
  });

  match rx.recv() {
    Ok(labels) if !labels.is_empty() => labels,
    _ => fallback,
  }
}

#[cfg(not(target_os = "macos"))]
fn tab_group_labels(_app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Vec<String> {
  // No native tab groups outside macOS — "the group" is just this window.
  vec![window.label().to_string()]
}

/// Starts the Close Window flow (Cmd-Shift-W): closes every tab in
/// `window`'s tab group, prompting one at a time for whichever are dirty.
///
/// All this does is turn a keypress into the one fact the machine cannot
/// work out for itself — which tabs are in this window's group, asked of
/// AppKit right now, never read from a map this crate keeps (design note 10
/// in README.md: the user can drag a tab between groups with no event this
/// app can observe, so any tracked copy would go stale). What happens to
/// that list afterwards is entirely `flow::advance`'s business, including
/// whether this press starts a walk at all.
///
/// The group is therefore queried even on a press that turns out to be
/// ignored, because a flow was already running. That costs one
/// `run_on_main_thread` round trip on a repeated keypress, and it buys
/// having exactly one re-entrancy guard in the codebase instead of a second
/// copy here that exists only to save the query.
fn close_window_group(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
  run_flow(
    app,
    flow::Input::StartCloseGroup {
      group: tab_group_labels(app, window),
    },
  );
}

/// The shared menu manifest, embedded at compile time.
///
/// `include_str!` rather than a runtime read for two reasons. The obvious one
/// is that a bundled `.app` has no `menu.json` sitting next to it to read. The
/// one that matters more: this file is the *only* copy of every custom menu
/// item's id, and it is read by two languages that cannot check each other —
/// Rust builds the menu from it, TypeScript listens for the events it implies.
/// Embedding it means the Rust half of that pair is settled when the binary is
/// compiled, and `build.rs` (which validates the same file, independently and
/// from raw JSON) turns a malformed or self-inconsistent manifest into a build
/// failure rather than a menu that silently does nothing when clicked.
static MENU_MANIFEST_JSON: &str = include_str!("../../menu.json");

/// The manifest's root. Not `deny_unknown_fields`, unlike the two structs
/// below: the file carries a `$comment` array of prose explaining itself to
/// whoever opens it next, which no consumer reads and neither consumer should
/// have to declare.
#[derive(Debug, serde::Deserialize)]
struct MenuManifest {
  submenus: Vec<SubmenuSpec>,
  items: Vec<MenuItemSpec>,
}

/// One submenu that holds custom items. Edit and Window have no entry here —
/// every item in them is predefined (see `build_menu`).
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmenuSpec {
  /// Referenced by each item's `submenu` field, and by `build_menu` when it
  /// asks for a submenu's items.
  key: String,
  /// What the menu bar draws, and what the Help ▸ Keyboard Shortcuts sheet
  /// titles this submenu's group with on the TypeScript side.
  title: String,
}

/// One custom menu item.
///
/// `deny_unknown_fields` is deliberate and load-bearing: without it a
/// misspelled `"acclerator"` would deserialize happily into an item with no
/// accelerator at all, which is precisely the class of silent failure this
/// manifest exists to eliminate. A typo here should stop the build, and with
/// this attribute it does — `build.rs` parses the same file into these same
/// rules before the crate compiles.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MenuItemSpec {
  /// Both the menu item's id and, prefixed with `menu-`, the event name it
  /// dispatches to the focused window — see `menu_event_name`.
  id: String,
  label: String,
  /// Absent for the menu-only items (every Outliner item but Find…/Find
  /// again, plus Delete Line and Sort in Reorg). See `build_menu` for why
  /// each of those deliberately has no key equivalent.
  #[serde(default)]
  accelerator: Option<String>,
  submenu: String,
  /// Draw a separator above this item. The grouping *is* part of the menu's
  /// meaning (File groups "which window" above "which document"; Reorg mirrors
  /// Drummer's grouping exactly), so it belongs in the manifest with the item
  /// rather than as a positional call left behind in this file.
  #[serde(default)]
  separator_before: bool,
  /// What this item does, in the Help ▸ Keyboard Shortcuts sheet's voice.
  /// Read only by the TypeScript side (`src/shortcuts.ts`); parsed here so
  /// that `deny_unknown_fields` above can do its job, and so a missing
  /// description fails the Rust build too rather than only the frontend's.
  #[allow(dead_code)]
  description: String,
}

/// The parsed manifest. Parsed once, on first use.
///
/// `expect` rather than a fallible return: the same bytes were already parsed
/// and validated by `build.rs` before this crate compiled, so reaching the
/// panic would mean the embedded string differs from the one the build script
/// read — impossible without editing the binary. A menu that fails loudly at
/// startup is in any case the right outcome; a menu that half-builds is the
/// failure mode worth avoiding.
fn menu_manifest() -> &'static MenuManifest {
  static MANIFEST: OnceLock<MenuManifest> = OnceLock::new();
  MANIFEST.get_or_init(|| {
    serde_json::from_str(MENU_MANIFEST_JSON).expect("menu.json is not a valid menu manifest")
  })
}

/// The event a custom menu item dispatches to the focused window.
///
/// This one function is the whole contract between the two languages: Rust
/// emits `menu_event_name(id)`, `src/actions.ts` listens for the identical
/// string built the identical way from the identical manifest. It used to be
/// 23 hand-written `emit_to(label, "menu-...")` calls facing 23 hand-written
/// `listen('menu-...')` calls, where a single mistyped character on either
/// side produced no compile error, no runtime error, and a menu item that
/// quietly did nothing.
fn menu_event_name(id: &str) -> String {
  format!("menu-{id}")
}

/// The manifest title for a submenu key.
///
/// Panics only if `build_menu` asks for a key the manifest doesn't define,
/// which `build.rs` rejects at compile time (it checks the exact set of keys
/// this file builds submenus for), so the message is for whoever adds a sixth
/// submenu to `build_menu` without adding it to the manifest first.
fn submenu_title(key: &str) -> &'static str {
  menu_manifest()
    .submenus
    .iter()
    .find(|s| s.key == key)
    .map(|s| s.title.as_str())
    .unwrap_or_else(|| panic!("menu.json defines no submenu named {key}"))
}

/// Appends one submenu's manifest items, in manifest order, to a builder.
///
/// Takes an already-started builder rather than making its own, because the
/// app submenu interleaves: About/Services/Hide/... are predefined and come
/// first, and only Quit is a custom item. Separators come from each item's
/// `separatorBefore`, so the whole of a submenu's shape — order, grouping,
/// labels, accelerators — is data in `menu.json`, and the code here reduces to
/// "build what the manifest says."
fn add_manifest_items<'m>(
  mut builder: SubmenuBuilder<'m, tauri::Wry, tauri::AppHandle>,
  app: &tauri::AppHandle,
  submenu_key: &str,
) -> tauri::Result<SubmenuBuilder<'m, tauri::Wry, tauri::AppHandle>> {
  for spec in menu_manifest().items.iter().filter(|i| i.submenu == submenu_key) {
    if spec.separator_before {
      builder = builder.separator();
    }
    let mut item = MenuItemBuilder::with_id(&spec.id, &spec.label);
    if let Some(accelerator) = &spec.accelerator {
      item = item.accelerator(accelerator);
    }
    builder = builder.item(&item.build(app)?);
  }
  Ok(builder)
}

/// Builds the app-wide menu. This lives in Rust, not JS: a JS menu's
/// `action` callbacks run in the webview that *created* the menu, which
/// with several windows open is the wrong window for anything document-
/// specific (Save would save whichever document happened to build the
/// menu, not the focused one) — and once that window closes, its JS
/// context is gone and the menu stops working at all. Native predefined
/// items (Cut/Copy/Paste, Close Tab, ...) don't have this problem: macOS
/// routes them through the responder chain to the focused window on its
/// own. Custom items (New, Open, New Window, Close Window, Save, Save As,
/// Keyboard Shortcuts, Quit) are routed explicitly in `on_menu_event`
/// below, by resolving the focused window and emitting *to* it
/// specifically — Quit and Close Window are the two exceptions that don't
/// stop at resolving a single focused window, since each may need to work
/// through *several* windows in turn; see their own doc comments below,
/// `run_flow`, `close_window_group`, and the state machine in flow.rs.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
  // Every custom item below comes from menu.json (see MENU_MANIFEST_JSON
  // above): its id, label, accelerator, order within its submenu, and which
  // separators group it. What stays here is what the manifest can't express —
  // which submenus exist at all, where the *predefined* native items sit
  // among the custom ones, and the reasoning behind both. Adding a menu item
  // is now an edit to menu.json plus a handler in src/actions.ts; nothing in
  // this function changes.
  //
  // Quit is a custom item, NOT the predefined `.quit()`, even though every
  // other native item in the app submenu is predefined. The predefined Quit
  // item maps to Cocoa's `sel!(terminate:)` (muda's macOS backend), which
  // sends `terminate:` straight to NSApplication — and nothing in this app, or
  // in tao underneath it, ever gets a chance to intervene first (verified
  // against tao 0.35.3's source: there is no `applicationShouldTerminate`
  // handler anywhere in it). That means Tauri's `RunEvent::ExitRequested` —
  // the hook the "just add ExitRequested + prevent_exit()" fix relies on —
  // never fires for Cmd-Q at all: the process tears down mid-edit,
  // discarding whatever's unsaved in every open window, and no amount of
  // Rust-side event handling can catch it after the fact. A *custom* item
  // does emit a menu event, routed through on_menu_event below like every
  // other custom item here, which is what keeps Cmd-Q inside code this app
  // controls. Do not "simplify" the "quit" entry in menu.json into a
  // `.quit()` call here — see the "Quit" design note in README.md first.
  let app_submenu = add_manifest_items(
    SubmenuBuilder::new(app, submenu_title("app"))
      .about(None)
      .separator()
      .services()
      .separator()
      .hide()
      .hide_others()
      .show_all(),
    app,
    "app",
  )?
  .build()?;

  // Cmd-N/O/S/Shift-S/Shift-N/Shift-W are all safe accelerators: they're
  // absent from CONCORD_KEYSTROKES (packages/outliner/src/util.ts) — which
  // has no Shift-modified entries at all — so the outliner's keydown
  // handler falls into its `default:` branch and never calls
  // preventDefault. Nothing in the File menu shadows an outliner keystroke.
  //
  // Close Window is custom because closing every tab in the focused window's
  // *group* needs Rust-side orchestration (AppKit's tabbedWindows, then the
  // same one-at-a-time unsaved-changes walk Quit uses) that no predefined item
  // can do — see close_window_group's doc comment, reached from the
  // "close-window" branch in on_menu_event below.
  //
  // Close Tab is custom for an unrelated reason: it used to be the predefined
  // "close window" role with its text changed, and AppKit draws that role with
  // a leading ✕ glyph. A single item carrying an image makes NSMenu reserve an
  // image column for its whole group — indenting the neighbouring items' text
  // and leaving the File menu visibly ragged. A custom item carries no image,
  // so the column disappears. Losing the predefined role means losing its
  // automatic responder-chain routing, so it's routed like every other custom
  // item (see on_menu_event) — but it deliberately calls Tauri's `close()`,
  // not `destroy()`. `close()` requests a close, which fires the same
  // `close-requested` event the red traffic-light button does, so both routes
  // still funnel through the single unsaved-changes guard in main.ts and the
  // frontend needs no new listener at all.
  //
  // The separator placement in menu.json is deliberate too: Save/Save As sit
  // *below* the two Close items, because New/Open/New Window/Close Tab/Close
  // Window are all about which tab or window you're looking at while Save/Save
  // As are about that tab's document — the menu groups by "which window"
  // before "which document."
  let file_submenu = add_manifest_items(SubmenuBuilder::new(app, submenu_title("file")), app, "file")?.build()?;

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

  // Keyboard Shortcuts has no accelerator in menu.json. The obvious Cmd-/ is
  // already bound to `run-selection` in the outliner (CONCORD_KEYSTROKES) —
  // giving this item Cmd-/ would shadow that keystroke the same way an
  // Edit-menu Undo would shadow Cmd-Z.
  let help_submenu = add_manifest_items(SubmenuBuilder::new(app, submenu_title("help")), app, "help")?.build()?;

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
  //
  // Drummer greys out items that don't apply to the current state (e.g.
  // Dehoist when nothing is hoisted). Reproducing that here would need a
  // frontend round trip on every cursor move just to ask "is isHoisted()
  // true right now" — skipped. hoist()/deHoist() already return false
  // harmlessly when they don't apply (see their doc comments in
  // packages/outliner/src/outliner.ts), so clicking a greyed-out-in-Drummer
  // item here is a harmless no-op instead.
  let outliner_submenu =
    add_manifest_items(SubmenuBuilder::new(app, submenu_title("outliner")), app, "outliner")?.build()?;

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
  let reorg_submenu = add_manifest_items(SubmenuBuilder::new(app, submenu_title("reorg")), app, "reorg")?.build()?;

  // Minimize/Zoom are the two predefined items every native macOS app's
  // Window menu starts with; everything below them — Select Next/Previous
  // Tab, Merge All Windows, Move Tab to New Window, the list of open
  // windows/tabs, ... — is macOS's own automatic addition once this
  // submenu is registered as the app's Window menu just below, via the
  // one `set_as_windows_menu_for_nsapp` call. That's the whole
  // implementation: no custom "Select Next Tab" items, no raw AppKit,
  // unlike the tab-grouping work in create_document_window/
  // close_window_group above — see the "why native tabs needed raw
  // AppKit" design note in README.md for why this call is the cheap case
  // and grouping/group-membership weren't.
  let window_submenu = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
  #[cfg(target_os = "macos")]
  window_submenu.set_as_windows_menu_for_nsapp()?;

  MenuBuilder::new(app)
    .item(&app_submenu)
    .item(&file_submenu)
    .item(&edit_submenu)
    .item(&outliner_submenu)
    .item(&reorg_submenu)
    .item(&window_submenu)
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
      app.manage(PendingFlow(Mutex::new(None)));
      #[cfg(target_os = "macos")]
      app.manage(TabGroupSeen(Mutex::new(HashMap::new())));

      let menu = build_menu(app.handle())?;
      app.set_menu(menu)?;

      // The startup window (declared in tauri.conf.json, labeled "main") is
      // the one document window create_document_window never builds, so it
      // needs its own tab-bar assert here — every other window gets one at
      // the end of create_document_window itself. See
      // assert_tab_bar_visible's doc comment for what this is working
      // around.
      #[cfg(target_os = "macos")]
      if let Some(main_window) = app.get_webview_window("main") {
        if let Ok(ptr) = main_window.ns_window() {
          assert_tab_bar_visible(app.handle(), ptr);
        }
      }

      app.on_menu_event(move |app, event| {
        let id = event.id().as_ref();

        // New Window has no per-document state to read and, unlike New
        // below, no need to know what's focused either — it never groups
        // with anything.
        if id == "new-window" {
          if let Err(err) = create_document_window(app, None, None) {
            log::error!("failed to open new window: {err}");
          }
          return;
        }

        // New has no per-document state to read, so it's handled entirely
        // here with no round trip to any frontend. It DOES care what's
        // focused now, unlike before tabs existed — the new tab joins the
        // focused window's group — but tolerates there being none (falls
        // back to a standalone window, same as New Window above) rather
        // than doing nothing.
        if id == "new" {
          let target = focused_window(app);
          if let Err(err) = create_document_window(app, None, target.as_ref()) {
            log::error!("failed to open new tab: {err}");
          }
          return;
        }

        // Close Window doesn't act on just "the document the user is
        // looking at" either — it needs the focused window's *tab group*,
        // then works through however many of those tabs are dirty one at a
        // time, same shape as Quit below. See close_window_group's doc
        // comment.
        // close() rather than destroy(): it fires `close-requested`, which
        // the focused tab's own guard in main.ts already handles — the same
        // path the red traffic-light button takes. destroy() would skip the
        // unsaved-changes prompt entirely.
        if id == "close-tab" {
          if let Some(window) = focused_window(app) {
            let _ = window.close();
          }
          return;
        }

        if id == "close-window" {
          if let Some(window) = focused_window(app) {
            close_window_group(app, &window);
          }
          return;
        }

        // Quit doesn't act on "the document the user is looking at" either
        // — it may need to work through *several* dirty windows in turn,
        // not just the focused one, so it goes to the flow machine instead
        // of falling into the focused-window branch below. See the "quit"
        // MenuItemBuilder's doc comment in build_menu for why this is a
        // custom item at all (short version: the predefined Quit sends
        // Cocoa's terminate: and no Rust hook ever runs, discarding unsaved
        // work in every window), and flow.rs for everything that happens
        // next — including the guard against a second Cmd-Q stacking a
        // second walk on top of this one.
        if id == "quit" {
          run_flow(app, flow::Input::StartQuit);
          return;
        }

        // Everything else acts on "the document the user is looking at",
        // so resolve the focused window. If nothing is focused there's no
        // document to act on.
        let Some(window) = focused_window(app) else {
          return;
        };
        let label = window.label().to_string();

        // Everything else — every custom item in menu.json that wasn't
        // intercepted above — acts on a specific document's state (dirty
        // flag, current path, outliner contents, search), which only that
        // window's frontend knows. So each is a single event emitted to the
        // window the user is looking at, and the branch that used to be 23
        // `"reorg-move-up" => emit_to(label, "menu-reorg-move-up", ())` arms
        // — identical to each other in every respect but the string, and each
        // an opportunity to mistype the `menu-` prefix or the id into a menu
        // item that silently did nothing — is now the one call below.
        //
        // emit_to (never plain emit) targets just the focused window's label.
        // A broadcast emit would fire in every open window at once, e.g.
        // saving every open document simultaneously when the user meant to
        // save just the one in front of them. That is not a hypothetical: an
        // `Any`-kind listener on the frontend once had exactly that effect
        // (see the listen() comment in src/main.ts).
        //
        // Guarded on the manifest rather than emitting for whatever id turns
        // up, so this can never invent an event name for an id no menu item
        // has. Predefined items (Cut/Copy/Paste, About, Minimize, ...) are
        // routed by macOS through the responder chain and don't reach here at
        // all; anything else that did would be a bug worth not papering over.
        if menu_manifest().items.iter().any(|item| item.id == id) {
          let _ = app.emit_to(label, &menu_event_name(id), ());
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
      // The drag-out backstop for assert_tab_bar_visible — see
      // assert_tab_bar_visible_on_focus's doc comment for the full
      // reasoning, including why this only reasserts on a *changed* tab
      // group rather than on every focus.
      #[cfg(target_os = "macos")]
      if let tauri::WindowEvent::Focused(true) = event {
        if let Ok(ptr) = window.ns_window() {
          assert_tab_bar_visible_on_focus(window.app_handle(), window.label().to_string(), ptr);
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      read_file,
      write_file,
      open_path_in_new_tab,
      set_dirty,
      flow_response
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
      // practice here, the OS-driven "last window closed" exit, since Quit
      // itself never reaches the OS anymore (it's the custom item above).
      // By the time that fires, whichever route closed the window —
      // `onCloseRequested` in main.ts (Close Tab / the traffic light) or
      // run_flow's own `Step::Destroy` (Close Window's group walk) — has
      // already prompted if needed, and this crate's
      // on_window_event Destroyed handler above has already dropped that
      // window's entry — so checking the dirty map here is correct for
      // Cmd-Q, Close Window, *and* the plain last-window-close case alike.
      //
      // `code: Some(_)` is a *programmatic* exit — the only one this crate
      // ever triggers is `Step::Exit`'s `app.exit(0)` in run_flow, which the
      // machine only reaches once no live window is dirty. Skipping the
      // check entirely for Some(_) is what keeps that call from deadlocking
      // against this very handler: prevent_exit() firing on our own
      // already-verified exit would leave the app unquittable. Note this is
      // belt and braces rather than the load-bearing part — the state the
      // check would read is genuinely clean by then (flow.rs's `Step::Exit`
      // explains why that honesty is the property to preserve, and why a
      // bypass flag would not be).
      if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if code.is_none() {
          // Only a dirty window that STILL EXISTS may veto the exit — the
          // same rule, from the same accessor, that the flow's own walk
          // uses. The map alone isn't safe to trust here: this fires on the
          // last-window-closed path, and it would be a bet on Destroyed
          // being delivered before ExitRequested that the entry for the
          // window that just closed is already gone. Lose that bet and
          // prevent_exit() fires with no windows left to prompt in — an
          // invisible process the user can only end from Activity Monitor,
          // which is a worse failure than the data loss this whole flow
          // exists to prevent. `flow::Windows` takes that intersection once,
          // for this check and both walks alike.
          if windows_snapshot(app).any_dirty() {
            api.prevent_exit();
          }
        }
      }
    });
}

#[cfg(test)]
mod tests {
  use super::*;

  // These tests exist because the menu manifest (../menu.json) is read by two
  // languages that can't check each other: Rust builds the menu from it and
  // TypeScript listens for the events it implies. Nothing in either compiler
  // notices when a manifest entry drifts — a wrong id still builds, still
  // dispatches, and simply does nothing when clicked, which is exactly the
  // silent failure this whole manifest exists to make impossible.
  //
  // Every expectation below is written out as a literal transcribed from the
  // hand-written `build_menu`/`on_menu_event` code the manifest replaced,
  // never recomputed from the manifest itself. Reading the answer back out of
  // the thing under test would make these pass by construction and catch no
  // drift at all.

  /// The five ids `on_menu_event` intercepts before the generic dispatch,
  /// transcribed from that `if` chain.
  ///
  /// Each acts on *windows* rather than on one document's contents — New and
  /// New Window create one, Close Tab and Close Window close one or a group of
  /// them, Quit walks every dirty window app-wide — so none of them is a
  /// matter of emitting an event to the focused window and letting its
  /// frontend answer. They stay explicit per-item branches in `on_menu_event`
  /// because each does something genuinely different; this list is what lets
  /// the tests below tie those branches back to real manifest entries.
  const ROUTED_BEFORE_DISPATCH: &[&str] = &["new", "new-window", "close-tab", "close-window", "quit"];

  /// The whole custom menu as it was built by hand before the manifest:
  /// (submenu key, id, label, accelerator, separator before this item).
  /// Predefined native items (About/Services/Hide/Cut/Copy/Paste/Minimize/
  /// Zoom, and everything macOS appends to the Window menu) are deliberately
  /// absent — the manifest covers custom items only, since those are the ones
  /// this app has to route itself.
  const EXPECTED_ITEMS: &[(&str, &str, Option<&str>, Option<&str>, bool)] = &[
    ("app", "quit", Some("Quit GeekityFlow"), Some("CmdOrCtrl+Q"), true),
    ("file", "new", Some("New"), Some("CmdOrCtrl+N"), false),
    ("file", "open", Some("Open…"), Some("CmdOrCtrl+O"), false),
    (
      "file",
      "new-window",
      Some("New Window"),
      Some("CmdOrCtrl+Shift+N"),
      true,
    ),
    ("file", "close-tab", Some("Close Tab"), Some("CmdOrCtrl+W"), false),
    (
      "file",
      "close-window",
      Some("Close Window"),
      Some("CmdOrCtrl+Shift+W"),
      false,
    ),
    ("file", "save", Some("Save"), Some("CmdOrCtrl+S"), true),
    (
      "file",
      "save-as",
      Some("Save As…"),
      Some("CmdOrCtrl+Shift+S"),
      false,
    ),
    ("outliner", "expand", Some("Expand"), None, false),
    ("outliner", "expand-all-subs", Some("Expand All Subs"), None, false),
    (
      "outliner",
      "expand-everything",
      Some("Expand Everything"),
      None,
      false,
    ),
    ("outliner", "collapse", Some("Collapse"), None, true),
    (
      "outliner",
      "collapse-everything",
      Some("Collapse Everything"),
      None,
      false,
    ),
    ("outliner", "hoist", Some("Hoist"), None, true),
    ("outliner", "dehoist", Some("Dehoist"), None, false),
    ("outliner", "find", Some("Find…"), Some("CmdOrCtrl+F"), true),
    (
      "outliner",
      "find-again",
      Some("Find again"),
      Some("CmdOrCtrl+G"),
      false,
    ),
    ("reorg", "reorg-move-up", Some("Move Up"), Some("CmdOrCtrl+U"), false),
    (
      "reorg",
      "reorg-move-down",
      Some("Move Down"),
      Some("CmdOrCtrl+D"),
      false,
    ),
    (
      "reorg",
      "reorg-move-left",
      Some("Move Left"),
      Some("CmdOrCtrl+L"),
      false,
    ),
    (
      "reorg",
      "reorg-move-right",
      Some("Move Right"),
      Some("CmdOrCtrl+R"),
      false,
    ),
    (
      "reorg",
      "reorg-toggle-comment",
      Some("Toggle comment"),
      Some("CmdOrCtrl+\\"),
      true,
    ),
    (
      "reorg",
      "reorg-run-selection",
      Some("Run selection"),
      Some("CmdOrCtrl+/"),
      false,
    ),
    ("reorg", "reorg-delete-line", Some("Delete Line"), None, true),
    ("reorg", "reorg-promote", Some("Promote"), Some("CmdOrCtrl+["), true),
    ("reorg", "reorg-demote", Some("Demote"), Some("CmdOrCtrl+]"), false),
    ("reorg", "reorg-sort", Some("Sort"), None, true),
    (
      "help",
      "keyboard-shortcuts",
      Some("Keyboard Shortcuts"),
      None,
      false,
    ),
  ];

  #[test]
  fn the_manifest_describes_the_menu_that_used_to_be_hand_written() {
    let actual: Vec<(&str, &str, Option<&str>, Option<&str>, bool)> = menu_manifest()
      .items
      .iter()
      .map(|item| {
        (
          item.submenu.as_str(),
          item.id.as_str(),
          Some(item.label.as_str()),
          item.accelerator.as_deref(),
          item.separator_before,
        )
      })
      .collect();

    assert_eq!(actual, EXPECTED_ITEMS);
  }

  #[test]
  fn the_manifest_names_its_submenus_in_menu_bar_order() {
    // Edit and Window are absent on purpose: neither has a single custom item
    // (Cut/Copy/Paste and Minimize/Zoom are all predefined), so neither needs
    // an entry here. `build_menu` still orders the menu bar itself, slotting
    // Edit between File and Outliner and Window between Reorg and Help.
    let actual: Vec<(&str, &str)> = menu_manifest()
      .submenus
      .iter()
      .map(|s| (s.key.as_str(), s.title.as_str()))
      .collect();

    assert_eq!(
      actual,
      vec![
        ("app", "GeekityFlow"),
        ("file", "File"),
        ("outliner", "Outliner"),
        ("reorg", "Reorg"),
        ("help", "Help"),
      ]
    );
  }

  #[test]
  fn every_dispatched_item_emits_the_event_its_listener_expects() {
    // The 23 event names the deleted `match` arms in `on_menu_event` emitted,
    // one per arm, transcribed from that code — and matching, name for name,
    // the `appWindow.listen` calls in src/main.ts. This is the assertion that
    // makes the collapse to a single `format!("menu-{id}")` branch safe: get
    // the prefix or an id wrong and the menu item silently does nothing at
    // runtime, with nothing else anywhere to catch it.
    let expected = vec![
      "menu-open",
      "menu-save",
      "menu-save-as",
      "menu-expand",
      "menu-expand-all-subs",
      "menu-expand-everything",
      "menu-collapse",
      "menu-collapse-everything",
      "menu-hoist",
      "menu-dehoist",
      "menu-find",
      "menu-find-again",
      "menu-reorg-move-up",
      "menu-reorg-move-down",
      "menu-reorg-move-left",
      "menu-reorg-move-right",
      "menu-reorg-toggle-comment",
      "menu-reorg-run-selection",
      "menu-reorg-delete-line",
      "menu-reorg-promote",
      "menu-reorg-demote",
      "menu-reorg-sort",
      "menu-keyboard-shortcuts",
    ];

    let actual: Vec<String> = menu_manifest()
      .items
      .iter()
      .filter(|item| !ROUTED_BEFORE_DISPATCH.contains(&item.id.as_str()))
      .map(|item| menu_event_name(&item.id))
      .collect();

    assert_eq!(actual, expected);
  }

  #[test]
  fn the_five_items_routed_in_rust_are_all_real_menu_items() {
    // New/New Window/Close Tab/Close Window/Quit never reach the dispatch
    // branch — each is intercepted earlier in `on_menu_event` because it acts
    // on windows rather than on one document's contents. They're still menu
    // items, so a typo in one of those `if id == "..."` comparisons would
    // leave a real menu item doing nothing; this ties them back to the
    // manifest so the typo fails here instead.
    for id in ROUTED_BEFORE_DISPATCH {
      assert!(
        menu_manifest().items.iter().any(|item| item.id == *id),
        "{id} is routed in on_menu_event but is not a menu item"
      );
    }
  }

  #[test]
  fn every_item_id_is_unique_and_safe_to_paste_into_an_event_name() {
    // Ids are concatenated into an event name (`menu-{id}`) and into nothing
    // else, so the only constraints are uniqueness and that the result stays
    // a plain lowercase-kebab identifier — no spaces or punctuation that
    // would make the emitted name unmatchable by the listener side.
    let mut seen: Vec<&str> = Vec::new();
    for item in &menu_manifest().items {
      assert!(!seen.contains(&item.id.as_str()), "duplicate menu id: {}", item.id);
      seen.push(&item.id);
      assert!(
        item
          .id
          .chars()
          .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "menu id is not lowercase kebab-case: {}",
        item.id
      );
      assert!(
        menu_manifest().submenus.iter().any(|s| s.key == item.submenu),
        "{} belongs to unknown submenu {}",
        item.id,
        item.submenu
      );
    }
  }
}
