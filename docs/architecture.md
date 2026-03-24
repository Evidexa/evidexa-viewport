# Evidexa Screenshot — Architecture

## Overview

MV3 Chrome Extension. Full-page screenshots via scroll-and-stitch using `OffscreenCanvas`. No external backend — all data stored locally in IndexedDB.

---

## File Map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `activeTab`, `scripting`, `contextMenus`, `tabs`, `storage`, `debugger`. `host_permissions: ["<all_urls>"]` |
| `background.js` | Classic service worker (non-module). Orchestrates all capture flows. Inlines IndexedDB save helper. |
| `content.js` | Injected into target tab. Probes scroll, hides fixed elements, scrolls window/panels, returns dimensions. |
| `region-selector.js` | Injected on "Capture Region". Renders a dim overlay + drag-rect UI; sends `REGION_SELECTED` to background. |
| `popup.html/js/css` | Action popup. Auto-fires `REQUEST_CAPTURE` on open. Shows progress bar + tile counter + Cancel button. |
| `tab.html/js/css` | Full control-plane tab (ES module). Current Capture, History, Settings tabs. |
| `db.js` | ES module IndexedDB wrapper (`evidexa_db` v1, store: `captures`). |
| `lib/jspdf.umd.min.js` | Vendored jsPDF v2.5.2 for PDF export. |

---

## Capture Flows

### 1. Full-page (window scroll)
**Trigger:** Popup open → `REQUEST_CAPTURE` → `runCapture(tabId)`

```
Inject content.js
→ GET_DIMENSIONS (probe bodyScrolls, detect panels)
→ bodyScrolls = true:
    Pre-scroll to bottom (lazy load)
    Re-measure scroll height
    [Optional] LONG_SCROLL_DETECTED → await user tile choice
    CAPTURE_START (totalTiles)
    Tile 0: SCROLL_TO 0 → captureVisibleTab → stitch
    Tiles 1+: HIDE_FIXED → loop SCROLL_TO + captureVisibleTab + stitch
    RESTORE_FIXED → SCROLL_TOP
    Encode PNG → generate thumbnail → dbSaveCapture → open tab.html
```

### 2. Panel composite (fixed-layout apps: Outlook, Teams)
**Trigger:** Same as above, but `bodyScrolls = false` and `panels.length > 0`

```
[Optional] LONG_SCROLL_DETECTED → await user tile choice
Allocate OffscreenCanvas (vpW × effective captured height)
Pre-scroll each panel (lazy load) → re-read heights
Reset panels to top
Tile 0: captureVisibleTab → drawImage onto canvas
Fill below-fold area with sampled background colour
For each panel × each tile:
    SCROLL_PANEL → captureVisibleTab → crop & drawImage into canvas strip
RESTORE_FIXED → encode → thumbnail → dbSaveCapture → open tab.html
```

### 3. Device-emulated capture
**Trigger:** Right-click extension button → "Render as…" → device name

Implemented in `runDeviceCapture`. Uses the Chrome Debugger Protocol directly
(does **not** delegate to `runCapture`). Single-shot capture — no tile stitching.

```
chrome.debugger.attach({ tabId }, "1.3")
[mobile] Emulation.setUserAgentOverride(device.userAgent)

Step 1 — layout reflow
  Emulation.setDeviceMetricsOverride(width, height=device.height, dpr, mobile)
  sleep 1500ms   ← media queries, font scaling, mobile CSS key off window.innerWidth

Step 2 — hide scrollbars
  Runtime.evaluate: SCRIPT_INJECT_SCROLLBAR_CSS

Step 3 — classify page layout (SCRIPT_CLASSIFY_PAGE)
  Single Runtime.evaluate IIFE. Returns { mode, contentH } and stores the chosen
  element on window.__evidexaCaptureSurface for use by subsequent scroll scripts.

  Decision tree:
    documentElement.scrollHeight > vpH + 4
      → mode = "root-scroll",              contentH = rootScrollHeight
    else scan all elements for dominant candidates:
      candidate = scrollable + BCR ≥50% vpW AND ≥50% vpH + not hidden
    candidates.length ≠ 1
      → mode = "fixed-shell-or-ambiguous", contentH = device.height
    exactly 1 candidate — spacer veto:
      scrollRatio = candidate.scrollHeight / candidate.clientHeight
      hasSpacer   = any of first 10 direct children has inline style.height > clientHeight × 3
      scrollRatio > 10 AND hasSpacer
        → mode = "fixed-shell-or-ambiguous", contentH = device.height
      else
        → mode = "single-safe-inner-surface", contentH = candidate.scrollHeight

Step 4 — pre-scroll chosen surface (lazy-load trigger)
  SCRIPT_SCROLL_SURFACE_DOWN: reads window.__evidexaCaptureSurface; scrolls
    document + that exact element to bottom (same reference — no re-selection drift)
  sleep LAZY_LOAD_SETTLE_MS
  SCRIPT_SCROLL_SURFACE_UP: same element back to top
  sleep SCROLL_SETTLE_MS

Step 5 — extend viewport (expandable modes only)
  root-scroll or single-safe-inner-surface:
    Emulation.setDeviceMetricsOverride(height=min(contentH, MAX_CANVAS_DIM/dpr))
    sleep 800ms
  fixed-shell-or-ambiguous: skip — keep device.height to prevent duplicate-shell
    relayout artifacts in SPAs (Outlook, Gmail, Slack…)

Step 6 — single-shot screenshot
  Page.captureScreenshot({ format: "png" })   ← no clip, no captureBeyondViewport
  Decode base64 → OffscreenCanvas → encode PNG → generate thumbnail → dbSaveCapture
  chrome.tabs.create(tab.html?id=captureId)

finally (always runs):
  Emulation.clearDeviceMetricsOverride
  [mobile] Emulation.setUserAgentOverride("")
  chrome.debugger.detach
```

**Why classify before expanding?**
A root-only `scrollHeight` measurement causes two opposite regressions:
- Outlook/Gmail (fixed-shell SPA): inner scroll containers report huge `scrollHeight`;
  expanding to that value forces a re-layout that renders a duplicate shell below the fold.
- Airtable/forms (inner-scroll SPA): the document is `overflow:hidden` so root
  `scrollHeight == device.height`; root-only measurement clips all inner content.

The classifier resolves this by distinguishing layout class first, then choosing the
right height source and suppressing expansion when the page structure is ambiguous.

### 4. Region capture
**Trigger:** Right-click extension button → "Capture Region…"

```
Inject region-selector.js
Await REGION_SELECTED { x, y, w, h, dpr }
captureVisibleTab → createImageBitmap → crop on OffscreenCanvas
Encode PNG → thumbnail → dbSaveCapture → open tab.html
```

---

## Message Protocol

| Message | Direction | Purpose |
|---|---|---|
| `REQUEST_CAPTURE` | popup → background | Start full-page capture |
| `CAPTURE_START` | background → popup | Begin progress display |
| `CAPTURE_PROGRESS` | background → popup | Tile progress update |
| `CAPTURE_DONE` | background → popup | Capture complete |
| `CAPTURE_ERROR` | background → popup | Capture failed |
| `CAPTURE_CANCELLED` | background → popup | User cancelled |
| `CANCEL_CAPTURE` | popup → background | User pressed Cancel |
| `LONG_SCROLL_DETECTED` | background → popup | Page has > 10 tiles |
| `CONFIRM_CAPTURE` | popup → background | User chose tile count |
| `REGION_SELECTED` | content → background | User drew a region |
| `REGION_CANCELLED` | content → background | User pressed Escape |
| `GET_DIMENSIONS` | background → content | Get page scroll info |
| `INJECT_CAPTURE_CSS` | background → content | Hide scrollbars |
| `HIDE_FIXED` | background → content | Hide fixed/sticky elements |
| `RESTORE_FIXED` | background → content | Restore hidden elements |
| `SCROLL_TO` | background → content | Scroll window to Y |
| `SCROLL_TOP` | background → content | Reset window scroll |
| `SCROLL_PANEL` | background → content | Scroll a panel element |
| `SCROLL_PANEL_TOP` | background → content | Reset a panel scroll |

---

## IndexedDB Schema

Database: `evidexa_db` v1, object store: `captures` (keyPath: `id`, autoIncrement).

| Field | Type | Notes |
|---|---|---|
| `id` | number | Auto-increment primary key |
| `dataUrl` | string | Full-res PNG as base64 data URL |
| `thumbnailUrl` | string | 200px-wide JPEG thumbnail |
| `sourceUrl` | string | URL of the captured page |
| `sourceTitle` | string | Page title |
| `width` | number | Canvas width in physical pixels |
| `height` | number | Canvas height in physical pixels |
| `dpr` | number | Device pixel ratio used (capped at 2) |
| `heightCapped` | boolean | True if canvas hit MAX_CANVAS_DIM (32767) |
| `originalScrollHeight` | number | Pre-cap scroll height in CSS px |
| `devicePreset` | string\|null | Device name if captured via "Render as…" |
| `captureType` | string\|null | `"region"` for region captures |
| `timestamp` | string | ISO 8601 |

Indexes: `timestamp` (non-unique), `sourceUrl` (non-unique).

---

## Key Constants (`background.js`)

| Constant | Value | Purpose |
|---|---|---|
| `MAX_CANVAS_DIM` | 32767 | Chrome's OffscreenCanvas max dimension |
| `RATE_LIMIT_MS` | 520 | Min ms between `captureVisibleTab` calls |
| `SCROLL_SETTLE_MS` | 150 | Wait after scroll before capture |
| `LAZY_LOAD_SETTLE_MS` | 300 | Wait after pre-scroll for lazy images |
| `LONG_SCROLL_THRESHOLD` | 10 | Tiles before prompting user |
| `MAX_PANEL_TILES` | 20 | Hard cap per panel in composite mode |

---

## Test Architecture

Located in `tests/`. Uses Puppeteer v24 with `--enable-extensions`.

```
tests/
  helpers.js          # launchBrowser, startFixtureServer, waitForResultTab, getServiceWorker
  e2e.test.js         # 22 tests (~40s)
  fixtures/
    tall-page.html        # Normal scrolling page (~3× viewport height)
    tall-panels.html      # Fixed-layout page with 2 overflow:auto panels
    very-tall-page.html      # 50-section page (~10 800 px) for long-scroll detection
    virtual-scroll-page.html  # Virtual-scroll SPA (sparse DOM rail) — fixed-shell-or-ambiguous classifier case
    inner-scroll-page.html    # Real stacked inner scroll (form) — single-safe-inner-surface classifier case
```

**Test suites:**
| Suite | Tests | Notes |
|---|---|---|
| Extension loads | 2 | SW startup, contextMenus permission |
| Capture flow | 4 | Full-page capture, dimensions, IndexedDB |
| Download buttons | 3 | PNG / JPEG / PDF |
| Panel composite capture | 3 | Fixed-layout composite |
| Long-scroll detection | 3 | Suspend/confirm/cancel; `beforeEach` resets `captureAborted` |
| Device-emulated capture | 2 | iPad preset; tab created via extension API to avoid CDP conflict with Puppeteer |
| Mobile device capture | 1 | iPhone SE (mobile:true); guards UA override path + narrow-viewport root-scroll expansion |
| Device capture classifier | 2 | virtual-scroll SPA → fixed-shell-or-ambiguous (no expansion); inner-scroll form → single-safe-inner-surface (expansion) |
| Region capture | 1 | Real Puppeteer mouse drag on injected overlay |
| Edge cases | 1 | Restricted URL guard |

**Key patterns:**
- `triggerCapture` calls `worker.evaluate((tid) => runCapture(tid))` via CDP to keep the service worker alive during capture.
- `waitForResultTab` polls for a `tab.html` page with `#capture-content:not(.hidden)`.
- Long-scroll tests poll `captureConfirmResolve` from Node.js with repeated `worker.evaluate` calls while the SW is suspended, then resolve or cancel it.

Run: `cd tests && npm test`
