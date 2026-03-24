# Evidexa Screenshot — Feature Roadmap

Features not yet implemented, ordered by estimated user value.

---

## High Priority

### Annotations
Draw on top of a capture before saving: arrows, rectangles, text labels, highlighter.

**Approach:** Post-capture canvas overlay in `tab.html`. Toolbar with tools (select, arrow, rect, text, highlight). Renders into a secondary canvas stacked over the preview image. "Flatten & Save" re-encodes to PNG and updates the IndexedDB record.

**Effort:** Large (canvas drawing, hit-testing, undo stack).

---

### Redact / Blur
Drag a rectangle over sensitive content to blur it before saving.

**Approach:** Similar to annotations overlay. Apply `ctx.filter = "blur(8px)"` to the selected rectangle region of the canvas. Simpler than full annotations.

**Effort:** Medium.

---

### Watermark Toggle
Embed the source URL and timestamp directly into the screenshot canvas.

**Approach:** Settings toggle → when enabled, before `canvasToDataUrl`, draw a semi-transparent footer strip at the bottom of the canvas with the URL and ISO timestamp in a small monospace font.

**Effort:** Small.

---

## Medium Priority

### Diff / Compare View
Compare two captures of the same URL to highlight what changed.

**Approach:** History tab → select two captures → pixel diff on an `OffscreenCanvas`. Highlight changed pixels in red (or use blend-mode `difference`). Display side-by-side + diff panel.

**Effort:** Large.

---

### Export ZIP
Select multiple history captures and download as a ZIP archive.

**Approach:** Add checkboxes to history grid. "Export selected" button → use `JSZip` (or native `CompressionStream` API) to bundle data URLs as PNG files → trigger download.

**Effort:** Medium. JSZip adds ~100 KB to bundle (or use native `CompressionStream` in Chrome 102+).

---

### Tags + Search
Add searchable tags to each capture for organisation.

**Approach:** Add `tags: string[]` field to IndexedDB records. Tag input in the detail view. Filter/search bar in History tab. IndexedDB doesn't support full-text search natively — filter in JS after `getAllCaptures()`.

**Effort:** Medium.

---

### Scheduled Auto-Capture
Automatically capture a URL on a schedule (e.g. daily).

**Approach:** `chrome.alarms` API for scheduling. Stored schedule list in `chrome.storage.sync`. Background service worker wakes on alarm, opens the URL in a background tab, captures, saves. Requires `"background"` permission (already present as service worker).

**Effort:** Large (background tab management, de-duplication).

---

## Lower Priority

### Share as Link
Upload a capture to cloud storage and get a shareable URL.

**Approach:** Requires a backend (S3/R2 presigned URL endpoint or a BaaS). Out of scope without infrastructure. Could integrate with user-provided S3 bucket via access keys stored in `chrome.storage.sync`.

**Effort:** Very large (backend required).

---

### OCR / Text Extraction
Extract selectable text from a screenshot.

**Approach:** `Tesseract.js` (~2 MB WASM) or call an external API (Google Vision, etc.). For extension use, Tesseract.js is self-contained but large. Alternative: Chrome's built-in `ShapeDetection` API (experimental, text detection not widely available).

**Effort:** Large (bundle size or external dependency).

---

### Clipboard History Panel
Show recent clipboard copies inside the extension tab.

**Approach:** Clipboard read requires `"clipboardRead"` permission (shows scary prompt). Not worth the permission cost. The Copy PNG button is sufficient.

**Status:** Deprioritised — permission cost too high.
