import { afterEach } from 'vitest'

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
})
