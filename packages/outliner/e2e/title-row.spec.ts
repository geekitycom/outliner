import { test, expect, type Page } from '@playwright/test'

/** The page's outliner instance, typed the way the other specs do it. */
type PageOutliner = {
  outliner: {
    toOpml(): string
    getTitle(): string
    loadOpml(x: string): void
    hoist(): boolean
  }
}

function toOpml(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as PageOutliner).outliner.toOpml())
}

// What is left in this file after caret ownership became push-based
// (docs/adr/0001): the cases that need a real browser, and two that are
// deliberately duplicated in test/title-row.test.ts.
//
// Most of the row's behavior used to have to live here. Ownership was decided
// by asking which outline roots were visible, via `offsetParent`, which jsdom
// always reports as null — so keystroke dispatch did nothing at all under
// Vitest and a unit test would have passed whether or not the bug it named
// existed. That is no longer true, and the bookkeeping cases (what ends up in
// the saved OPML, which thing an edit lands on) have moved down to the unit
// suite where they run in milliseconds.
//
// The tests that stayed need something jsdom does not have: real layout and
// real pointer input. A `page.click()` lands at a coordinate, hits whatever is
// actually painted there, and moves focus as the browser's own default action —
// which is precisely the sequence that made this row impossible to type into
// when it first shipped, and no dispatched event in jsdom reproduces it.
test.describe('title row', () => {
  test('clicking the row focuses it and typing edits the document title', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')

    const title = page.locator('.concord-title-row .concord-text')
    await expect(title).toHaveText('My Document')

    await title.click()

    // The regression: the outline used to yank focus straight back to its
    // pasteBin on the mouseup, so the field never held focus at all.
    await expect(title).toBeFocused()

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Renamed')
    await page.keyboard.press('Enter')

    await expect(title).toHaveText('Renamed')
    expect(
      await page.evaluate(() => (window as unknown as PageOutliner).outliner.getTitle()),
    ).toBe('Renamed')
    expect(await toOpml(page)).toContain('<title>Renamed</title>')
  })

  // A native Save/Open panel takes focus away from the field without a blur
  // ever reaching it, so commit() never runs and the `editing` flag sticks.
  // That froze the row on stale text and made it permanently uneditable.
  // Reproduced here by suppressing the blur notification, which is the only
  // part of that a headless browser can stage.
  async function stealFocusWithoutBlur(page: Page) {
    await page.evaluate(() => {
      const el = document.querySelector('.concord-title-row .concord-text') as HTMLElement
      // `once` matters: the suppressor must swallow exactly this one blur.
      // Left installed, it would also eat the blur of a *later* deliberate
      // commit and fail the test for a reason that has nothing to do with
      // the bug being reproduced.
      el.addEventListener('blur', (e) => e.stopImmediatePropagation(), {
        capture: true,
        once: true,
      })
      ;(document.querySelector('.pasteBin') as HTMLElement).focus()
    })
  }

  // The next two also exist in test/title-row.test.ts, on purpose. They are the
  // only cases here that turn on focus being *lost*, and that is where jsdom
  // only approximates Chromium: the unit copy stages the missing blur by
  // suppressing the event, whereas here it genuinely never fires. Keeping both
  // means a divergence between the two engines shows up as a failing test
  // rather than as a bug report — the cheap copy runs on every change, this one
  // keeps it honest. Delete this pair only together, and only if you are
  // willing to stop hearing about that difference.
  test('still refreshes after focus is lost without a blur', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')
    const title = page.locator('.concord-title-row .concord-text')

    await title.click()
    await stealFocusWithoutBlur(page)

    await page.evaluate(() =>
      (window as unknown as PageOutliner).outliner.loadOpml(
        '<opml version="2.0"><head><title>Opened File</title></head>' +
          '<body><outline text="z"/></body></opml>',
      ),
    )

    await expect(title).toHaveText('Opened File')
  })

  test('is still editable after focus is lost without a blur', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')
    const title = page.locator('.concord-title-row .concord-text')

    await title.click()
    await stealFocusWithoutBlur(page)

    await title.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Edited After Save')
    await page.keyboard.press('Enter')

    await expect(title).toHaveText('Edited After Save')
    expect(
      await page.evaluate(() => (window as unknown as PageOutliner).outliner.getTitle()),
    ).toBe('Edited After Save')
  })

  test('takes a click while the outline is editing a headline', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')
    const title = page.locator('.concord-title-row .concord-text')

    // Put the outline into text-edit mode, which is the state a hoist leaves
    // it in. Handing the caret back to an outline goes two different ways —
    // pasteBinFocus() when idle, focusCursor() when editing text — and when
    // those two branches were written out separately, only the first was
    // guarded against stealing the caret from this row. So the row worked
    // until you hoisted, then stopped taking clicks at all. Both branches now
    // live in one place (`Outliner.caretOwner().focus`) and neither can take
    // the caret while this row holds a claim on it.
    await page.locator('.concord-root .concord-text').first().dblclick()
    await expect(page.locator('.concord-root .concord-text').first()).toBeFocused()

    await title.click()
    await expect(title).toBeFocused()

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Edited While Outline Was Editing')
    await page.keyboard.press('Enter')
    await expect(title).toHaveText('Edited While Outline Was Editing')
  })

  test('takes a click after a hoist', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')
    const title = page.locator('.concord-title-row .concord-text')

    await page.locator('.concord-root .concord-text').first().dblclick()
    await page.evaluate(() => (window as unknown as PageOutliner).outliner.hoist())

    await title.click()
    await expect(title).toBeFocused()
  })
})
