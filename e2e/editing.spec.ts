import { test, expect, type Page } from '@playwright/test'

/** Read the outline structure from the page's window.outliner.toOpml(). */
async function structure(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { outliner: { toOpml(): string } }
    const doc = new DOMParser().parseFromString(w.outliner.toOpml(), 'application/xml')
    const tops = Array.from(doc.querySelectorAll('body > outline'))
    const kids = tops[0]
      ? Array.from(tops[0].children).filter(
          (c) => c.tagName.toLowerCase() === 'outline',
        )
      : []
    return {
      top: tops.map((o) => o.getAttribute('text') ?? ''),
      firstChildren: kids.map((o) => o.getAttribute('text') ?? ''),
    }
  })
}

test.describe('editing (global build)', () => {
  test('type, Return inserts a sibling, Tab nests it', async ({ page }) => {
    await page.goto('/e2e/fixtures/demo.html')
    await page.locator('.concord-text').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('X') // "a" -> "aX"
    await page.keyboard.press('Enter') // new sibling
    await page.keyboard.type('child')
    await page.keyboard.press('Tab') // demote under previous

    const s = await structure(page)
    expect(s.top).toEqual(['aX'])
    expect(s.firstChildren).toEqual(['child'])
  })

  test('Ctrl-B applies bold via execCommand (needs a real browser)', async ({ page }) => {
    await page.goto('/e2e/fixtures/demo.html')
    await page.locator('.concord-text').first().click()
    await page.keyboard.press('Control+a') // select the headline text
    await page.keyboard.press('Control+b') // bold
    const html = await page.locator('.concord-text').first().innerHTML()
    // execCommand wraps the selection in markup (<b>/<strong>/styled span)
    expect(html).toContain('<')
  })

  test('readonly blocks editing but keeps the text', async ({ page }) => {
    await page.goto('/e2e/fixtures/demo.html')
    await page.evaluate(() =>
      (window as unknown as { outliner: { setReadonly(b: boolean): void } }).outliner.setReadonly(true),
    )
    await page.locator('.concord-text').first().click()
    await page.keyboard.type('ZZZ')
    expect(await page.locator('.concord-text').first().textContent()).toBe('a')
  })
})
