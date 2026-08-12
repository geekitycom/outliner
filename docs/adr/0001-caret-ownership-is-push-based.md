# Caret ownership is push-based, with no visibility scan

Caret ownership is derived from real `focusin`/`focusout` events, classified by **containment** —
a focus landing inside a registered outline root (or its pasteBin) means that outline owns the
caret; anything else is a field. There is deliberately no scan of which roots are on screen.

The code this replaced polled a fact the browser already pushes: it asked `offsetParent !== null`
to find the visible roots, then picked one, and did so from inside a *getter* that mutated as a
side effect. That had two costs. It made a read steal focus, which is the shape behind several
bugs (a stray mouseup or a keystroke could move the caret). And `offsetParent` is one of the few
things jsdom does not implement, so the entire focus state machine was unreachable from the unit
suite — verified: keystroke dispatch did nothing at all under Vitest, and every focus fix had to
be caught in Playwright instead.

## Considered options

**Inject `isVisible` as a port**, with `offsetParent` in the browser and a stub in tests. Rejected:
the only second adapter would exist to serve tests, which is a hypothetical seam by our own rule —
one adapter and a stub. It also keeps the polling, and with it the getter that mutates.

**Push-based (chosen).** Verified against jsdom before deciding: it fires `focusin`/`focusout`
correctly on `contenteditable` elements and tracks `activeElement` faithfully. So the module needs
no injection at all, because it depends only on mechanisms jsdom actually implements.

## Consequences

Classification is structural, so it subsumes what used to be four duplicated guards plus an
`input`/`textarea` special case. The title row reads as a field because it is a *sibling* of the
outline root, not because its CSS class is on an allowlist — a hidden panel's outline simply never
receives focus, so it never owns the caret and no layout query is needed to work that out.

If you find yourself reaching for `offsetParent`, `getBoundingClientRect`, or "which roots are
visible" to answer an ownership question, that is the mistake this decision exists to prevent.
