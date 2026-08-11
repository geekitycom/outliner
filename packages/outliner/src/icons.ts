// Inline-SVG icon registry that replaces Font Awesome.
//
// Icons are rendered as CSS masks on a `<span class="node-icon" data-icon="...">`.
// The span carries only a `data-icon` attribute, so it survives cloneNode(true)
// (which is how undo / drag / copy work). The actual glyph is a mask-image, and
// the visible color comes from the span's background-color (set in styles.css by
// state: silver / black / white). State glyphs (comment, drag targets) override
// the mask in CSS, matching the original Concord architecture.

/**
 * name -> inner SVG markup (24x24 viewBox). All glyphs are from Mono Icons
 * (Iconify prefix `mi`) for a consistent monoline look, except `rss`, which
 * Mono Icons has no glyph for and so comes from Material Design Icons
 * (`mdi`). Fills are opaque so the shapes read cleanly as CSS masks.
 */
export const ICONS: Record<string, string> = {
  // mi:caret-right (the default bullet), scaled up ~1.5x about center so the
  // triangle fills more of the box and matches the original bullet size.
  'caret-right': '<path d="M9 4.5l9 7.5l-9 7.5z"/>',
  // Concord marked comment nodes with a double-left chevron («, FA \f100).
  // mi:chevron-double-left.
  comment:
    '<path d="M17.707 5.293a1 1 0 0 1 0 1.414L12.414 12l5.293 5.293a1 1 0 0 1-1.414 1.414l-6-6a1 1 0 0 1 0-1.414l6-6a1 1 0 0 1 1.414 0m-6 0a1 1 0 0 1 0 1.414L6.414 12l5.293 5.293a1 1 0 0 1-1.414 1.414l-6-6a1 1 0 0 1 0-1.414l6-6a1 1 0 0 1 1.414 0"/>',
  // mi:arrow-down / mi:arrow-right — the drag drop-target indicators.
  'arrow-down':
    '<path d="M12 4a1 1 0 0 1 1 1v11.586l4.293-4.293a1 1 0 0 1 1.414 1.414l-6 6a1 1 0 0 1-1.414 0l-6-6a1 1 0 1 1 1.414-1.414L11 16.586V5a1 1 0 0 1 1-1"/>',
  'arrow-right':
    '<path d="M12.293 5.293a1 1 0 0 1 1.414 0l6 6a1 1 0 0 1 0 1.414l-6 6a1 1 0 0 1-1.414-1.414L16.586 13H5a1 1 0 1 1 0-2h11.586l-4.293-4.293a1 1 0 0 1 0-1.414"/>',

  // type icons (referenced by appTypeIcons)
  // mi:document — outlined page, folded corner, text lines.
  'file-text-alt':
    '<path d="M4 4a2 2 0 0 1 2-2h8a1 1 0 0 1 .707.293l5 5A1 1 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm13.586 4L14 4.414V8zM12 4H6v16h12V10h-5a1 1 0 0 1-1-1zm-4 9a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1m0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1"/>',
  // mi:laptop
  laptop:
    '<path d="M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm18 0H4v11h16zm2 15a1 1 0 0 1-1 1H3a1 1 0 1 1 0-2h18a1 1 0 0 1 1 1"/>',
  // mi:share
  'share-alt':
    '<path d="M11.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1-1.414 1.414L13 5.414V15a1 1 0 1 1-2 0V5.414L9.707 6.707a1 1 0 0 1-1.414-1.414zM4 11a2 2 0 0 1 2-2h2a1 1 0 0 1 0 2H6v9h12v-9h-2a1 1 0 1 1 0-2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  // mi:bookmark — outlined bookmark ribbon.
  'bookmark-empty':
    '<path d="M4 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v17a1 1 0 0 1-1.581.814L12 17.229l-6.419 4.585A1 1 0 0 1 4 21zm14 0H6v15.057l5.419-3.87a1 1 0 0 1 1.162 0L18 19.056z"/>',
  // mi:camera — outlined camera body with lens ring.
  camera:
    '<path d="M8.293 4.293A1 1 0 0 1 9 4h6a1 1 0 0 1 .707.293L17.414 6H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.586zM9.414 6L7.707 7.707A1 1 0 0 1 7 8H4v10h16V8h-3a1 1 0 0 1-.707-.293L14.586 6zM12 10.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4m-4 2a4 4 0 1 1 8 0a4 4 0 0 1-8 0"/>',
  // mi:refresh
  refresh:
    '<path d="M12.793 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L14.086 7H12.5C8.952 7 6 9.952 6 13.5S8.952 20 12.5 20s6.5-2.952 6.5-6.5a1 1 0 1 1 2 0c0 4.652-3.848 8.5-8.5 8.5S4 18.152 4 13.5S7.848 5 12.5 5h1.586l-1.293-1.293a1 1 0 0 1 0-1.414"/>',
  // mi:message — used for thread/comments type.
  comments:
    '<path d="M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4.586l-2.707 2.707a1 1 0 0 1-1.414 0L8.586 19H4a2 2 0 0 1-2-2zm18 0H4v11h5a1 1 0 0 1 .707.293L12 19.586l2.293-2.293A1 1 0 0 1 15 17h5zM6 9.5a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1m0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1"/>',
  // mi:grid — used for thumblist type.
  th: '<path d="M3 5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm6 0H5v4h4zm4 0a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2zm6 0h-4v4h4zM3 15a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm6 0H5v4h4zm4 0a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2zm6 0h-4v4h4z"/>',
  // mi:user
  user: '<path d="M12 4a4 4 0 1 0 0 8a4 4 0 0 0 0-8M6 8a6 6 0 1 1 12 0A6 6 0 0 1 6 8m2 10a3 3 0 0 0-3 3a1 1 0 1 1-2 0a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5a1 1 0 1 1-2 0a3 3 0 0 0-3-3z"/>',
  // mi:calendar
  calendar:
    '<path d="M9 2a1 1 0 0 1 1 1v1h4V3a1 1 0 1 1 2 0v1h3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3V3a1 1 0 0 1 1-1M8 6H5v3h14V6h-3v1a1 1 0 1 1-2 0V6h-4v1a1 1 0 0 1-2 0zm11 5H5v8h14z"/>',
  // mdi:rss — Mono Icons has no RSS glyph, so this one is Material Design Icons.
  rss: '<path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19 7.38 20 6.18 20C5 20 4 19 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27zm0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93z"/>',
  // mi:text — a serif capital T. Not in appTypeIcons below (that map is a
  // faithful port of the original concordutils.js), so it's here for
  // consumers to wire up through `prefs.typeIcons` themselves.
  text: '<path d="M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1a1 1 0 1 1-2 0V6h-4v12h1a1 1 0 1 1 0 2h-4a1 1 0 1 1 0-2h1V6H7v1a1 1 0 0 1-2 0z"/>',
}

/** Default icon name for a plain node. */
export const DEFAULT_ICON = 'caret-right'

/**
 * The type -> icon map from the original concordutils.js, exported for demos
 * and as a sensible default for `prefs.typeIcons`.
 */
export const appTypeIcons: Record<string, string> = {
  blogpost: 'file-text-alt',
  code: 'laptop',
  html: 'file-text-alt',
  include: 'share-alt',
  index: 'file-text-alt',
  link: 'bookmark-empty',
  outline: 'file-text-alt',
  photo: 'camera',
  presentation: 'file-text-alt',
  redirect: 'refresh',
  river: 'file-text-alt',
  rss: 'rss',
  tabs: 'file-text-alt',
  thread: 'comments',
  thumblist: 'th',
  profile: 'user',
  calendar: 'calendar',
  markdown: 'file-text-alt',
  metaWeblogPost: 'file-text-alt',
}

function svgDataUri(inner: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function maskRule(selector: string, inner: string): string {
  const uri = svgDataUri(inner)
  return `${selector}{-webkit-mask-image:${uri};mask-image:${uri};}`
}

let injected = false

/**
 * Inject the icon mask stylesheet once per document. Generates a mask rule for
 * every registered icon plus the state overrides (comment / drag targets) that
 * Concord drove through Font Awesome `content` glyphs.
 */
export function injectIconStyles(doc: Document = document): void {
  if (injected || doc.getElementById('outliner-icon-styles')) {
    injected = true
    return
  }
  const rules: string[] = []
  for (const name of Object.keys(ICONS)) {
    rules.push(maskRule(`.node-icon[data-icon="${name}"]`, ICONS[name]))
  }
  // State glyphs: higher specificity so they win over the base [data-icon] rule.
  // Descendant selector (matching the original concordstyles.css) so every icon
  // inside a comment's subtree — the comment node and all its children — shows
  // the comment glyph.
  rules.push(
    maskRule('.concord-node.concord-comment .node-icon', ICONS.comment),
  )
  rules.push(
    maskRule(
      '.concord-node.drop-sibling > .concord-wrapper .node-icon',
      ICONS['arrow-down'],
    ),
  )
  rules.push(
    maskRule(
      '.concord-node.drop-child > .concord-wrapper .node-icon',
      ICONS['arrow-right'],
    ),
  )
  const style = doc.createElement('style')
  style.id = 'outliner-icon-styles'
  style.textContent = rules.join('\n')
  doc.head.appendChild(style)
  injected = true
}

/** Build the icon span markup for a given icon name. */
export function iconHtml(name: string): string {
  const safe = ICONS[name] ? name : DEFAULT_ICON
  return `<span class="node-icon" data-icon="${safe}"></span>`
}

/** Set the icon on an existing `.node-icon` element. */
export function setIcon(iconEl: Element, name: string): void {
  iconEl.setAttribute('data-icon', ICONS[name] ? name : DEFAULT_ICON)
}
