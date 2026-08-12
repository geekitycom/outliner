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

  /// This snapshot with `label` gone entirely — how the world looks once a
  /// `Destroy` step has been carried out. The dirty entry goes with it,
  /// mirroring the `WindowEvent::Destroyed` cleanup the adapter relies on
  /// (design note 8 in apps/desktop/README.md): a destroyed webview can
  /// never send a final `set_dirty` of its own.
  fn destroyed(&self, label: &str) -> Windows {
    let mut next = self.clone();
    next.dirty.remove(label);
    next.live.remove(label);
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
    // The re-entrancy guard, in the one place both flows pass through.
    // Cmd-Q pressed twice — whether the OS re-delivers the keystroke or the
    // user genuinely presses it again while a prompt from the first press is
    // still open — must not start a second walk on top of the first, and
    // neither must Cmd-Q on top of a Close Window walk or the reverse. A
    // second walk would re-prompt a window that is already showing a prompt.
    // The running flow is left exactly as it was and nothing happens.
    Input::StartQuit => match pending {
      Some(running) => unchanged(running),
      None => drive(Flow::Quit, windows, Vec::new()),
    },
    Input::StartCloseGroup { group } => match pending {
      Some(running) => unchanged(running),
      None => drive(Flow::CloseGroup { remaining: group }, windows, Vec::new()),
    },
    Input::Resolved { label, response } => resolved(pending, &label, response, windows),
  }
}

/// A start request that arrived while a flow was already running: keep the
/// running flow, do nothing.
fn unchanged(running: &Flow) -> Outcome {
  Outcome {
    pending: Some(running.clone()),
    steps: Vec::new(),
  }
}

/// A prompt came back with an answer.
fn resolved(pending: Option<&Flow>, label: &str, response: Response, windows: &Windows) -> Outcome {
  if response == Response::Cancel {
    // Cancel aborts the *whole* flow, not just this window's turn: nothing
    // else is prompted, no further window closes, and the app does not quit.
    // The window that cancelled keeps its unsaved work — it was never asked
    // to save, and cancelling is not an admission that the work is dealt
    // with.
    //
    // Clearing `pending` is what lets a later Cmd-Q or Cmd-Shift-W start
    // over. An aborted flow that left state behind would leave the app
    // unable to ever quit again, which is a far worse outcome than the one
    // Cancel asked for.
    return Outcome {
      pending: None,
      steps: Vec::new(),
    };
  }

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
  // longer dirty (and, for Close Window, no longer there at all), and asking
  // about it again would prompt it forever.
  let windows = match flow {
    // Quit leaves every window open until the very end — the process exit
    // itself is what closes them.
    Flow::Quit => windows.marked_clean(label),
    Flow::CloseGroup { .. } => {
      // Close Window's whole point is to actually close each tab, so a tab
      // that has resolved its prompt is destroyed right here. This is also
      // why its frontend prompt does not clear its own changed flag the way
      // the Quit one does: this window is about to stop existing, and its
      // dirty entry goes with it.
      steps.push(Step::Destroy {
        label: label.to_string(),
      });
      windows.destroyed(label)
    }
  };

  drive(flow.clone(), &windows, steps)
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
    // The group as it stood the moment Cmd-Shift-W was pressed, walked in
    // order. The list is never re-queried mid-walk: it came from AppKit once
    // (see `Input::StartCloseGroup`), and "which tabs did the user ask to
    // close" is settled at that press, not continuously renegotiated as tabs
    // come and go.
    Flow::CloseGroup { mut remaining } => loop {
      if remaining.is_empty() {
        // Every tab in the group has been dealt with. Note there is no
        // `Step::Exit` on this path however many windows are left: Close
        // Window closes a tab group, and whether the process then goes away
        // is the OS's own last-window-closed exit to decide.
        return Outcome { pending: None, steps };
      }
      // Taken off the list *before* being acted on, so the answer that comes
      // back later resumes from the rest rather than re-visiting this one.
      let label = remaining.remove(0);

      if !windows.is_live(&label) {
        // Already closed through some other route — its own Close Tab, the
        // traffic light, or dragged out of the group and closed — between
        // the group being captured and the walk reaching it. Nothing to
        // destroy and nobody to ask. Same staleness rule Quit's walk
        // follows, asked through the same accessor rather than re-derived.
        continue;
      }

      if !windows.is_dirty(&label) {
        // No unsaved work: close it without asking. This is the case that
        // makes `drive` a loop rather than a single decision — a group of
        // clean tabs has to close in one go, not one tab per round trip out
        // through the adapter and back.
        steps.push(Step::Destroy { label: label.clone() });
        continue;
      }

      steps.push(Step::Prompt {
        label,
        event: PROMPT_CLOSE_GROUP,
      });
      return Outcome {
        pending: Some(Flow::CloseGroup { remaining }),
        steps,
      };
    },
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

    assert!(
      app.exited,
      "the re-entrant dirty check must let this exit through"
    );
    assert!(!app.windows().any_dirty());
  }

  /// Cancel is not "skip this window" — it abandons the whole flow. Nothing
  /// further is prompted, nothing closes, the app does not quit, and
  /// `pending` is cleared so a later Cmd-Q can start over. An aborted flow
  /// that left state behind would leave the app unable to ever quit again,
  /// which is a worse outcome than the one Cancel asked for.
  #[test]
  fn cancel_mid_walk_abandons_the_whole_flow() {
    let mut app = App::new(
      &[("win-1", true), ("win-2", true), ("win-3", true)],
      &["win-1", "win-2", "win-3"],
    );

    app.send(Input::StartQuit);
    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Proceed,
    });
    app.send(Input::Resolved {
      label: "win-2".to_string(),
      response: Response::Cancel,
    });

    assert_eq!(app.prompted(), vec!["win-1", "win-2"]);
    assert!(!app.log.contains(&Step::Exit));
    assert!(!app.exited);
    assert_eq!(app.pending, None, "a cancelled flow must not block the next one");
    // win-2 was never asked to save, so it stays dirty — cancelling is not
    // an admission that the work is dealt with.
    assert!(app.windows().is_dirty("win-2"));

    // And the app can still quit afterwards.
    app.send(Input::StartQuit);
    assert_eq!(app.prompted(), vec!["win-1", "win-2", "win-2"]);
  }

  /// A window can vanish between two answers — the user closes it through
  /// the traffic light while another window's prompt is up. The walk must
  /// step over it rather than stalling on a prompt nobody can see.
  #[test]
  fn a_window_that_vanishes_mid_walk_is_stepped_over() {
    let mut app = App::new(&[("win-1", true), ("win-2", true)], &["win-1", "win-2"]);

    app.send(Input::StartQuit);
    assert_eq!(app.prompted(), vec!["win-1"]);

    // win-2 goes away while win-1's prompt is still open. Its dirty entry
    // is deliberately left behind: `Destroyed` has not been delivered yet,
    // which is exactly the race this has to survive.
    app.live.retain(|l| l != "win-2");

    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Proceed,
    });

    assert_eq!(app.prompted(), vec!["win-1"], "win-2 no longer exists to prompt");
    assert!(app.log.contains(&Step::Forget {
      label: "win-2".to_string()
    }));
    assert!(app.exited);
  }

  /// The re-entrancy trap, and the reason both flows go through one
  /// function. Cmd-Q pressed twice — whether the OS re-delivers the
  /// keystroke or the user genuinely presses it again while the first
  /// press's prompt is still open — must not start a second walk on top of
  /// the first. A second walk would re-prompt a window that is already
  /// showing a prompt.
  #[test]
  fn a_second_quit_press_does_not_restart_the_walk() {
    let mut app = App::new(&[("win-1", true), ("win-2", true)], &["win-1", "win-2"]);

    app.send(Input::StartQuit);
    app.send(Input::StartQuit);
    app.send(Input::StartQuit);

    assert_eq!(app.prompted(), vec!["win-1"]);
    assert_eq!(app.pending, Some(Flow::Quit), "the first walk is left running");
  }

  /// Same guard across the two flows: Close Window pressed during a Quit
  /// walk, and Quit pressed during a Close Window walk, are both ignored.
  /// This is the case a second, near-identical copy of the walk would have
  /// missed — each copy would only have guarded against itself.
  #[test]
  fn the_two_flows_do_not_stack_on_each_other() {
    let mut quitting = App::new(&[("win-1", true)], &["win-1", "win-2"]);
    quitting.send(Input::StartQuit);
    quitting.send(Input::StartCloseGroup {
      group: live(&["win-1", "win-2"]),
    });

    assert_eq!(quitting.prompted(), vec!["win-1"]);
    assert_eq!(quitting.pending, Some(Flow::Quit));
    assert!(!quitting.log.iter().any(|s| matches!(s, Step::Destroy { .. })));

    let mut closing = App::new(&[("win-1", true), ("win-2", true)], &["win-1", "win-2"]);
    closing.send(Input::StartCloseGroup {
      group: live(&["win-1"]),
    });
    closing.send(Input::StartQuit);

    assert_eq!(closing.prompted(), vec!["win-1"]);
    assert_eq!(
      closing.pending,
      Some(Flow::CloseGroup { remaining: vec![] }),
      "the close walk is left running, at the point it had reached"
    );
    assert!(!closing.log.contains(&Step::Exit));
  }

  // ---- Close Window (the tab-group walk) ---------------------------------

  /// Clean tabs close without being asked anything, and they close in one
  /// go rather than one per round trip — the whole group goes in a single
  /// advance.
  #[test]
  fn close_group_destroys_every_clean_tab_without_prompting() {
    let mut app = App::new(
      &[("win-1", false), ("win-2", false)],
      &["win-1", "win-2", "other"],
    );

    app.send(Input::StartCloseGroup {
      group: live(&["win-1", "win-2"]),
    });

    assert!(app.prompted().is_empty());
    assert_eq!(
      app.log,
      vec![
        Step::Destroy {
          label: "win-1".to_string()
        },
        Step::Destroy {
          label: "win-2".to_string()
        },
      ]
    );
    assert_eq!(app.pending, None);
    // A window outside the group is untouched: Close Window closes a tab
    // group, not the app.
    assert_eq!(app.live, vec!["other".to_string()]);
    assert!(!app.log.contains(&Step::Exit));
  }

  /// The dirty tab in the middle of a group stops the walk, is prompted with
  /// Close Window's own event (never Quit's — the frontend does something
  /// different with each, because a window survives a quit and does not
  /// survive this), and is destroyed once it answers. The walk then picks up
  /// from where it left off.
  #[test]
  fn close_group_prompts_a_dirty_tab_then_destroys_it_and_carries_on() {
    let mut app = App::new(
      &[("win-1", false), ("win-2", true), ("win-3", false)],
      &["win-1", "win-2", "win-3"],
    );

    app.send(Input::StartCloseGroup {
      group: live(&["win-1", "win-2", "win-3"]),
    });

    assert_eq!(
      app.log,
      vec![
        Step::Destroy {
          label: "win-1".to_string()
        },
        Step::Prompt {
          label: "win-2".to_string(),
          event: "menu-close-window-group",
        },
      ],
      "the walk stops at the first dirty tab, with win-3 untouched"
    );
    assert!(app.live.contains(&"win-3".to_string()));

    app.send(Input::Resolved {
      label: "win-2".to_string(),
      response: Response::Proceed,
    });

    assert_eq!(app.live, Vec::<String>::new());
    assert_eq!(app.pending, None);
    assert!(
      !app.log.contains(&Step::Exit),
      "closing a group never quits the app"
    );
  }

  /// Cancelling one tab's prompt leaves the rest of the group open — the
  /// same "abort the whole flow" rule Quit has, and the reason both go
  /// through one `resolved`.
  #[test]
  fn cancelling_one_tab_leaves_the_rest_of_the_group_open() {
    let mut app = App::new(&[("win-1", true), ("win-2", false)], &["win-1", "win-2"]);

    app.send(Input::StartCloseGroup {
      group: live(&["win-1", "win-2"]),
    });
    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Cancel,
    });

    assert_eq!(app.live, vec!["win-1".to_string(), "win-2".to_string()]);
    assert_eq!(app.pending, None);
  }

  /// A tab that left the group between the group being captured and the
  /// walk reaching it — closed through its own Close Tab, or dragged out and
  /// closed — is stepped over. Nothing to destroy, nobody to ask. This is
  /// the same staleness rule Quit's walk uses, asked through the same
  /// accessor rather than re-derived here.
  #[test]
  fn close_group_steps_over_a_tab_that_has_already_gone() {
    let mut app = App::new(&[("win-2", true)], &["win-2"]);

    app.send(Input::StartCloseGroup {
      group: live(&["win-1", "win-2"]),
    });

    assert_eq!(
      app.log,
      vec![Step::Prompt {
        label: "win-2".to_string(),
        event: "menu-close-window-group",
      }],
      "win-1 is gone: no destroy, no prompt"
    );
  }

  /// Closing the last group leaves the app running with no windows: Close
  /// Window never exits by itself. Whether the process then goes away is
  /// the OS's "last window closed" exit, which `ExitRequested` handles on
  /// its own terms — and by then nothing live is dirty.
  #[test]
  fn close_group_never_exits_the_app_itself() {
    let mut app = App::new(&[("win-1", true)], &["win-1"]);

    app.send(Input::StartCloseGroup {
      group: live(&["win-1"]),
    });
    app.send(Input::Resolved {
      label: "win-1".to_string(),
      response: Response::Proceed,
    });

    assert!(!app.log.contains(&Step::Exit));
    assert!(!app.windows().any_dirty());
  }
}
