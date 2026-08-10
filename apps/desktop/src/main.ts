import { createOutliner, EMPTY_OPML } from '@andrewshell/outliner'
import '@andrewshell/outliner/styles.css'
import './styles.css'

// Deliberately thin: this just proves the scaffold mounts the outliner
// full-window. Document state, the native menu, the unsaved-changes modal,
// and the keyboard-shortcuts sheet land in follow-up commits.
const container = document.getElementById('app') as HTMLElement
const outliner = createOutliner(container)
outliner.loadOpml(EMPTY_OPML)
