import { test, expect, type Page } from '@playwright/test'

async function topTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { outliner: { toOpml(): string } }
    const doc = new DOMParser().parseFromString(w.outliner.toOpml(), 'application/xml')
    return Array.from(doc.querySelectorAll('body > outline')).map(
      (o) => o.getAttribute('text') ?? '',
    )
  })
}

test.describe('Concord compat drop-in (jQuery)', () => {
  test('exposes the jQuery plugin and op* globals', async ({ page }) => {
    await page.goto('/e2e/fixtures/compat.html')
    const api = await page.evaluate(() => {
      const w = window as unknown as {
        jQuery: { fn: { concord?: unknown } }
        opExpand?: unknown
        opXmlToOutline?: unknown
        setDefaultOutliner?: unknown
        initialOpmltext?: unknown
      }
      return {
        concord: typeof w.jQuery.fn.concord,
        opExpand: typeof w.opExpand,
        opXmlToOutline: typeof w.opXmlToOutline,
        setDefaultOutliner: typeof w.setDefaultOutliner,
        hasInitialOpml: typeof w.initialOpmltext === 'string',
      }
    })
    expect(api).toEqual({
      concord: 'function',
      opExpand: 'function',
      opXmlToOutline: 'function',
      setDefaultOutliner: 'function',
      hasInitialOpml: true,
    })
    // The outliner was created via $('#outliner').concord(...)
    await expect(page.locator('#outliner .concord-root .concord-node')).toHaveCount(1)
  })

  test('editing works through the compat build', async ({ page }) => {
    await page.goto('/e2e/fixtures/compat.html')
    await page.locator('.concord-text').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    await page.keyboard.press('Enter')
    await page.keyboard.type('b')
    expect(await topTexts(page)).toEqual(['aX', 'b'])
  })
})
