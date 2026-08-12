import { afterEach } from 'vitest'

// Every sheet this app opens goes through the native <dialog> element
// (src/modal.ts). jsdom ships HTMLDialogElement and reflects its `open`
// attribute, but as of jsdom 29 it implements none of the methods: showModal(),
// show() and close() are all absent, and so is `returnValue`. Without them the
// very first line of any UI test is a TypeError from inside modal.ts, so stub
// in the part of the element's behaviour the app actually depends on.
//
// This is a stand-in for a missing platform feature, not a mock of our own
// code: modal.ts, and everything built on it, runs for real against it. Kept to
// exactly what the app uses, deliberately -- a fuller emulation (the top layer,
// inertness of the rest of the page, light-dismiss, Esc firing `cancel`) would
// be a lot of behaviour asserted by nothing, and jsdom growing real support
// should replace this rather than have it linger alongside.
//
// Two fidelity gaps to know about before writing a test that leans on them:
// the real close() queues a task and fires `close` asynchronously whereas this
// fires it synchronously, and a real browser sets returnValue from the submit
// button of a `method="dialog"` form, which jsdom does not do at all. Tests
// that care about a returned value should pass it to close() explicitly.
const dialogPrototype = window.HTMLDialogElement.prototype
if (typeof dialogPrototype.showModal !== 'function') {
  dialogPrototype.returnValue = ''
  dialogPrototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  dialogPrototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    if (returnValue !== undefined) this.returnValue = returnValue
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}

// jsdom has no layout, so it has no scrolling either; the outliner library
// scrolls the cursor headline into view as a matter of course. Stub so that
// incidental call doesn't throw in the middle of a test about something else.
// (packages/outliner/test/setup.ts does the same, for the same reason.)
window.scrollTo = () => {}

// Keep the shared document clean between tests.
//
// This matters more here than it looks. showModal() in src/modal.ts appends
// its <dialog> to document.body and only removes it on the dialog's `close`
// event, so a test that opens a sheet and never closes it leaves that dialog
// in the document -- and the next test's query for, say, ".shortcuts h3" would
// then match two sheets' worth of headings and fail for a reason that has
// nothing to do with the code it was written to check.
//
// Note the deliberate difference from packages/outliner/test/setup.ts, which
// additionally asserts that no claim on the caret is still in force. That
// guard needs `suspended()` from the library's src/caret.ts, and the library
// exports only `claim` from its public entry point -- reaching past that into
// the package's internals to get it would be a worse trade than going without,
// since the leak it catches (an unclosed dialog) is already caught here by the
// dialogs themselves piling up in the body.
afterEach(() => {
  document.body.innerHTML = ''
})
