# Evidexa Screenshot — Feature Roadmap

Features not yet implemented, ordered by estimated user value.

---

## High Priority

### Custom Device Presets
Let users create and save their own viewport presets instead of relying only on the built-in device list.

**Approach:** Add a custom preset editor in Settings with `name`, `width`, `height`, `dpr`, optional mobile flag, and optional user agent. Persist presets in `chrome.storage.sync` and surface them in the "Render as…" menu and full-tab UI.

**Effort:** Medium.

---

### Saved Viewport Sets
Save reusable collections like "iPhone + iPad + Desktop" or "Client QA Pack".

**Approach:** Introduce named viewport-set records that reference built-in and custom presets. Add "Save current selection as set" in the full-tab UI and a quick picker for rerunning a saved set.

**Effort:** Medium.

---

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

### Batch Device Capture + ZIP Export
Capture several viewport presets in one run and download them as a ZIP bundle.

**Approach:** Extend device capture to queue multiple presets against the same URL, save each result as a separate capture, then offer "Export set" via `CompressionStream` or `JSZip`. This can share infrastructure with Saved Viewport Sets.

**Effort:** Large.

---

### Multi-Viewport Workspace
Preview and capture the same page in several devices side by side from one workspace.

**Approach:** Add a workspace view in `tab.html` that lays out multiple viewport cards, each bound to a preset. Start with synchronized URL/reload controls and per-card capture, then optionally add synchronized scroll.

**Effort:** Large.

---

### Device Frames / Presentation Mode
Wrap raw captures in optional device mockups and labeled comparison layouts for sharing.

**Approach:** Add a presentation export mode that composites screenshots into simple phone/tablet/browser frames on an `OffscreenCanvas`, with optional labels, background, and timestamp.

**Effort:** Medium.

---

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

### Behavioral Overlay
Overlay simulated attention, click-likelihood, hesitation, or heatmap views on top of a captured screen.

**Approach:** Use Evidexa behavioral models against a saved capture or live page snapshot, then render heatmap and path overlays in `tab.html` as a toggleable analysis layer. Start with static overlays before adding animation.

**Effort:** Very large (model integration + overlay UX).

---

### Persona Task Simulation
Ask digital twins to complete a task on a captured experience and report likely path, friction, and completion risk.

**Approach:** Let the user provide a goal such as "find pricing" or "submit the form", run one or more Evidexa personas against the capture, and return a structured report with predicted click path, hesitation zones, trust concerns, and heuristics.

**Effort:** Very large (simulation product + reporting UX).

---

### Viewport Behavior Comparison
Compare how simulated users behave across devices, variants, or revisions.

**Approach:** Run the same persona/task across desktop vs mobile, or capture A vs B, then present differences in attention concentration, CTA discoverability, and predicted completion likelihood.

**Effort:** Very large.

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
