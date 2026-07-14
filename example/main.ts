import { createOutliner, appTypeIcons, UP, DOWN, LEFT, RIGHT } from '../src'
import type { Direction, NodeRefApi } from '../src'
import '../src/styles.css'
import './example.css'

const initialOpml = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Outliner demo</title></head>
  <body>
    <outline text="Welcome to Outliner">
      <outline text="A TypeScript port of Concord — no jQuery, no Bootstrap, SVG icons.">
        <outline text="Click a bullet to expand or collapse."/>
        <outline text="Double-click the text to edit; arrow keys move the bar cursor."/>
        <outline text="Tab / Shift-Tab reorganize. Cmd/Ctrl-U/D/L/R move headlines."/>
      </outline>
      <outline text="Keyboard commands">
        <outline text="Cmd-B bold, Cmd-I italic, Cmd-\\ toggle comment"/>
        <outline text="Cmd-, expand/collapse, Cmd-Z undo"/>
      </outline>
      <outline text="Typed nodes render icons" type="outline">
        <outline text="An RSS feed" type="rss"/>
        <outline text="A link" type="link"/>
        <outline text="A photo" type="photo"/>
        <outline text="A comment line" isComment="true">
          <outline text="a child of the comment (also shows the comment bullet)"/>
        </outline>
      </outline>
    </outline>
  </body>
</opml>`

const app = document.getElementById('app')!
app.innerHTML = `
  <header>
    <h1>Outliner</h1>
    <p>Concord's outliner, ported to TypeScript. Drop-in vanilla-DOM component.</p>
  </header>
  <div class="toolbar" id="toolbar"></div>
  <div class="divOutlinerContainer"><div id="outliner"></div></div>
  <div class="status" id="status"></div>
`

const container = document.getElementById('outliner') as HTMLElement
const status = document.getElementById('status') as HTMLElement

const outliner = createOutliner(container, {
  prefs: {
    outlineFont: 'Georgia, serif',
    outlineFontSize: 17,
    outlineLineHeight: 24,
    renderMode: true,
    readonly: false,
    typeIcons: appTypeIcons,
  },
  callbacks: {
    opInsert: (node: NodeRefApi) => node.attributes.setOne('created', new Date().toUTCString()),
    opCursorMoved: () => render(),
  },
})

// Load the bundled sample on every open (like the original example0 — no
// persistence). Expanded so it's obviously an outliner.
outliner.loadOpml(initialOpml)
outliner.expandEverything()

// --- toolbar ----------------------------------------------------------------
const toolbar = document.getElementById('toolbar')!
type Cmd = [label: string, run: () => void]
const commands: (Cmd | 'sep')[] = [
  ['Expand', () => outliner.expand()],
  ['Collapse', () => outliner.collapse()],
  ['Expand all', () => outliner.expandEverything()],
  ['Collapse all', () => outliner.collapseEverything()],
  'sep',
  ['↑', () => reorg(UP)],
  ['↓', () => reorg(DOWN)],
  ['← promote', () => reorg(LEFT)],
  ['→ demote', () => reorg(RIGHT)],
  ['Promote subs', () => outliner.promote()],
  ['Demote subs', () => outliner.demote()],
  'sep',
  ['Bold', () => outliner.bold()],
  ['Italic', () => outliner.italic()],
  ['Comment', () => outliner.toggleComment()],
  ['Render', () => outliner.setRenderMode(!outliner.getRenderMode())],
  'sep',
  ['Undo', () => outliner.undo()],
  ['New', () => outliner.wipe()],
  ['Export OPML', () => console.log(outliner.toOpml())],
]

function reorg(dir: Direction) {
  outliner.reorg(dir)
}

for (const cmd of commands) {
  if (cmd === 'sep') {
    const s = document.createElement('span')
    s.className = 'sep'
    toolbar.appendChild(s)
    continue
  }
  const [label, run] = cmd
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', () => {
    run()
    render()
  })
  toolbar.appendChild(b)
}

// Readonly toggle — its label reflects the current state.
const readonlySep = document.createElement('span')
readonlySep.className = 'sep'
toolbar.appendChild(readonlySep)

const readonlyBtn = document.createElement('button')
function syncReadonly() {
  const on = outliner.prefs().readonly === true
  readonlyBtn.textContent = on ? 'Readonly: on' : 'Readonly: off'
  readonlyBtn.style.fontWeight = on ? '700' : '400'
}
readonlyBtn.addEventListener('click', () => {
  outliner.setReadonly(outliner.prefs().readonly !== true)
  syncReadonly()
  render()
})
syncReadonly()
toolbar.appendChild(readonlyBtn)

function render() {
  const line = outliner.getLineText()
  let attrs = ''
  if (line !== null) {
    attrs = Object.entries(outliner.cursor.attributes.getAll())
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ')
  }
  status.textContent =
    `title: ${outliner.getTitle()} · cursor: ${line ?? '(none)'}` +
    (attrs ? ` · ${attrs}` : '')
}
render()
