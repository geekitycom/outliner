import { afterEach } from 'vitest'
import { suspended } from '../src/caret'

// jsdom doesn't implement these; the cursor / scroll code paths call them
// incidentally. Stub so they don't throw during structural tests.
if (typeof document.execCommand !== 'function') {
  Object.defineProperty(document, 'execCommand', {
    value: () => true,
    configurable: true,
  })
}
window.scrollTo = () => {}

// Keep the shared document clean between tests.
afterEach(() => {
  document.body.innerHTML = ''
  // Caret ownership is page-wide state (src/caret.ts), and emptying the body
  // does not release a claim -- the stack knows nothing about test boundaries.
  // A test that opens a title-row edit or claims for a dialog and never closes
  // it therefore leaves every outline in every later test suspended, and those
  // tests fail somewhere far away from the one at fault. Failing here instead
  // names the culprit, which is the whole point: this check has already earned
  // itself twice.
  if (suspended()) {
    throw new Error(
      'this test left a claim on the caret in force (an open title-row edit, or a ' +
        'claim() whose disposable was never called). Close it out before the test ends.',
    )
  }
})
