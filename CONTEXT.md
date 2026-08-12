# Outline Components

A keyboard-driven outliner whose native document format is OPML, ported from Concord, plus the
desktop app built on it. The language here is Concord's and MORE's, kept deliberately — this is a
port, and renaming the concepts would make the translation harder to verify.

## Language

### The outline

**Outline**:
A document: an ordered tree of headlines, plus its head data.
_Avoid_: file, tree, doc

**Headline**:
One line of text in an outline, together with everything nested beneath it.
_Avoid_: node, item, row, bullet, entry

**Subs**:
The headlines directly beneath a headline. Nothing implies "one level down" except this word.
_Avoid_: children, descendants, nested items

**Expanded / Collapsed**:
Whether a headline's subs are currently shown. A collapsed headline still has its subs; they are
simply not on screen.
_Avoid_: open/closed, visible/hidden

**Reorg**:
Moving the cursor headline through the tree — up, down, or across a level.
_Avoid_: move, reorder, drag, indent

**Promote / Demote**:
Lifting a headline's *subs* to sit alongside it, or pushing its following siblings beneath it.
Note the trap: promoting a **headline** is a reorg across a level, whereas promote/demote act on
that headline's **subs**. Two different operations, one pair of words — always say which.
_Avoid_: outdent/indent, unnest/nest

### Position and typing

**Cursor**:
The outline's own sense of place — the single headline currently being acted on. Arrow keys move
it. It exists whether or not anything is being typed.
_Avoid_: caret, focus, selection, current node, active node

**Caret**:
The text insertion point: where a typed character would land. A property of the whole page, not of
the outline.
_Avoid_: cursor, focus, insertion point

**Navigation**:
The state in which keystrokes are outline commands rather than text. The cursor moves between
headlines; nothing is being typed into.
_Avoid_: command mode, browse mode, selection mode

**Text mode**:
The state in which keystrokes are text, going into the cursor headline.
_Avoid_: edit mode, editing, input mode, insert mode

**Caret ownership**:
Which part of the interface the caret belongs to at a given moment — the outline, or some field
outside it such as the title row or a dialog. Only the owner may act on keystrokes, and only the
owner may take the caret.
_Avoid_: focus, focus root, active element, has focus

### Views onto an outline

**Hoist / De-hoist**:
Narrowing the view so a chosen headline's subs become the top level, and popping back out again.
Hoists nest. Hoisting changes only what is shown — never what the outline contains.
_Avoid_: zoom, drill in, focus (as a verb), filter

**Title row**:
The row above the outline naming what is currently being looked at — the outline's title normally,
or the hoisted headline while hoisted. It is not part of the outline and never appears in the
saved document.
_Avoid_: header, title bar, breadcrumb

### Head data

**Head data**:
An outline's document-level fields — its title and whatever else is recorded about the document as
a whole — as distinct from its headlines.
_Avoid_: metadata, frontmatter, properties, headers

**Authored head data**:
Head fields a person wrote and expects to find unchanged later. The title is one.
_Avoid_: user fields, custom fields

**Computed head data**:
Head fields regenerated from scratch every time the outline is saved — when it was last modified,
which headlines were expanded, where the cursor was. Consumed when an outline is opened, never
authored, and never reported as though a person had written them.
_Avoid_: derived fields, system fields, internal fields

### The desktop app

**Document**:
An outline together with the file it came from and whether it has unsaved work. A window shows
exactly one.
_Avoid_: file, buffer, tab, window

**Changed**:
The document has edits not yet written to its file. Note that revealing a collapsed headline counts,
because expansion state is saved with the document.
_Avoid_: dirty, modified, unsaved, touched

### Lineage

**Concord**:
The original JavaScript outliner this is a port of, by Kyle Shank and Dave Winer. Where behaviour
here looks unusual, Concord is usually the reason.
_Avoid_: upstream, the original, legacy
