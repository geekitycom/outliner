import { test, expect, type Page } from '@playwright/test'

/** The page's outliner instance, typed the way the other specs do it. */
type PageOutliner = { outliner: { toOpml(): string; getTitle(): string } }

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
