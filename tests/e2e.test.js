import { beforeAll, afterAll, describe, test, expect } from "@jest/globals"
import {
  launchWithExtension,
  getServiceWorker,
  getExtensionId,
  waitForResultTab,
  startFixtureServer,
  stopFixtureServer
} from "./helpers.js"

let browser, worker, extensionId, fixtureBase

// Shared across Capture flow + Download buttons describes
let sharedResultPage = null
let sharedPagePage = null

beforeAll(async () => {
  fixtureBase = await startFixtureServer()
  browser = await launchWithExtension()
  worker = await getServiceWorker(browser)
  extensionId = await getExtensionId(browser)
})

afterAll(async () => {
  if (browser) await browser.close()
  await stopFixtureServer()
})

async function getActiveTabId() {
  return worker.evaluate(
    () => new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => r(tabs[0]?.id)))
  )
}

// Keep the service worker alive via CDP while runCapture runs (same pattern as
// original tests). Returns the evaluate promise so callers can await it.
async function triggerCapture(targetPage) {
  await targetPage.bringToFront()
  await new Promise((r) => setTimeout(r, 200))
  const tabId = await getActiveTabId()
  return worker.evaluate((tid) => runCapture(tid), tabId)
}

describe("Extension loads", () => {
  test("service worker starts without errors", async () => {
    expect(worker).toBeTruthy()
    const id = await worker.evaluate(() => chrome.runtime.id)
    expect(id).toMatch(/^[a-z]{32}$/)
  })

  test("contextMenus API is available (permission granted)", async () => {
    const type = await worker.evaluate(() => typeof chrome.contextMenus)
    expect(type).toBe("object")
  })
})

describe("Capture flow", () => {
  beforeAll(async () => {
    sharedPagePage = await browser.newPage()
    await sharedPagePage.goto(`${fixtureBase}/tall-page.html`)
  })

  test("capture completes and result tab opens", async () => {
    // Run triggerCapture (CDP keeps SW alive) concurrently with waitForResultTab
    // so neither blocks the other — the tab opens inside runCapture.
    const [, resultPage] = await Promise.all([
      triggerCapture(sharedPagePage),
      waitForResultTab(browser, extensionId, 30000)
    ])
    sharedResultPage = resultPage

    const previewSrc = await sharedResultPage.$eval("#preview-img", (el) => el.src)
    expect(previewSrc).toMatch(/^data:image\/png;base64,/)
  })

  test("result tab shows image dimensions", async () => {
    expect(sharedResultPage).toBeTruthy()
    const sizeText = await sharedResultPage.$eval("#meta-size", (el) => el.textContent)
    expect(sizeText).toMatch(/\d[\d,]* × \d[\d,]* px/)
  })

  test("captured image height exceeds viewport height (full page)", async () => {
    expect(sharedResultPage).toBeTruthy()
    const sizeText = await sharedResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const height = parseInt(match[2])
    expect(height).toBeGreaterThan(1500)
  })

  test("capture is saved to IndexedDB history", async () => {
    expect(sharedResultPage).toBeTruthy()
    const count = await sharedResultPage.evaluate(() =>
      new Promise((resolve) => {
        const req = indexedDB.open("evidexa_db", 1)
        req.onsuccess = (e) => {
          const tx = e.target.result.transaction("captures", "readonly")
          const countReq = tx.objectStore("captures").count()
          countReq.onsuccess = (ce) => resolve(ce.target.result)
          countReq.onerror = () => resolve(0)
        }
        req.onerror = () => resolve(0)
      })
    )
    expect(count).toBeGreaterThanOrEqual(1)
  })
})

describe("Download buttons", () => {
  afterAll(async () => {
    if (sharedResultPage) await sharedResultPage.close()
    if (sharedPagePage) await sharedPagePage.close()
    sharedResultPage = null
    sharedPagePage = null
  })

  test("PNG download button exists and is clickable without JS errors", async () => {
    await sharedResultPage.bringToFront()
    const errors = []
    sharedResultPage.on("pageerror", (e) => errors.push(e.message))
    const btn = await sharedResultPage.$("#btn-download-png")
    expect(btn).toBeTruthy()
    await sharedResultPage.$eval("#btn-download-png", (el) => el.click())
    await new Promise((r) => setTimeout(r, 500))
    expect(errors).toHaveLength(0)
  })

  test("JPEG download button exists and is clickable without JS errors", async () => {
    await sharedResultPage.bringToFront()
    const errors = []
    sharedResultPage.on("pageerror", (e) => errors.push(e.message))
    const btn = await sharedResultPage.$("#btn-download-jpeg")
    expect(btn).toBeTruthy()
    await sharedResultPage.$eval("#btn-download-jpeg", (el) => el.click())
    await new Promise((r) => setTimeout(r, 500))
    expect(errors).toHaveLength(0)
  })

  test("PDF download button exists and is clickable without JS errors", async () => {
    await sharedResultPage.bringToFront()
    const errors = []
    sharedResultPage.on("pageerror", (e) => errors.push(e.message))
    const btn = await sharedResultPage.$("#btn-download-pdf")
    expect(btn).toBeTruthy()
    await sharedResultPage.$eval("#btn-download-pdf", (el) => el.click())
    await new Promise((r) => setTimeout(r, 1000))
    expect(errors).toHaveLength(0)
  })
})

describe("Panel composite capture", () => {
  let panelPage = null
  let panelResultPage = null

  beforeAll(async () => {
    panelPage = await browser.newPage()
    await panelPage.goto(`${fixtureBase}/tall-panels.html`)
    await new Promise((r) => setTimeout(r, 400))
  })

  afterAll(async () => {
    if (panelResultPage) await panelResultPage.close()
    if (panelPage) await panelPage.close()
    panelResultPage = null
    panelPage = null
  })

  test("panel composite completes and result tab opens", async () => {
    const [, resultPage] = await Promise.all([
      triggerCapture(panelPage),
      waitForResultTab(browser, extensionId, 30000)
    ])
    panelResultPage = resultPage
    const previewSrc = await panelResultPage.$eval("#preview-img", (el) => el.src)
    expect(previewSrc).toMatch(/^data:image\/png;base64,/)
  })

  test("composite canvas height exceeds viewport height", async () => {
    expect(panelResultPage).toBeTruthy()
    const sizeText = await panelResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const height = parseInt(match[2])
    expect(height).toBeGreaterThan(800)
  })

  test("composite canvas width matches viewport width", async () => {
    expect(panelResultPage).toBeTruthy()
    const sizeText = await panelResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const width = parseInt(match[1])
    expect(width).toBeGreaterThan(600)
  })
})

describe("Long-scroll detection", () => {
  let longPage = null

  // Poll from Node.js side until captureConfirmResolve is set in the SW.
  // The capturePromise keeps the SW alive via CDP while we poll.
  async function waitForConfirmPrompt(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const waiting = await worker.evaluate(() => typeof captureConfirmResolve === "function")
      if (waiting) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error("Timed out waiting for long-scroll confirmation prompt")
  }

  beforeAll(async () => {
    longPage = await browser.newPage()
    await longPage.goto(`${fixtureBase}/very-tall-page.html`)
    await new Promise((r) => setTimeout(r, 300))
  })

  beforeEach(async () => {
    // Reset SW capture state so each test starts clean.
    // captureAborted in particular must be cleared — the cancel test sets it to
    // true and runCapture doesn't reset it (only REQUEST_CAPTURE message does).
    await worker.evaluate(() => {
      captureAborted = false
      captureInProgress = false
    })
  })

  afterAll(async () => {
    // Reset SW capture state in case a test left it mid-flight
    await worker.evaluate(() => {
      captureInProgress = false
      captureAborted = false
      if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null }
    })
    if (longPage) await longPage.close()
    longPage = null
  })

  test("LONG_SCROLL_DETECTED: SW suspends and awaits user choice", async () => {
    await longPage.bringToFront()
    await new Promise((r) => setTimeout(r, 200))
    const tabId = await getActiveTabId()

    // Start capture without awaiting — it will block waiting for confirmation
    const capturePromise = worker.evaluate((tid) => runCapture(tid), tabId)

    // SW should set captureConfirmResolve and pause
    await waitForConfirmPrompt()
    const isWaiting = await worker.evaluate(() => typeof captureConfirmResolve === "function")
    expect(isWaiting).toBe(true)

    // Unblock: cancel so SW exits cleanly
    await worker.evaluate(() => {
      captureAborted = true
      if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null }
    })
    await capturePromise.catch(() => {})
  })

  test("cancel during confirmation stops capture and opens no result tab", async () => {
    await longPage.bringToFront()
    await new Promise((r) => setTimeout(r, 200))
    const tabId = await getActiveTabId()

    const before = (await browser.pages()).filter((p) => p.url().includes("/tab.html")).length

    const capturePromise = worker.evaluate((tid) => runCapture(tid), tabId)
    await waitForConfirmPrompt()

    // Send cancel
    await worker.evaluate(() => {
      captureAborted = true
      if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null }
    })
    await capturePromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 500))

    const after = (await browser.pages()).filter((p) => p.url().includes("/tab.html")).length
    expect(after).toBe(before)
  })

  test("confirm with tile limit completes capture and opens result tab", async () => {
    await longPage.bringToFront()
    await new Promise((r) => setTimeout(r, 200))
    const tabId = await getActiveTabId()

    // Run capture and confirm concurrently so neither blocks the other
    const [, resultPage] = await Promise.all([
      worker.evaluate((tid) => runCapture(tid), tabId),
      (async () => {
        await waitForConfirmPrompt()
        // Confirm with 3 tiles so capture finishes quickly
        await worker.evaluate(() => {
          if (captureConfirmResolve) { captureConfirmResolve(3); captureConfirmResolve = null }
        })
        return waitForResultTab(browser, extensionId, 30000)
      })()
    ])

    expect(resultPage).toBeTruthy()
    const previewSrc = await resultPage.$eval("#preview-img", (el) => el.src)
    expect(previewSrc).toMatch(/^data:image\/png;base64,/)
    await resultPage.close()
  })
})

describe("Device-emulated capture", () => {
  // iPad Air 11": no UA override needed, integer dpr (2), deterministic dimensions
  const IPAD = { id: "ipad-air-11", name: 'iPad Air 11"', width: 820, height: 1180, dpr: 2, mobile: false, userAgent: null }

  let deviceTabId = null
  let deviceResultPage = null

  beforeAll(async () => {
    // Create the source tab through the extension API, not via browser.newPage().
    // browser.newPage() attaches a Puppeteer CDP session to the tab, which conflicts
    // with chrome.debugger.attach (only one CDP debugger per target is permitted).
    // A tab created via chrome.tabs.create has no Puppeteer session attached.
    // Resolve immediately with the tab ID and wait a fixed delay for load.
    // Waiting for onUpdated/status=complete caused the beforeAll hook to hang
    // because the event listener can miss the completion event in a SW context.
    deviceTabId = await worker.evaluate(async (url) => {
      return new Promise((resolve) => chrome.tabs.create({ url }, (tab) => resolve(tab.id)))
    }, `${fixtureBase}/tall-page.html`)
    await new Promise((r) => setTimeout(r, 3000))
  })

  beforeEach(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
  })

  afterAll(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
    if (deviceResultPage) await deviceResultPage.close()
    if (deviceTabId) {
      await worker.evaluate((tid) => chrome.tabs.remove(tid), deviceTabId).catch(() => {})
    }
    deviceResultPage = null
    deviceTabId = null
  })

  test("capture completes and result tab opens", async () => {
    // Await runDeviceCapture directly, then use waitForResultTab to detect the
    // extension-opened tab.html. browser.pages() misses it because Puppeteer
    // only tracks pages it opened itself; waitForTarget catches all targets.
    await worker.evaluate((tid, d) => runDeviceCapture(tid, d), deviceTabId, IPAD)
    deviceResultPage = await waitForResultTab(browser, extensionId, 15000)

    const previewSrc = await deviceResultPage.$eval("#preview-img", (el) => el.src)
    expect(previewSrc).toMatch(/^data:image\/png;base64,/)
  })

  test("captured image width matches device width × dpr", async () => {
    expect(deviceResultPage).toBeTruthy()
    const sizeText = await deviceResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const width = parseInt(match[1])
    // Device width 820 × dpr 2 = 1640 physical pixels
    expect(width).toBe(IPAD.width * IPAD.dpr)
  })
})

describe("Mobile device capture (iPhone SE)", () => {
  // Exercises the mobile: true branch: Emulation.setUserAgentOverride is called on
  // attach and cleared in finally. This path was the original regression target
  // (iPhone/small-glass clipping) and was previously smoke-tested only manually.
  // tall-page.html is root-scroll, so the classifier expands the viewport and the
  // captured height must exceed one iPhone viewport.
  const IPHONE = {
    id: "iphone-se", name: "iPhone SE", width: 375, height: 667, dpr: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  }

  let mobileTabId = null
  let mobileResultPage = null

  beforeAll(async () => {
    mobileTabId = await worker.evaluate((url) => {
      return new Promise((resolve) => chrome.tabs.create({ url }, (tab) => resolve(tab.id)))
    }, `${fixtureBase}/tall-page.html`)
    await new Promise((r) => setTimeout(r, 3000))
  })

  beforeEach(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
    if (mobileResultPage) { await mobileResultPage.close(); mobileResultPage = null }
  })

  afterAll(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
    if (mobileResultPage) await mobileResultPage.close()
    if (mobileTabId) await worker.evaluate((tid) => chrome.tabs.remove(tid), mobileTabId).catch(() => {})
    mobileResultPage = null
    mobileTabId = null
  })

  test("iPhone SE capture completes — UA override applied, width and height correct", async () => {
    await worker.evaluate((tid, d) => runDeviceCapture(tid, d), mobileTabId, IPHONE)
    mobileResultPage = await waitForResultTab(browser, extensionId, 15000)

    expect(mobileResultPage).toBeTruthy()
    const sizeText = await mobileResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const w = parseInt(match[1])
    const h = parseInt(match[2])

    // Width: 375px × dpr 2 = 750 physical pixels
    expect(w).toBe(IPHONE.width * IPHONE.dpr)
    // Height: tall-page.html is root-scroll → viewport expanded → height > 1 iPhone screen
    expect(h).toBeGreaterThan(IPHONE.height * IPHONE.dpr)
  })
})

describe("Region capture", () => {
  let regionPage = null

  beforeAll(async () => {
    regionPage = await browser.newPage()
    await regionPage.goto(`${fixtureBase}/tall-page.html`)
    await new Promise((r) => setTimeout(r, 300))
  })

  beforeEach(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
  })

  afterAll(async () => {
    await worker.evaluate(() => {
      captureAborted = false
      captureInProgress = false
      if (regionSelectResolve) { regionSelectResolve(null); regionSelectResolve = null }
    })
    if (regionPage) await regionPage.close()
    regionPage = null
  })

  test("real drag on overlay produces a cropped PNG result tab", async () => {
    await regionPage.bringToFront()
    await new Promise((r) => setTimeout(r, 200))
    const tabId = await getActiveTabId()

    // runRegionCapture injects the overlay and waits for REGION_SELECTED —
    // use Promise.all so the drag can happen while the SW is suspended waiting.
    const [, resultPage] = await Promise.all([
      worker.evaluate((tid) => runRegionCapture(tid), tabId),
      (async () => {
        // Wait for region-selector.js to inject and wire its event listeners
        await new Promise((r) => setTimeout(r, 600))

        // Simulate a 200×200 drag starting at (100, 100)
        await regionPage.mouse.move(100, 100)
        await regionPage.mouse.down()
        await regionPage.mouse.move(300, 300, { steps: 10 })
        await regionPage.mouse.up()

        return waitForResultTab(browser, extensionId, 30000)
      })()
    ])

    expect(resultPage).toBeTruthy()
    const previewSrc = await resultPage.$eval("#preview-img", (el) => el.src)
    expect(previewSrc).toMatch(/^data:image\/png;base64,/)

    // Verify the crop is roughly 200×200 CSS px (within DPR scaling)
    const sizeText = await resultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const w = parseInt(match[1])
    const h = parseInt(match[2])
    expect(w).toBeGreaterThan(100)
    expect(h).toBeGreaterThan(100)

    await resultPage.close()
  })
})

describe("Device capture classifier", () => {
  // Verifies the three-mode classifier introduced to fix the double-render /
  // clipping regression pair:
  //   fixed-shell-or-ambiguous → no expansion, height ≈ device.height × dpr
  //   single-safe-inner-surface → expansion, height > device.height × dpr
  const DEVICE = { id: "ipad-air-11", name: 'iPad Air 11"', width: 820, height: 1180, dpr: 2, mobile: false, userAgent: null }

  let vsTabId = null
  let isTabId = null
  let clsResultPage = null

  beforeAll(async () => {
    vsTabId = await worker.evaluate((url) => {
      return new Promise((resolve) => chrome.tabs.create({ url }, (tab) => resolve(tab.id)))
    }, `${fixtureBase}/virtual-scroll-page.html`)
    isTabId = await worker.evaluate((url) => {
      return new Promise((resolve) => chrome.tabs.create({ url }, (tab) => resolve(tab.id)))
    }, `${fixtureBase}/inner-scroll-page.html`)
    await new Promise((r) => setTimeout(r, 3000))
  })

  beforeEach(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
    if (clsResultPage) { await clsResultPage.close(); clsResultPage = null }
  })

  afterAll(async () => {
    await worker.evaluate(() => { captureAborted = false; captureInProgress = false })
    if (clsResultPage) await clsResultPage.close()
    if (vsTabId) await worker.evaluate((tid) => chrome.tabs.remove(tid), vsTabId).catch(() => {})
    if (isTabId) await worker.evaluate((tid) => chrome.tabs.remove(tid), isTabId).catch(() => {})
    clsResultPage = null
    vsTabId = null
    isTabId = null
  })

  test("virtual-scroll SPA → fixed-shell-or-ambiguous → no viewport expansion", async () => {
    // Fixture: html/body overflow:hidden, #email-list has scrollRatio > 10 AND
    // renderedCoverage < 0.25 (sparse virtual-scroll DOM). Classifier vetoes
    // expansion. Captured height must be ≈ device.height × dpr (±5%).
    await worker.evaluate((tid, d) => runDeviceCapture(tid, d), vsTabId, DEVICE)
    clsResultPage = await waitForResultTab(browser, extensionId, 15000)

    expect(clsResultPage).toBeTruthy()
    const sizeText = await clsResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const h = parseInt(match[2])

    const expectedH = DEVICE.height * DEVICE.dpr
    expect(h).toBeGreaterThanOrEqual(Math.round(expectedH * 0.95))
    expect(h).toBeLessThanOrEqual(Math.round(expectedH * 1.05))
  })

  test("inner-scroll SPA → single-safe-inner-surface → viewport expanded beyond device height", async () => {
    // Fixture: html/body overflow:hidden, #content has real stacked sections
    // (renderedCoverage ≈ 1.0, scrollRatio < 10). Classifier approves expansion.
    // Captured height must exceed one viewport.
    await worker.evaluate((tid, d) => runDeviceCapture(tid, d), isTabId, DEVICE)
    clsResultPage = await waitForResultTab(browser, extensionId, 15000)

    expect(clsResultPage).toBeTruthy()
    const sizeText = await clsResultPage.$eval("#meta-size", (el) => el.textContent)
    const match = sizeText.replace(/,/g, "").match(/(\d+) × (\d+)/)
    expect(match).toBeTruthy()
    const h = parseInt(match[2])

    const minH = DEVICE.height * DEVICE.dpr
    expect(h).toBeGreaterThan(minH)
  })
})

describe("Edge cases", () => {
  test("does not open result tab for chrome:// URLs", async () => {
    const chromePage = await browser.newPage()
    await chromePage.goto("chrome://newtab")
    await chromePage.bringToFront()
    await new Promise((r) => setTimeout(r, 200))
    const chromeTabId = await getActiveTabId()

    // Count existing tab.html pages before triggering
    const before = (await browser.pages()).filter((p) => p.url().includes("/tab.html")).length

    // runCapture returns immediately for restricted URLs (no tab opened)
    await worker.evaluate((tid) => runCapture(tid), chromeTabId)

    // Confirm no new result tab appeared
    const after = (await browser.pages()).filter((p) => p.url().includes("/tab.html")).length
    expect(after).toBe(before)

    await chromePage.close()
  })
})
