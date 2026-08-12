# Break the focus API at 0.2.0 rather than keep no-arg wrappers

`stopListening()`, `resumeListening()`, `getFocusRoot()` and `setFocusRoot()` were removed from the
published interface and replaced by caret ownership, which hands out a disposable rather than
toggling a global. Consumers that suspended the outliner now hold the value returned by the claim
and call it to release.

The old pair could not be fixed in place. `stopListening()` did nothing if already stopped and
`resumeListening()` re-enabled for everyone, so with two suspenders — the title row and the desktop
app's modal both used them — whichever released first released the other's suspension too. A
no-arg `resume` fundamentally cannot know whether its caller is the one who suspended; correctness
requires an owner identity, which means the signature has to change.

## Considered options

**Keep the old names as deprecated no-arg wrappers** over an anonymous token. Rejected: it
preserves compatibility by preserving the bug — anyone still calling the wrapper keeps the exact
defect the change exists to remove. That is a compatibility promise not worth keeping.

**Break cleanly (chosen).** The package was at 0.1.0 with a single published version and no known
external consumers; the only caller across the package seam was in this repo. Pre-1.0 semver is
for precisely this.

## Consequences

`onResume` survives this change rather than being deleted with the rest. Its only caller is the
Concord compatibility layer's `opLink`, for an old app calling it from its own modal — and compat
is a documented, separately-built artifact, so a silent no-op there would be a real regression
rather than a hypothetical one. It is re-homed to fire when the *outline* regains the caret.
