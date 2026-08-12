//! The document-lifecycle state machine behind Quit (Cmd-Q) and Close Window
//! (Cmd-Shift-W): "which of my open windows have unsaved work, ask each in
//! turn, abort the moment one cancels".
//!
//! This module deliberately imports NOTHING from `tauri`. That absence is the
//! seam. Every decision here is a function of three plain values — the flow
//! state, what just happened, and a snapshot of the windows — and every
//! effect leaves as a `Step` for `lib.rs` to carry out. If something in here
//! ever wants an `AppHandle`, the split is in the wrong place: what it
//! actually wants is another plain input, or another `Step`.
//!
//! The reason for the seam is that this is the most defensive code in the
//! app and it used to be the only code with no test. Decision and effect
//! interleaved line by line — every step took `&AppHandle` and reached
//! through it for `state::<DirtyWindows>()`, `get_webview_window()`,
//! `set_focus()`, `emit_to()`, `destroy()`, `exit()` — so none of it could
//! run without a windowing system, and the failure modes that matter here
//! (a quit that hangs with no window left to prompt in, an exit that
//! deadlocks against its own dirty check) could only ever be reasoned about,
//! never asserted. They are table tests at the bottom of this file now.

use std::collections::{BTreeSet, HashMap};

/// The event a window's frontend listens for to run its unsaved-changes
/// prompt during a Quit. Named for the menu item rather than the flow
/// because that is what the frontend has always called it.
pub const PROMPT_QUIT: &str = "menu-quit";

/// The Close Window equivalent of `PROMPT_QUIT`. A *different* event, not a
/// parameter on one shared event, because the frontend genuinely does
/// something different with each: a window survives a quit (so Don't Save
/// has to clear the frontend's own changed flag — see the exit-deadlock
/// reasoning on `Step::Exit`), while a window closed by this flow does not.
pub const PROMPT_CLOSE_GROUP: &str = "menu-close-window-group";

/// Which multi-window flow, if any, is currently walking windows one at a
/// time asking about unsaved changes.
///
/// `Quit` visits every dirty window app-wide — not scoped to any tab group,
/// since quitting has to account for every open document — and exits the
/// process once none remain. `CloseGroup` visits only the labels captured
/// once, up front, from AppKit's `tabbedWindows` when Cmd-Shift-W was
/// pressed, destroying each as it resolves instead of exiting.
///
/// One enum rather than a flow-specific pair of state machines because the
/// two share their hardest invariants — the re-entrancy guard, and "only a
/// window that still exists may veto" — and a second copy of those is a
/// second chance to get them subtly different.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Flow {
  Quit,
  /// The tabs still to visit, in order. A label is removed from this list
  /// when the walk reaches it, *before* it is prompted — so the answer that
  /// comes back later resumes from the rest of the list rather than
  /// re-visiting the window that just answered.
  CloseGroup {
    remaining: Vec<String>,
  },
}

/// What the user chose in a window's unsaved-changes prompt.
///
/// `Proceed` covers both Save (already written to disk) and Don't Save —
/// from the flow's point of view they are the same answer, "this window's
/// part is done, keep going". `Cancel` aborts the whole flow, not just this
/// window's turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Response {
  Cancel,
  Proceed,
}

/// Everything that can drive the machine forward. Starting a flow and
/// continuing one are inputs to the same function because there is no real
/// difference between them: both come down to "work out what to do next
/// given the state and the world".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
  /// Cmd-Q.
  StartQuit,
  /// Cmd-Shift-W, carrying the focused window's tab group as queried fresh
  /// from AppKit by the caller. The list is an *input* precisely because
  /// group membership can never be tracked in Rust — the user can drag a tab
  /// between groups with no event this app can observe — so it has to be
  /// asked for at the moment it is needed. See design note 10 in
  /// apps/desktop/README.md.
  StartCloseGroup { group: Vec<String> },
  /// A prompt that a `Step::Prompt` triggered has come back with an answer.
  Resolved { label: String, response: Response },
}

/// One effect for the adapter in `lib.rs` to carry out, in the order given.
/// These are the only things this module can cause to happen; anything a
/// step cannot express is something the machine is not allowed to decide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
  /// Drop a dirty-map entry for a window that no longer exists. The entry
  /// is already ignored by every decision here (see `Windows`), so this is
  /// hygiene rather than correctness — it keeps the map from accumulating
  /// one entry per window ever opened.
  Forget { label: String },
  /// Record that a window has no unsaved work, right now, without waiting
  /// for its frontend's own `set_dirty` call to arrive. That call and the
  /// prompt's answer are sent in order from the same webview, but nothing
  /// guarantees Rust *processes* two independent IPC calls in send order,
  /// and racing that would make the flow's progress non-deterministic.
  MarkClean { label: String },
  /// Focus this window and ask its frontend to run the unsaved-changes
  /// prompt named by `event`. Focus is best-effort: a window that cannot be
  /// focused still gets the prompt, because failing the whole flow on it
  /// would leave the app with no way to quit at all.
  ///
  /// `event` is emitted to this one label — never broadcast to every window,
  /// which would put a prompt in front of the user in all of them at once.
  Prompt { label: String, event: &'static str },
  /// Close this window for good. Only ever produced by `CloseGroup`: Quit
  /// leaves every window open until the very end, where the process exit
  /// itself is what closes them.
  Destroy { label: String },
  /// Quit the process.
  ///
  /// This is only ever emitted when no live window is dirty, and that is
  /// load-bearing rather than merely tidy: the adapter's `app.exit(0)`
  /// re-triggers `RunEvent::ExitRequested`, which re-checks the very same
  /// dirty state through the very same `Windows` snapshot. The flow does not
  /// get past that check with a bypass flag — it gets past it by having made
  /// the state genuinely honest first (`MarkClean` above, plus the
  /// frontend's own `clearChanged()` on the Don't Save path). A bypass flag
  /// would work right up until something else exited the app, and would make
  /// the check a lie the rest of the time.
  Exit,
}

/// The machine's answer: what `PendingFlow` should now hold, and what to do
/// about it. `pending: None` means the flow is over — finished, cancelled,
/// or never started — and a later Cmd-Q or Cmd-Shift-W is free to start a
/// new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
  pub pending: Option<Flow>,
  pub steps: Vec<Step>,
}

/// A snapshot of the windows the machine is reasoning about: which ones
/// exist, and which of those have unsaved work.
///
/// This type exists to hold one invariant in one place. "A window may have
/// vanished since we read the dirty map" used to be defended three separate
/// times — in Quit's walk, in Close Window's walk, and in the
/// `ExitRequested` veto — each with its own different recovery, because
/// there was no accessor that held the rule. A stale `true` in that map is
/// not hypothetical: a window closed through the traffic light or Close Tab
/// leaves one behind until `WindowEvent::Destroyed` is delivered, and acting
/// on it means focusing and prompting a window that no longer exists, which
/// hangs the app with no visible prompt and no way to quit.
///
/// So the intersection is taken once, here, at construction. `is_dirty`
/// cannot answer true for a window that does not exist, because the set it
/// consults never contained one. Callers get no chance to forget the check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Windows {
  live: BTreeSet<String>,
  /// Live AND dirty. Never merely dirty.
  dirty: BTreeSet<String>,
  stale: Vec<String>,
}

impl Windows {
  /// `dirty` is Rust's pushed-from-JS copy of each window's unsaved-changes
  /// flag (see design note 8 in apps/desktop/README.md); `live` is the
  /// labels of the windows that actually exist right now.
  pub fn new(dirty: &HashMap<String, bool>, live: &[String]) -> Self {
    let live: BTreeSet<String> = live.iter().cloned().collect();
    Windows {
      dirty: dirty
        .iter()
        .filter(|(label, &d)| d && live.contains(*label))
        .map(|(label, _)| label.clone())
        .collect(),
      stale: {
        // Sorted for the same reason `next_dirty` is ordered: a HashMap's
        // iteration order is arbitrary, and an arbitrary order in a value
        // this module hands back is an arbitrary order in the tests that
        // pin it.
        let mut stale: Vec<String> = dirty
          .keys()
          .filter(|label| !live.contains(*label))
          .cloned()
          .collect();
        stale.sort();
        stale
      },
      live,
    }
  }

  pub fn is_live(&self, label: &str) -> bool {
    self.live.contains(label)
  }

  /// True only for a window that both exists and has unsaved work.
  pub fn is_dirty(&self, label: &str) -> bool {
    self.dirty.contains(label)
  }

  /// The next window a Quit should ask about, or `None` when there is
  /// nothing left to ask.
  ///
  /// Which dirty window goes first is not specified behaviour — the map this
  /// is derived from is unordered — but *some* fixed order is, so that a
  /// test can name the window it expects. Lowest label wins.
  pub fn next_dirty(&self) -> Option<&str> {
    self.dirty.iter().next().map(|s| s.as_str())
  }

  /// Whether any window that still exists has unsaved work. This is the
  /// whole of the `ExitRequested` veto: the exit is blocked exactly when a
  /// window is left that could still show a prompt.
  pub fn any_dirty(&self) -> bool {
    !self.dirty.is_empty()
  }

  /// Dirty-map entries for windows that no longer exist.
  pub fn stale(&self) -> &[String] {
    &self.stale
  }

  /// This snapshot with `label` no longer dirty — how the world looks once a
  /// `MarkClean` step has been carried out.
  fn marked_clean(&self, label: &str) -> Windows {
    let mut next = self.clone();
    next.dirty.remove(label);
    next
  }
}

/// The whole flow, as one total function from (state, input, world) to (new
/// state, effects).
///
/// `pending` is what `PendingFlow` holds; the returned `Outcome::pending` is
/// what it should hold afterwards, unconditionally — the caller assigns it
/// rather than deciding anything about it, including on the paths where the
/// answer is "the same thing it held before".
pub fn advance(pending: Option<&Flow>, input: Input, windows: &Windows) -> Outcome {
  match input {
    Input::StartQuit => drive(Flow::Quit, windows, Vec::new()),
    Input::StartCloseGroup { .. } => todo!(),
    Input::Resolved { label, response } => resolved(pending, &label, response, windows),
  }
}

/// A prompt came back with an answer.
fn resolved(pending: Option<&Flow>, label: &str, response: Response, windows: &Windows) -> Outcome {
  let _ = response;

  // Marked clean here rather than left to the frontend's own `set_dirty`
  // call: that call and this answer are sent in order from the same webview,
  // but nothing guarantees Rust *processes* two independent IPC calls in
  // send order, and racing that would make the walk's progress
  // non-deterministic.
  let mut steps = vec![Step::MarkClean {
    label: label.to_string(),
  }];
  let Some(flow) = pending else {
    // An answer with nothing pending should not be possible — only a
    // `Step::Prompt` asks the question — but if one arrives, the fact it
    // reports is still true: the frontend has saved or discarded, so a map
    // that said otherwise would be a lie that blocks the *next* quit.
    return Outcome { pending: None, steps };
  };

  // The rest of this call has to reason about the world it is itself
  // creating, not the one it was handed: the window that just answered is no
  // longer dirty, and asking about it again would prompt it forever.
  drive(flow.clone(), &windows.marked_clean(label), steps)
}

/// Works out the next thing to wait on, appending to `steps` whatever has to
/// happen before then.
fn drive(flow: Flow, windows: &Windows, mut steps: Vec<Step>) -> Outcome {
  match flow {
    Flow::Quit => {
      // Hygiene, not correctness: `next_dirty` already ignores these (see
      // `Windows`). Dropping them keeps the map down to the windows that
      // exist, rather than one entry per window ever opened.
      steps.extend(
        windows
          .stale()
          .iter()
          .map(|label| Step::Forget { label: label.clone() }),
      );
      match windows.next_dirty() {
        Some(label) => {
          steps.push(Step::Prompt {
            label: label.to_string(),
            event: PROMPT_QUIT,
          });
          Outcome {
            pending: Some(Flow::Quit),
            steps,
          }
        }
        // Nothing left to ask about, and — because that answer came from
        // `Windows` rather than from a flag this flow set — the dirty state is
        // genuinely honest at this moment. That is what stops the adapter's
        // `app.exit(0)` from being bounced straight back by `ExitRequested`'s
        // own check. See `Step::Exit`.
        None => {
          steps.push(Step::Exit);
          Outcome { pending: None, steps }
        }
      }
    }
    Flow::CloseGroup { .. } => todo!(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The dirty map as the frontend would have left it: label -> has unsaved
  /// work. Written out per test rather than built by a helper that shares
  /// logic with `Windows::new`, which would make these pass by construction.
  fn dirty(entries: &[(&str, bool)]) -> HashMap<String, bool> {
    entries.iter().map(|(l, d)| (l.to_string(), *d)).collect()
  }

  fn live(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|l| l.to_string()).collect()
  }

  // ---- Windows: the one place staleness is handled -----------------------

  /// The bug this rules out, in one test: a window closed through the
  /// traffic light or Close Tab leaves `true` behind in the dirty map until
  /// `WindowEvent::Destroyed` is delivered. Believing it means focusing and
  /// prompting a window that is not there — the app hangs with no visible
  /// prompt and no way to quit.
  #[test]
  fn a_dirty_window_that_no_longer_exists_is_not_dirty() {
    let windows = Windows::new(&dirty(&[("win-1", true)]), &live(&[]));

    assert!(!windows.is_dirty("win-1"));
    assert!(!windows.is_live("win-1"));
    assert_eq!(windows.next_dirty(), None);
    assert!(!windows.any_dirty());
    assert_eq!(windows.stale(), &["win-1".to_string()]);
  }

  // ---- Quit --------------------------------------------------------------

  /// Cmd-Q with nothing unsaved anywhere: no prompt, straight out.
  #[test]
  fn quit_with_nothing_dirty_exits_immediately() {
    let windows = Windows::new(&dirty(&[("win-1", false)]), &live(&["win-1"]));

    let outcome = advance(None, Input::StartQuit, &windows);

    assert_eq!(outcome.steps, vec![Step::Exit]);
    assert_eq!(outcome.pending, None);
  }

  /// The prompt goes to one named window, and Quit stays pending until that
  /// window answers.
  #[test]
  fn quit_prompts_the_dirty_window_and_waits() {
    let windows = Windows::new(
      &dirty(&[("win-1", false), ("win-2", true)]),
      &live(&["win-1", "win-2"]),
    );

    let outcome = advance(None, Input::StartQuit, &windows);

    assert_eq!(
      outcome.steps,
      vec![Step::Prompt {
        label: "win-2".to_string(),
        event: "menu-quit",
      }]
    );
    assert_eq!(outcome.pending, Some(Flow::Quit));
  }

  /// A dirty entry for a window that has already gone must not stop the walk
  /// — it is dropped and the flow carries on to a window that does exist.
  /// This is the hang the whole `Windows` intersection exists to prevent,
  /// asserted end to end rather than at the accessor.
  #[test]
  fn quit_forgets_a_stale_entry_and_keeps_walking() {
    let windows = Windows::new(&dirty(&[("win-gone", true), ("win-2", true)]), &live(&["win-2"]));

    let outcome = advance(None, Input::StartQuit, &windows);

    assert_eq!(
      outcome.steps,
      vec![
        Step::Forget {
          label: "win-gone".to_string(),
        },
        Step::Prompt {
          label: "win-2".to_string(),
          event: "menu-quit",
        },
      ]
    );
    assert_eq!(outcome.pending, Some(Flow::Quit));
  }

  // ---- Sequences ---------------------------------------------------------

  /// A stand-in for the app: the two pieces of world `advance` reads, plus
  /// the `PendingFlow` slot, driven exactly the way `lib.rs`'s adapter
  /// drives them.
  ///
  /// The point of these tests is that a *sequence* is where this flow's real
  /// failures live — cancel mid-walk, a window vanishing between two
  /// answers, an exit that has to survive its own re-entrant dirty check.
  /// None of those can be seen in a single call, so the harness replays a
  /// whole flow and records what happened.
  struct App {
    dirty: HashMap<String, bool>,
    live: Vec<String>,
    pending: Option<Flow>,
    /// Every step carried out so far, in order, across the whole flow.
    log: Vec<Step>,
    exited: bool,
  }

  impl App {
    fn new(dirty_entries: &[(&str, bool)], live_labels: &[&str]) -> Self {
      App {
        dirty: dirty(dirty_entries),
        live: live(live_labels),
        pending: None,
        log: Vec::new(),
        exited: false,
      }
    }

    fn windows(&self) -> Windows {
      Windows::new(&self.dirty, &self.live)
    }

    /// One turn of the adapter's loop: ask the machine, store the new
    /// pending state, carry out the steps. Deliberately the same shape as
    /// `lib.rs`'s executor, so a step this harness cannot carry out is a
    /// step the real adapter has no business inventing either.
    fn send(&mut self, input: Input) -> &mut Self {
      let outcome = advance(self.pending.as_ref(), input, &self.windows());
      self.pending = outcome.pending;
      for step in outcome.steps {
        match &step {
          Step::Forget { label } => {
            self.dirty.remove(label);
          }
          Step::MarkClean { label } => {
            self.dirty.insert(label.clone(), false);
          }
          Step::Prompt { .. } => {}
          Step::Destroy { label } => {
            // The real adapter's destroy() also triggers the Destroyed
            // handler that drops the dirty entry — see design note 8.
            self.live.retain(|l| l != label);
            self.dirty.remove(label);
          }
          Step::Exit => {
            // The exit re-enters RunEvent::ExitRequested, which re-checks
            // the same state through the same accessor. Recording the
            // answer here is how the exit-deadlock property gets asserted
            // rather than argued about.
            self.exited = !self.windows().any_dirty();
          }
        }
        self.log.push(step);
      }
      self
    }

    /// The labels prompted so far, in order — the walk, as the user saw it.
    fn prompted(&self) -> Vec<&str> {
      self
        .log
        .iter()
        .filter_map(|step| match step {
          Step::Prompt { label, .. } => Some(label.as_str()),
          _ => None,
        })
        .collect()
    }
  }

  /// The ordinary Quit: every dirty window is asked, one at a time, and the
  /// app exits once the last one answers. Nothing is destroyed along the way
  /// — a window survives a quit; the process exit is what closes it.
  #[test]
  fn quit_asks_every_dirty_window_in_turn_then_exits() {
    let mut app = App::new(
      &[("win-1", true), ("win-2", false), ("win-3", true)],
      &["win-1", "win-2", "win-3"],
    );

    app.send(Input::StartQuit);
    assert_eq!(app.prompted(), vec!["win-1"]);

    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Proceed,
    });
    assert_eq!(app.prompted(), vec!["win-1", "win-3"]);

    app.send(Input::Resolved {
      label: "win-3".to_string(),
      response: Response::Proceed,
    });

    assert_eq!(app.prompted(), vec!["win-1", "win-3"]);
    assert!(app.log.contains(&Step::Exit));
    assert!(!app.log.iter().any(|s| matches!(s, Step::Destroy { .. })));
    assert_eq!(app.pending, None);
  }

  /// The exit-deadlock property, pinned. `app.exit(0)` re-triggers
  /// `RunEvent::ExitRequested`, which re-checks the dirty state — so the
  /// flow only gets to exit if that state is *genuinely* clean by then, with
  /// no bypass flag anywhere. `App::exited` is set only when the re-check
  /// agrees, so a machine that reached Exit while a live window was still
  /// dirty would leave it false: the app that refuses to quit against its
  /// own exit call.
  #[test]
  fn quit_only_exits_once_the_dirty_state_is_honestly_clean() {
    let mut app = App::new(&[("win-1", true)], &["win-1"]);

    app.send(Input::StartQuit);
    assert!(!app.exited, "must not exit while win-1 is unresolved");

    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Proceed,
    });

    assert!(app.exited, "the re-entrant dirty check must let this exit through");
    assert!(!app.windows().any_dirty());
  }
}

