import type { Page } from '@playwright/test'
import type { PreviewServer } from 'vite'
import type { Vitest } from 'vitest/node'
import { expect } from '@playwright/test'
import {
  assertTestCounts,
  openExplorerItem,
  startHtmlReportPreview,
  startVitestUi,
  test,
} from './helper'

const root = './fixtures/seeds'

test.describe('ui', () => {
  let vitest: Vitest | undefined
  let pageUrl: string

  test.beforeAll(async () => {
    const server = await startVitestUi({
      root,
      watch: true,
      ui: true,
      open: false,
      reporters: [],
    })
    vitest = server.vitest
    pageUrl = server.url
  })

  test.afterAll(async () => {
    await vitest?.close()
  })

  test('failed seeds', async ({ page }) => {
    await page.goto(pageUrl)
    await testFailedSeeds(page)
  })
})

test.describe('html report', () => {
  let previewServer: PreviewServer
  let pageUrl: string

  test.beforeAll(async () => {
    const server = await startHtmlReportPreview(
      { root, run: true, reporters: 'html' },
      { root, build: { outDir: '.vitest' } },
    )
    previewServer = server.previewServer
    pageUrl = `${server.url}/`
  })

  test.afterAll(async () => {
    await previewServer?.close()
  })

  test('failed seeds', async ({ page }) => {
    await page.goto(pageUrl)
    await testFailedSeeds(page)
  })
})

async function testFailedSeeds(page: Page) {
  await assertTestCounts(page, { pass: 0, fail: 2 })
  const report = page.getByTestId('report')
  const failures = report.getByTestId('test-failure')
  const details = report.getByTestId('failure-details')

  // the seeds that fail at the same place share 1 error and 1 replay command
  await openExplorerItem(page, 'keeps every number')
  await expect(failures).toHaveCount(1)
  await expect(failures).toContainText('expected [ 2, 4 ] to have a length of 4 but got 2')
  await expect(details.locator('dt')).toHaveText(['Failed', 'Seeds', 'Reproduced', 'Replay'])
  await expect(details.locator('dd code')).toHaveText([
    'initial run, repeats 1-5, 7-9',
    '3812436c653955b3 (this error), 8c323d5626273a88, 4195878ce708c29a and 6 more',
    '9 of 9 seeds',
    `vitest run sort.test.ts -t '^keeps every number$' --replay-seed 3812436c653955b3`,
  ])
  await expect(details.getByRole('button', { name: 'Copy the replay command' })).toBeVisible()

  // the replay of the seed fails with another error, so it has its own error and a warning
  await openExplorerItem(page, 'the first user gets the id 1')
  await expect(failures).toHaveCount(2)
  await expect(failures.nth(0)).toContainText('expected 2 to be 1')
  await expect(failures.nth(1)).toContainText('expected 3 to be 1')
  await expect(details.nth(0).locator('dd code')).toHaveText([
    '1st repeat',
    '08b614131b1a5796',
    '1 of 2 runs: the test depends on more than its seed',
    `vitest run users.test.ts -t '^the first user gets the id 1$' --replay-seed 08b614131b1a5796`,
  ])
  await expect(details.nth(1).locator('dd code').first()).toHaveText('replay of 1st repeat')
}
