/**
 * background.js — Evidexa Screenshot service worker
 *
 * Intentionally a single classic (non-module) script. Splitting it into ES
 * modules would break Puppeteer's worker.evaluate() CDP path used in the E2E
 * test suite. Each logical concern is separated by SECTION comments below.
 *
 * Sections:
 *   DATABASE          — inline IndexedDB helper (mirrors db.js for SW context)
 *   CONSTANTS         — tuneable limits and device presets
 *   CONTEXT MENUS     — menu construction and click routing
 *   MESSAGE HANDLING  — popup ↔ background message protocol
 *   CAPTURE: FULL PAGE — window-scroll tile stitching (runCapture)
 *   CAPTURE: PANELS   — fixed-layout panel composite (runPanelComposite)
 *   CAPTURE: DEVICE   — CDP device-emulation single-shot (runDeviceCapture)
 *   CAPTURE: REGION   — drag-selection crop (runRegionCapture)
 *   SHARED UTILITIES  — sleep, rateLimitedCapture, stitchTile, canvasToDataUrl
 */

// ── DATABASE ──────────────────────────────────────────────────────────────────
//
// NOTE ON DUPLICATION: db.js is the canonical IndexedDB wrapper used by the
// tab UI (ES module context). Service workers cannot import ES modules from a
// classic script, so dbSaveCapture is intentionally re-implemented here with
// the minimum surface needed for capture persistence. Schema must stay in sync
// with db.js (same DB name, version, store, and index names).
function dbSaveCapture(record) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("evidexa_db", 1)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains("captures")) {
        const store = db.createObjectStore("captures", { keyPath: "id", autoIncrement: true })
        store.createIndex("timestamp", "timestamp", { unique: false })
        store.createIndex("sourceUrl", "sourceUrl", { unique: false })
      }
    }
    req.onsuccess = (e) => {
      const db = e.target.result
      const tx = db.transaction("captures", "readwrite")
      const addReq = tx.objectStore("captures").add(record)
      addReq.onsuccess = (ae) => resolve(ae.target.result)
      addReq.onerror = (ae) => reject(ae.target.error)
    }
    req.onerror = (e) => reject(e.target.error)
  })
}

// ── CONSTANTS ──────────────────────────────────────────────────────────────────

const MAX_CANVAS_DIM = 32767  // OffscreenCanvas maximum dimension (browser limit)
const RATE_LIMIT_MS = 520     // minimum ms between captureVisibleTab calls
const SCROLL_SETTLE_MS = 150  // ms to wait after a scroll before capturing
const LAZY_LOAD_SETTLE_MS = 300 // ms to wait after pre-scroll for lazy content
const LONG_SCROLL_THRESHOLD = 10 // tiles; prompt user before capturing very tall pages

// Runtime state — reset between captures
let lastCaptureTime = 0
let captureAborted = false
let captureInProgress = false
let pendingTargetTabId = null
let captureConfirmResolve = null // resolves when user confirms tile count for long pages
let pendingCaptureOpts = null   // extra options (e.g. devicePreset) set by runDeviceCapture
let regionSelectResolve = null  // resolves when user finishes dragging a region

const DEVICE_PRESETS = [
  { id: "iphone-16e",        name: "iPhone 16e",        width: 390,  height: 844,  dpr: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1" },
  { id: "iphone-17",         name: "iPhone 17",         width: 402,  height: 874,  dpr: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1" },
  { id: "iphone-air",        name: "iPhone Air",        width: 420,  height: 912,  dpr: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1" },
  { id: "iphone-17-pro-max", name: "iPhone 17 Pro Max", width: 440,  height: 956,  dpr: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1" },
  { id: "ipad-mini",         name: "iPad Mini",         width: 744,  height: 1133, dpr: 2,     mobile: false, userAgent: null },
  { id: "ipad-air-11",       name: 'iPad Air 11"',      width: 820,  height: 1180, dpr: 2,     mobile: false, userAgent: null },
  { id: "ipad-pro-13",       name: 'iPad Pro 13"',      width: 1032, height: 1376, dpr: 2,     mobile: false, userAgent: null },
  { id: "pixel-9",           name: "Pixel 9",           width: 412,  height: 915,  dpr: 2.625, mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" },
  { id: "galaxy-s25",        name: "Galaxy S25",        width: 360,  height: 780,  dpr: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" },
  { id: "macbook-13",        name: 'MacBook Air 13"',   width: 1280, height: 800,  dpr: 2,     mobile: false, userAgent: null },
  { id: "desktop-1080",      name: "Desktop 1080p",     width: 1920, height: 1080, dpr: 1,     mobile: false, userAgent: null }
]

// ── CONTEXT MENUS ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => { buildContextMenus() })

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.customDevicePresets) buildContextMenus()
})

async function buildContextMenus() {
  await chrome.contextMenus.removeAll()

  // Page right-click: full-page capture
  chrome.contextMenus.create({
    id: "capture-full-page",
    title: "Capture Full Page (Evidexa Screenshot)",
    contexts: ["page"]
  })

  // Extension button right-click
  chrome.contextMenus.create({ id: "capture-region", title: "Capture Region\u2026", contexts: ["action"] })
  chrome.contextMenus.create({ id: "render-as-parent", title: "Render as\u2026", contexts: ["action"] })

  for (const d of DEVICE_PRESETS) {
    chrome.contextMenus.create({
      id: `render-as-${d.id}`,
      parentId: "render-as-parent",
      title: `${d.name}  (${d.width}\u00d7${d.height})`,
      contexts: ["action"]
    })
  }

  const { customDevicePresets = [] } = await chrome.storage.sync.get("customDevicePresets")
  if (customDevicePresets.length > 0) {
    chrome.contextMenus.create({ id: "render-as-sep", parentId: "render-as-parent", type: "separator", contexts: ["action"] })
    for (const d of customDevicePresets) {
      chrome.contextMenus.create({
        id: `render-as-custom-${d.id}`,
        parentId: "render-as-parent",
        title: `${d.name}  (${d.width}\u00d7${d.height}) \u270e`,
        contexts: ["action"]
      })
    }
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-screenshot") return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return
  pendingTargetTabId = tab.id
  try {
    await chrome.action.openPopup()
  } catch (_) {
    pendingTargetTabId = null
    runCapture(tab.id)
  }
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return
  const id = info.menuItemId

  if (id === "capture-full-page") {
    pendingTargetTabId = tab.id
    try {
      await chrome.action.openPopup()
    } catch (_) {
      pendingTargetTabId = null
      runCapture(tab.id)
    }
    return
  }

  if (id === "capture-region") {
    runRegionCapture(tab.id)
    return
  }

  if (id.startsWith("render-as-")) {
    const deviceId = id.replace("render-as-", "")
    // Check standard presets first
    let device = DEVICE_PRESETS.find((d) => d.id === deviceId)
    if (!device) {
      // Check custom presets (id is "custom-<uuid>")
      const { customDevicePresets = [] } = await chrome.storage.sync.get("customDevicePresets")
      device = customDevicePresets.find((d) => `custom-${d.id}` === deviceId)
    }
    if (device) runDeviceCapture(tab.id, device)
  }
})

// ── MESSAGE HANDLING ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REQUEST_CAPTURE") {
    captureAborted = false
    const explicitTabId = message.payload && message.payload.tabId
    const tabId = explicitTabId || pendingTargetTabId
    pendingTargetTabId = null
    if (tabId) {
      runCapture(tabId)
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) runCapture(tabs[0].id)
      })
    }
    return false
  }

  if (message.type === "CANCEL_CAPTURE") {
    captureAborted = true
    if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null }
    return false
  }

  if (message.type === "CONFIRM_CAPTURE") {
    if (captureConfirmResolve) {
      captureConfirmResolve(message.payload.maxTiles)
      captureConfirmResolve = null
    }
    return false
  }

  if (message.type === "REGION_SELECTED") {
    if (regionSelectResolve) { regionSelectResolve(message.payload); regionSelectResolve = null }
    return false
  }

  if (message.type === "REGION_CANCELLED") {
    if (regionSelectResolve) { regionSelectResolve(null); regionSelectResolve = null }
    return false
  }
})

function isRestrictedUrl(url) {
  if (!url) return true
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("data:")
  )
}

// ── CAPTURE: FULL PAGE ──────────────────────────────────────────────────────────

async function runCapture(tabId) {
  const opts = pendingCaptureOpts || {}
  pendingCaptureOpts = null

  if (captureInProgress) return
  captureInProgress = true

  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch (_) {
    captureInProgress = false
    sendToPopup({ type: "CAPTURE_ERROR", payload: { message: "Target tab no longer exists." } })
    return
  }

  if (isRestrictedUrl(tab.url)) {
    captureInProgress = false
    sendToPopup({
      type: "CAPTURE_ERROR",
      payload: { message: "Cannot capture this page. Chrome system pages are not supported." }
    })
    return
  }

  try {
    sendToPopup({ type: "CAPTURE_START", payload: {} })

    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })

    await sendToTab(tabId, { type: "INJECT_CAPTURE_CSS" })

    const dims = await sendToTab(tabId, { type: "GET_DIMENSIONS" })
    const rawDpr = dims.devicePixelRatio || 1
    const dpr = Math.min(rawDpr, 2)

    // ── Multi-panel composite path (fixed-layout apps: Outlook, Gmail, etc.) ──
    if (!dims.bodyScrolls && dims.panels && dims.panels.length > 0) {
      const result = await runPanelComposite(tabId, dims, dpr, tab.windowId)
      const captureId = await dbSaveCapture({
        dataUrl: result.dataUrl,
        thumbnailUrl: result.thumbnailUrl,
        sourceUrl: tab.url,
        sourceTitle: tab.title || tab.url,
        width: result.canvasW,
        height: result.canvasH,
        heightCapped: result.heightCapped,
        originalScrollHeight: Math.floor(result.canvasH / dpr),
        dpr,
        devicePreset: opts.devicePreset || null,
        timestamp: new Date().toISOString()
      })
      chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/tab.html?id=${captureId}` })
      sendToPopup({ type: "CAPTURE_DONE", payload: { captureId } })
      return
    }

    // ── Window-scroll path (normal web pages) ──
    const scrollSelector = null
    const effectiveHeight = dims.scrollHeight
    const effectiveWidth = Math.max(dims.scrollWidth, dims.viewportWidth)
    const vpH = dims.viewportHeight

    let canvasHeight = effectiveHeight * dpr
    let heightCapped = false
    if (canvasHeight > MAX_CANVAS_DIM) {
      canvasHeight = MAX_CANVAS_DIM
      heightCapped = true
    }
    let canvasWidth = effectiveWidth * dpr
    if (canvasWidth > MAX_CANVAS_DIM) canvasWidth = MAX_CANVAS_DIM

    const canvas = new OffscreenCanvas(Math.floor(canvasWidth), Math.floor(canvasHeight))
    const ctx = canvas.getContext("2d")

    // Pre-scroll to trigger lazy-load content
    await sendToTab(tabId, { type: "SCROLL_TO", payload: { y: effectiveHeight, scrollSelector } })
    await sleep(LAZY_LOAD_SETTLE_MS)

    const dimsAfterScroll = await sendToTab(tabId, { type: "GET_DIMENSIONS" })
    const finalScrollHeight = Math.min(
      Math.max(effectiveHeight, dimsAfterScroll.scrollHeight),
      Math.floor(canvasHeight / dpr)
    )
    const totalTiles = Math.ceil(finalScrollHeight / vpH)

    // Long scroll detection — ask user how many tiles to capture
    let effectiveTiles = totalTiles
    if (totalTiles > LONG_SCROLL_THRESHOLD) {
      sendToPopup({ type: "LONG_SCROLL_DETECTED", payload: { totalTiles, scrollHeight: finalScrollHeight } })
      const maxTilesChoice = await new Promise((resolve) => {
        captureConfirmResolve = resolve
        // Auto-cancel after 60 s if the user ignores the popup
        setTimeout(() => { if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null } }, 60000)
      })
      if (maxTilesChoice === null) throw new Error("Capture cancelled")
      if (maxTilesChoice > 0) effectiveTiles = Math.min(totalTiles, maxTilesChoice)
    }
    sendToPopup({ type: "CAPTURE_START", payload: { totalTiles: effectiveTiles } })

    // Tile 0 is captured with ALL elements visible (sticky headers, floating
    // buttons, etc.) so the top of the page renders exactly as the user sees it.
    // HIDE_FIXED is deferred to tiles 1+ where those elements would otherwise
    // duplicate into every scroll position they appear in.
    if (captureAborted) throw new Error("Capture cancelled")
    const sr0 = await sendToTab(tabId, { type: "SCROLL_TO", payload: { y: 0, scrollSelector } })
    await sleep(SCROLL_SETTLE_MS)
    const aY0 = (sr0 && sr0.actualScrollY != null) ? sr0.actualScrollY : 0
    await stitchTile(tabId, ctx, vpH, finalScrollHeight, dpr, aY0, tab.windowId)
    sendToPopup({ type: "CAPTURE_PROGRESS", payload: { tile: 1, totalTiles: effectiveTiles } })

    // --- Tiles 1+: fixed overlays/headers hidden, sidebars still visible ---
    if (effectiveTiles > 1) {
      await sendToTab(tabId, { type: "HIDE_FIXED" })

      for (let i = 1; i < effectiveTiles; i++) {
        if (captureAborted) throw new Error("Capture cancelled")
        const sr = await sendToTab(tabId, { type: "SCROLL_TO", payload: { y: i * vpH, scrollSelector } })
        await sleep(SCROLL_SETTLE_MS)
        const aY = (sr && sr.actualScrollY != null) ? sr.actualScrollY : i * vpH
        await stitchTile(tabId, ctx, vpH, finalScrollHeight, dpr, aY, tab.windowId)
        sendToPopup({ type: "CAPTURE_PROGRESS", payload: { tile: i + 1, totalTiles: effectiveTiles } })
      }
    }

    await sendToTab(tabId, { type: "RESTORE_FIXED" })
    await sendToTab(tabId, { type: "SCROLL_TOP", payload: { scrollSelector } })

    // Encode full image as base64 PNG
    const dataUrl = await canvasToDataUrl(canvas, "image/png")

    // Generate 200px-wide JPEG thumbnail
    const thumbW = 200
    const thumbH = Math.max(1, Math.round(thumbW * (Math.floor(canvasHeight) / Math.floor(canvasWidth))))
    const thumbCanvas = new OffscreenCanvas(thumbW, thumbH)
    thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, thumbW, thumbH)
    const thumbnailUrl = await canvasToDataUrl(thumbCanvas, "image/jpeg", 0.7)

    // Persist to IndexedDB
    const captureId = await dbSaveCapture({
      dataUrl,
      thumbnailUrl,
      sourceUrl: tab.url,
      sourceTitle: tab.title || tab.url,
      width: Math.floor(canvasWidth),
      height: Math.floor(canvasHeight),
      heightCapped,
      originalScrollHeight: effectiveHeight,
      dpr,
      devicePreset: opts.devicePreset || null,
      timestamp: new Date().toISOString()
    })

    // Open result tab (always new)
    chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/tab.html?id=${captureId}` })

    sendToPopup({ type: "CAPTURE_DONE", payload: { captureId } })
  } catch (err) {
    try {
      await sendToTab(tabId, { type: "RESTORE_FIXED" }).catch(() => {})
      await sendToTab(tabId, { type: "SCROLL_TOP", payload: {} }).catch(() => {})
    } catch (_) {}

    if (err.message === "Capture cancelled") {
      sendToPopup({ type: "CAPTURE_CANCELLED" })
    } else {
      sendToPopup({
        type: "CAPTURE_ERROR",
        payload: { message: err.message || "An unknown error occurred during capture." }
      })
    }
  } finally {
    captureInProgress = false
  }
}

// ── CAPTURE: DEVICE ─────────────────────────────────────────────────────────────────
//
// Two-step viewport approach:
//   1. Set viewport to device.width × device.height for correct responsive layout
//      (media queries, font scaling, mobile-specific CSS all key off window.innerWidth).
//   2. Measure the deepest scrollable element’s scrollHeight via Runtime.evaluate.
//      Page.getLayoutMetrics is not used here because it returns the viewport height
//      when the page uses a height:100vh/100% outer container (common in SPAs like
//      Airtable) — the real content is inside an inner scroll container.
//   3. Re-set viewport to device.width × contentH so the entire page fits inside
//      the viewport, then take one Page.captureScreenshot (no clip needed).
//
// Runtime.evaluate is used instead of content.js because injected content scripts
// are unreliable under device emulation: viewport-height changes can re-execute
// the content script or produce stale dimension readings.

// ── Device-capture CDP scripts ────────────────────────────────────────────────
//
// All three scripts share a single element-identity contract via
// window.__evidexaCaptureSurface.  SCRIPT_CLASSIFY_PAGE selects the candidate
// once, stores it on window, and returns { mode, contentH }.  The two scroll
// scripts read that exact reference — no re-selection, no drift between calls.

const SCRIPT_INJECT_SCROLLBAR_CSS = `(function(){
  if (!document.getElementById('evidexa-cap-css')) {
    var s = document.createElement('style');
    s.id = 'evidexa-cap-css';
    s.textContent = '::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}';
    document.head.appendChild(s);
  }
})()`

// Classifier — determines capture mode and stores the selected surface.
//
// Three modes:
//   root-scroll             — document itself scrolls; expand to root height
//   single-safe-inner-surface — one dominant visible scroller passes veto; expand to its height
//   fixed-shell-or-ambiguous  — everything else; keep device.height (conservative)
//
// Dominant-surface candidate requirements:
//   • vertically scrollable (scrollHeight > clientHeight + 2)
//   • occupies ≥50% of viewport width AND height
//   • not display:none or visibility:hidden
//
// Veto (single candidate case): scrollRatio > 10 AND hasSpacer
//   scrollRatio = candidate.scrollHeight / candidate.clientHeight
//   hasSpacer   = any of first 10 direct children has inline style.height > clientHeight × 3
//
// Virtual-scroll libraries (react-window, TanStack Virtual, AG Grid…) always
// set the spacer rail height as an inline style so JS can update it at runtime.
// Real content containers derive height from flow layout; style.height is "".
// Both thresholds are calibration defaults tuned to known fixtures, not
// semantic invariants.  Miscalibration degrades to conservative capture only.
const SCRIPT_CLASSIFY_PAGE = `(function(){
  var vpW = window.innerWidth, vpH = window.innerHeight;
  var rootH = document.documentElement.scrollHeight;

  if (rootH > vpH + 4) {
    window.__evidexaCaptureSurface = null;
    return { mode: 'root-scroll', contentH: rootH };
  }

  var candidates = [];
  document.querySelectorAll('*').forEach(function(el) {
    if (el.scrollHeight <= el.clientHeight + 2) return;
    var r = el.getBoundingClientRect();
    if (r.width < vpW * 0.5 || r.height < vpH * 0.5) return;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    candidates.push(el);
  });

  if (candidates.length !== 1) {
    window.__evidexaCaptureSurface = null;
    return { mode: 'fixed-shell-or-ambiguous', contentH: vpH };
  }

  var c = candidates[0];
  var scrollRatio = c.scrollHeight / Math.max(c.clientHeight, 1);
  // Spacer veto: virtual-scroll libraries (react-window, TanStack Virtual, AG Grid…)
  // always set an explicit inline style.height on the spacer rail element.
  // Real content containers derive height from content flow and have no inline height.
  // We check the first 10 direct children; if any has an inline height > 3× clientH,
  // it is a synthetic spacer and the surface is unsafe to expand.
  var children = Array.prototype.slice.call(c.children, 0, 10);
  var hasSpacer = children.some(function(ch) {
    var h = parseFloat(ch.style.height);
    return !isNaN(h) && h > c.clientHeight * 3;
  });
  var isVetoed = scrollRatio > 10 && hasSpacer;

  if (isVetoed) {
    window.__evidexaCaptureSurface = null;
    return { mode: 'fixed-shell-or-ambiguous', contentH: vpH };
  }

  window.__evidexaCaptureSurface = c;
  return { mode: 'single-safe-inner-surface', contentH: c.scrollHeight };
})()`

// Scroll the classified surface to the bottom (lazy-load trigger).
// Reads window.__evidexaCaptureSurface set by SCRIPT_CLASSIFY_PAGE.
const SCRIPT_SCROLL_SURFACE_DOWN = `(function(){
  document.documentElement.scrollTop = document.documentElement.scrollHeight;
  document.body.scrollTop = document.body.scrollHeight;
  var s = window.__evidexaCaptureSurface;
  if (s) s.scrollTop = s.scrollHeight;
})()`

// Scroll the classified surface back to the top before measurement.
const SCRIPT_SCROLL_SURFACE_UP = `(function(){
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  var s = window.__evidexaCaptureSurface;
  if (s) s.scrollTop = 0;
})()`

async function cdpEval(tabId, expression) {
  const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true
  })
  return r && r.result ? r.result.value : undefined
}

async function runDeviceCapture(tabId, device) {
  if (captureInProgress) return
  captureInProgress = true

  let tab
  try { tab = await chrome.tabs.get(tabId) } catch (_) { captureInProgress = false; return }
  if (isRestrictedUrl(tab.url)) { captureInProgress = false; return }

  try {
    sendToPopup({ type: "CAPTURE_START", payload: { totalTiles: 1 } })

    await chrome.debugger.attach({ tabId }, "1.3")

    const dpr = device.dpr
    const maxH = Math.floor(MAX_CANVAS_DIM / dpr)

    if (device.mobile && device.userAgent) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setUserAgentOverride", {
        userAgent: device.userAgent
      })
    }

    // ── Step 1: correct device dimensions for proper layout + media queries ────
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: dpr,
      mobile: !!device.mobile,
      screenWidth: device.width,
      screenHeight: device.height
    })
    await sleep(1500)

    // ── Step 2: hide scrollbars ───────────────────────────────────────────────
    await cdpEval(tabId, SCRIPT_INJECT_SCROLLBAR_CSS)

    // ── Step 3: classify page layout — determines mode and chosen surface ─────
    // Returns { mode, contentH } and stashes the selected element on
    // window.__evidexaCaptureSurface for the scroll scripts below.
    const classification = await cdpEval(tabId, SCRIPT_CLASSIFY_PAGE)
    const mode = classification ? classification.mode : "fixed-shell-or-ambiguous"
    const classifiedH = classification ? classification.contentH : device.height

    // ── Step 4: pre-scroll the chosen surface (lazy-load trigger) ────────────
    await cdpEval(tabId, SCRIPT_SCROLL_SURFACE_DOWN)
    await sleep(LAZY_LOAD_SETTLE_MS)
    await cdpEval(tabId, SCRIPT_SCROLL_SURFACE_UP)
    await sleep(SCROLL_SETTLE_MS)

    // ── Step 5: expand viewport only for expandable modes ────────────────────
    // fixed-shell-or-ambiguous: keep device.height to avoid duplicate-shell
    // relayout artifacts in SPAs (Outlook, Gmail, etc.)
    const shouldExpand = mode === "root-scroll" || mode === "single-safe-inner-surface"
    const contentH = shouldExpand ? Math.min(classifiedH, maxH) : device.height

    if (shouldExpand) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: device.width,
        height: Math.ceil(contentH),
        deviceScaleFactor: dpr,
        mobile: !!device.mobile,
        screenWidth: device.width,
        screenHeight: device.height
      })
      await sleep(800)
    }

    sendToPopup({ type: "CAPTURE_PROGRESS", payload: { tile: 1, totalTiles: 1 } })

    // ── Step 5: screenshot — viewport = content, no clip needed ───────────────
    const { data } = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "png"
    })

    const bmp = await cdpBase64ToBitmap(data)
    const canvasW = bmp.width
    const canvasH = bmp.height
    const canvas = new OffscreenCanvas(canvasW, canvasH)
    canvas.getContext("2d").drawImage(bmp, 0, 0)
    bmp.close()

    const dataUrl = await canvasToDataUrl(canvas, "image/png")
    const thumbW = 200
    const thumbH = Math.max(1, Math.round(thumbW * canvasH / canvasW))
    const thumbCanvas = new OffscreenCanvas(thumbW, thumbH)
    thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, thumbW, thumbH)
    const thumbnailUrl = await canvasToDataUrl(thumbCanvas, "image/jpeg", 0.7)

    const captureId = await dbSaveCapture({
      dataUrl, thumbnailUrl,
      sourceUrl: tab.url, sourceTitle: tab.title || tab.url,
      width: canvasW, height: canvasH,
      heightCapped: contentH >= maxH,
      originalScrollHeight: contentH,
      dpr,
      devicePreset: device.name,
      timestamp: new Date().toISOString()
    })

    chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/tab.html?id=${captureId}` })
    sendToPopup({ type: "CAPTURE_DONE", payload: { captureId } })

  } catch (err) {
    sendToPopup({ type: "CAPTURE_ERROR", payload: { message: err.message || "Device capture failed." } })
  } finally {
    captureInProgress = false
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride")
      if (device.mobile && device.userAgent) {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setUserAgentOverride", { userAgent: "" })
      }
      await chrome.debugger.detach({ tabId })
    } catch (_) {}
  }
}

// ── CAPTURE: REGION ─────────────────────────────────────────────────────────────────

async function runRegionCapture(tabId) {
  if (captureInProgress) return
  captureInProgress = true

  let tab
  try { tab = await chrome.tabs.get(tabId) } catch (_) { captureInProgress = false; return }
  if (isRestrictedUrl(tab.url)) { captureInProgress = false; return }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["region-selector.js"] })

    const region = await new Promise((resolve) => {
      regionSelectResolve = resolve
      setTimeout(() => { if (regionSelectResolve) { regionSelectResolve(null); regionSelectResolve = null } }, 120000)
    })

    if (!region) { sendToPopup({ type: "CAPTURE_CANCELLED" }); return }

    const dpr = region.dpr || 1

    const rawUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    const blob = await (await fetch(rawUrl)).blob()
    const bitmap = await createImageBitmap(blob)

    const sx = Math.floor(region.x * dpr)
    const sy = Math.floor(region.y * dpr)
    const sw = Math.max(1, Math.floor(region.w * dpr))
    const sh = Math.max(1, Math.floor(region.h * dpr))

    const canvas = new OffscreenCanvas(sw, sh)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    bitmap.close()

    const dataUrl = await canvasToDataUrl(canvas, "image/png")
    const thumbW = 200
    const thumbH = Math.max(1, Math.round(thumbW * sh / sw))
    const thumbCanvas = new OffscreenCanvas(thumbW, thumbH)
    thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, thumbW, thumbH)
    const thumbnailUrl = await canvasToDataUrl(thumbCanvas, "image/jpeg", 0.7)

    const captureId = await dbSaveCapture({
      dataUrl, thumbnailUrl,
      sourceUrl: tab.url, sourceTitle: tab.title || tab.url,
      width: sw, height: sh, heightCapped: false,
      originalScrollHeight: sh, dpr,
      captureType: "region",
      timestamp: new Date().toISOString()
    })

    chrome.tabs.create({ url: `chrome-extension://${chrome.runtime.id}/tab.html?id=${captureId}` })
    sendToPopup({ type: "CAPTURE_DONE", payload: { captureId } })

  } catch (err) {
    sendToPopup({ type: "CAPTURE_ERROR", payload: { message: err.message || "Region capture failed." } })
  } finally {
    captureInProgress = false
  }
}

// ──────────────────────────────────────────────────────────────────────────────────

// Sample a pixel from the canvas at an x,y coordinate that is NOT inside any panel.
// Returns an rgb(...) string, or null if no suitable position found.
function sampleNonPanelColor(ctx, panels, dpr, vpW, vpH) {
  // Candidate sample points (in CSS pixels): left edge, right edge, between panels
  const candidatesX = [4, Math.round(vpW * 0.02), Math.round(vpW - 4)]
  const sampleY = Math.floor((vpH * 0.5) * dpr)
  for (const cx of candidatesX) {
    const sx = Math.floor(cx * dpr)
    const inPanel = panels.some((p) => {
      const pl = Math.floor(p.rect.left * dpr)
      const pr = Math.floor((p.rect.left + p.rect.width) * dpr)
      return sx >= pl && sx <= pr
    })
    if (!inPanel) {
      try {
        const d = ctx.getImageData(sx, sampleY, 1, 1).data
        return `rgb(${d[0]},${d[1]},${d[2]})`
      } catch (_) { /* tainted canvas — fall through */ }
    }
  }
  return null
}

// ── CAPTURE: PANELS ─────────────────────────────────────────────────────────────

const MAX_PANEL_TILES = 20

async function runPanelComposite(tabId, dims, dpr, windowId) {
  const vpH = dims.viewportHeight
  const vpW = dims.viewportWidth
  const panels = dims.panels
  const bgColor = dims.bgColor || "#ffffff"

  // Step 1: compute initial tile counts (hard-capped at MAX_PANEL_TILES)
  let panelTileCounts = panels.map((p) => Math.min(Math.ceil(p.scrollHeight / p.clientHeight), MAX_PANEL_TILES))

  // Step 2: infinite scroll detection — ask user before allocating canvas
  const maxPanelTiles = Math.max(...panelTileCounts)
  if (maxPanelTiles > LONG_SCROLL_THRESHOLD) {
    const largestPanel = panels[panelTileCounts.indexOf(maxPanelTiles)]
    sendToPopup({
      type: "LONG_SCROLL_DETECTED",
      payload: { totalTiles: maxPanelTiles, scrollHeight: largestPanel.scrollHeight }
    })
    const maxTilesChoice = await new Promise((resolve) => {
      captureConfirmResolve = resolve
      setTimeout(() => { if (captureConfirmResolve) { captureConfirmResolve(null); captureConfirmResolve = null } }, 60000)
    })
    if (maxTilesChoice === null) throw new Error("Capture cancelled")
    if (maxTilesChoice > 0) {
      panelTileCounts = panelTileCounts.map((n) => Math.min(n, maxTilesChoice))
    }
  }

  // Step 3: allocate canvas sized to the ACTUAL captured content, not raw scrollHeight.
  // Effective height per panel = min(nTiles * clientHeight, scrollHeight).
  const canvasW = Math.floor(vpW * dpr)
  const maxPanelBottom = Math.max(
    ...panels.map((p, i) => p.rect.top + Math.min(panelTileCounts[i] * p.clientHeight, p.scrollHeight)),
    vpH
  )
  let canvasH = Math.floor(maxPanelBottom * dpr)
  let heightCapped = false
  if (canvasH > MAX_CANVAS_DIM) { canvasH = MAX_CANVAS_DIM; heightCapped = true }

  const canvas = new OffscreenCanvas(canvasW, canvasH)
  const ctx = canvas.getContext("2d")

  const totalTiles = 1 + panelTileCounts.reduce((s, n) => s + (n - 1), 0)
  sendToPopup({ type: "CAPTURE_START", payload: { totalTiles } })

  try {
    // Pre-scroll each panel to trigger lazy-loaded content, then re-read heights
    for (const p of panels) {
      await sendToTab(tabId, { type: "SCROLL_PANEL", payload: { selector: p.selector, y: p.scrollHeight } })
    }
    await sleep(LAZY_LOAD_SETTLE_MS)
    const dimsAfter = await sendToTab(tabId, { type: "GET_DIMENSIONS" })
    if (dimsAfter.panels) {
      for (const ap of dimsAfter.panels) {
        const orig = panels.find((p) => p.selector === ap.selector)
        if (orig && ap.scrollHeight > orig.scrollHeight) orig.scrollHeight = ap.scrollHeight
      }
    }
    // Reset all panels to top
    for (const p of panels) {
      await sendToTab(tabId, { type: "SCROLL_PANEL_TOP", payload: { selector: p.selector } })
    }
    await sleep(SCROLL_SETTLE_MS)

    // ── Tile 0: capture full viewport with all panels at scrollTop=0 ──
    // Same reasoning as the window-scroll path: capture tile 0 with ALL
    // elements visible so fixed/sticky chrome renders correctly at the top.
    // HIDE_FIXED is applied below before the per-panel strip loop.
    if (captureAborted) throw new Error("Capture cancelled")
    {
      const url0 = await rateLimitedCapture(tabId, windowId)
      const blob0 = await (await fetch(url0)).blob()
      const bmp0 = await createImageBitmap(blob0)
      ctx.drawImage(bmp0, 0, 0)
      bmp0.close()
    }
    sendToPopup({ type: "CAPTURE_PROGRESS", payload: { tile: 1, totalTiles } })

    // Fill area below initial viewport with the actual background color.
    // Sample a pixel from tile 0 at a position that is NOT inside any panel —
    // this is more reliable than CSS getComputedStyle (which often returns
    // rgba(0,0,0,0) for fixed-layout apps like Outlook).
    if (canvasH > Math.floor(vpH * dpr)) {
      const sampledColor = sampleNonPanelColor(ctx, panels, dpr, vpW, vpH) || bgColor
      ctx.fillStyle = sampledColor
      ctx.fillRect(0, Math.floor(vpH * dpr), canvasW, canvasH - Math.floor(vpH * dpr))
    }

    let tilesDone = 1

    // Hide fixed/sticky elements before the strip loop so they don't overdraw
    // into every subsequent panel tile (mirrors the window-scroll HIDE_FIXED path).
    if (totalTiles > 1) {
      await sendToTab(tabId, { type: "HIDE_FIXED" })
    }

    // ── Per-panel scroll + crop ──
    for (let pi = 0; pi < panels.length; pi++) {
      const p = panels[pi]
      const nTiles = panelTileCounts[pi]

      for (let i = 1; i < nTiles; i++) {
        if (captureAborted) throw new Error("Capture cancelled")

        const scrollY = i * p.clientHeight
        const sr = await sendToTab(tabId, { type: "SCROLL_PANEL", payload: { selector: p.selector, y: scrollY } })
        await sleep(SCROLL_SETTLE_MS)

        const actualScrollY = (sr && sr.actualScrollY != null) ? sr.actualScrollY : scrollY

        const tileUrl = await rateLimitedCapture(tabId, windowId)
        const tileBlob = await (await fetch(tileUrl)).blob()
        const bitmap = await createImageBitmap(tileBlob)

        // Source: panel's region in the viewport bitmap
        const sx = Math.floor(p.rect.left * dpr)
        const sy = Math.floor(p.rect.top * dpr)
        const sw = Math.floor(p.rect.width * dpr)
        const visH = Math.min(p.clientHeight, p.scrollHeight - actualScrollY)
        const sh = Math.max(1, Math.floor(visH * dpr))

        // Destination: same x, y = panelTop + actualScrollY in canvas space
        const dx = sx
        const dy = Math.floor((p.rect.top + actualScrollY) * dpr)
        const dh = Math.min(sh, canvasH - dy)

        if (dh > 0 && sw > 0) {
          ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, sw, dh)
        }
        bitmap.close()

        tilesDone++
        sendToPopup({ type: "CAPTURE_PROGRESS", payload: { tile: tilesDone, totalTiles } })
      }

      // Reset this panel before processing the next one
      await sendToTab(tabId, { type: "SCROLL_PANEL_TOP", payload: { selector: p.selector } })
      await sleep(Math.floor(SCROLL_SETTLE_MS / 2))
    }

    await sendToTab(tabId, { type: "RESTORE_FIXED" }).catch(() => {})

    const dataUrl = await canvasToDataUrl(canvas, "image/png")
    const thumbW = 200
    const thumbH = Math.max(1, Math.round(thumbW * (canvasH / canvasW)))
    const thumbCanvas = new OffscreenCanvas(thumbW, thumbH)
    thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, thumbW, thumbH)
    const thumbnailUrl = await canvasToDataUrl(thumbCanvas, "image/jpeg", 0.7)

    return { dataUrl, thumbnailUrl, canvasW, canvasH, heightCapped }

  } finally {
    // Best-effort: reset all panels on success or error
    for (const p of panels) {
      await sendToTab(tabId, { type: "SCROLL_PANEL_TOP", payload: { selector: p.selector } }).catch(() => {})
    }
  }
}

// ── SHARED UTILITIES ─────────────────────────────────────────────────────────────

async function stitchTile(tabId, ctx, vpH, finalScrollHeight, dpr, actualScrollY, windowId) {
  const tileDataUrl = await rateLimitedCapture(tabId, windowId)
  const tileBlob = await (await fetch(tileDataUrl)).blob()
  const bitmap = await createImageBitmap(tileBlob)

  // How much CSS space this tile covers
  const visH = Math.min(vpH, finalScrollHeight - actualScrollY)

  // Source: use the bitmap's actual pixel ratio (may differ from canvas dpr
  // when device emulation DPR > 2, since canvas dpr is capped at 2)
  const bitmapDpr = vpH > 0 ? bitmap.height / vpH : dpr
  const srcH = Math.round(visH * bitmapDpr)

  // Destination: place at canvas coordinates using the canvas dpr
  const destY = Math.round(actualScrollY * dpr)
  const destW = ctx.canvas.width
  const destH = Math.round(visH * dpr)

  if (srcH > 0 && destH > 0) {
    ctx.drawImage(bitmap, 0, 0, bitmap.width, srcH, 0, destY, destW, destH)
  }
  bitmap.close()
}

// Convert a raw base64 string returned by Page.captureScreenshot (no data-URL
// prefix) into an ImageBitmap suitable for drawing onto an OffscreenCanvas.
async function cdpBase64ToBitmap(base64) {
  const resp = await fetch(`data:image/png;base64,${base64}`)
  const blob = await resp.blob()
  return createImageBitmap(blob)
}

async function canvasToDataUrl(canvas, mimeType, quality) {
  const opts = quality !== undefined ? { type: mimeType, quality } : { type: mimeType }
  const blob = await canvas.convertToBlob(opts)
  const ab = await blob.arrayBuffer()
  const uint8 = new Uint8Array(ab)
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize))
  }
  return `${mimeType === "image/jpeg" ? "data:image/jpeg" : "data:image/png"};base64,` + btoa(binary)
}

// Capture the visible tab in a specific window so a focus change during a
// long multi-tile capture does not accidentally screenshot the wrong tab.
async function rateLimitedCapture(tabId, windowId) {
  const now = Date.now()
  const elapsed = now - lastCaptureTime
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed)
  lastCaptureTime = Date.now()
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" })
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}

function sendToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {})
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
