// Legacy-Concord compatibility global (side-effect entry).
//
// Building this entry produces `dist/outliner.compat.global.js`. Dropping that
// <script> on a page reproduces the old concordutils.js global surface — the
// bare `op*` functions, the `up`/`down`/`left`/`right` direction globals,
// `initialOpmltext`, `appTypeIcons`, and the string helpers — so an app written
// against classic Concord keeps working after you register an instance:
//
//   <link rel="stylesheet" href="outliner.css" />
//   <script src="outliner.compat.global.js"></script>
//   <script>
//     const o = Outliner.createOutliner(document.getElementById('outliner'))
//     setDefaultOutliner(o)          // the op* helpers act on this instance
//     opXmlToOutline(initialOpmltext)
//     opExpand()                     // exactly as the old app called it
//   </script>
//
// Unlike the clean `outliner.global.js` (which only defines `window.Outliner`),
// this one deliberately pollutes the global scope, matching concordutils.js.
import * as compat from './compat'

// Also define the namespaced `window.Outliner` (the IIFE `name`), same as the
// standard global build.
export * from './index'

const g = globalThis as unknown as Record<string, unknown>
for (const [key, value] of Object.entries(compat)) {
  g[key] = value
}

// If jQuery is already loaded, register the classic $(el).concord(options)
// plugin so old apps create the outliner exactly as before.
compat.installConcordJQueryPlugin()
