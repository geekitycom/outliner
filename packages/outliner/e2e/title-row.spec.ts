import { test, expect, type Page } from '@playwright/test'

/** The page's outliner instance, typed the way the other specs do it. */
type PageOutliner = {
  outliner: {
    toOpml(): string
    getTitle(): string
    loadOpml(x: string): void
    hoist(): boolean
    deHoist(): boolean
  }
}

function toOpml(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as PageOutliner).outliner.toOpml())
}

// The title row's focus behavior can only be tested in a real browser. jsdom
// gives every element zero size, so `visibleRoots()` finds nothing and the
// document-level mouseup handler in globals.ts never reaches the branch that
// pulls focus back to the pasteBin — the branch that made the row impossible
// to type into when it first shipped. A unit test here would pass whether or
// not the bug existed, which is why this lives in the e2e suite instead.
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

  test('toOpml() includes a title typed but not yet blurred out of', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')

    await page.locator('.concord-title-row .concord-text').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Unblurred')

    // Saving straight from the field must not write the previous title.
    expect(await toOpml(page)).toContain('<title>Unblurred</title>')
  })

  test('an edit started on the title lands on the title, even if a hoist intervenes', async ({
    page,
  }) => {
    await page.goto('/e2e/fixtures/title-row.html')
    const title = page.locator('.concord-title-row .concord-text')

    // Start editing the *document title*...
    await title.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('My Notes')

    // ...lose focus the way a native menu does (no blur), so the pending edit
    // is settled by the next refresh rather than by the field itself...
    await stealFocusWithoutBlur(page)

    // ...then hoist. That refresh now settles the edit, and the row's target
    // has already flipped from the title to the hoisted headline. Resolving
    // the target at commit time wrote "My Notes" into the newly hoisted
    // headline — renaming the wrong thing and dropping the title edit. The
    // target is captured when the edit begins, so it still lands on the title.
    await page.evaluate(() => (window as unknown as PageOutliner).outliner.hoist())

    expect(
      await page.evaluate(() => (window as unknown as PageOutliner).outliner.getTitle()),
    ).toBe('My Notes')

    // ...and the hoisted headline keeps its own text.
    await page.evaluate(() => (window as unknown as PageOutliner).outliner.deHoist())
    expect(await toOpml(page)).toContain('text="a"')
  })

  test('typing in the row does not reach the outline', async ({ page }) => {
    await page.goto('/e2e/fixtures/title-row.html')

    const before = await toOpml(page)
    await page.locator('.concord-title-row .concord-text').click()

    // Tab would reorganize a headline, and typing would edit one, if the
    // outline's own keydown handling were still live while the field has
    // focus. stopListening() is what prevents that.
    await page.keyboard.type('x')
    await page.keyboard.press('Tab')

    // Compare only the <body>: the OPML head carries a dateModified stamped
    // per call, which differs between two reads regardless of any edit.
    const bodyOf = (opml: string) => opml.slice(opml.indexOf('<body>'))
    expect(bodyOf(await toOpml(page))).toBe(bodyOf(before))
  })
})
