# Evidexa Viewport

Evidexa Viewport is a Chrome extension for capturing full-page screenshots, scrollable app layouts, and selected regions directly in the browser.

Captured screenshots are stored locally in IndexedDB and can be reviewed from the extension's result tab, copied to the clipboard, or exported as PNG, JPEG, or PDF.

## Features

- Full-page capture for standard scrolling pages
- Composite capture for fixed-layout web apps with independently scrollable panels
- Region capture
- Device-emulated capture presets from the extension context menu
- Local screenshot history with preview, metadata, and delete controls
- Clipboard copy and export to PNG, JPEG, and PDF
- No backend dependency; data stays on the local device

## Project Structure

```text
.
├── manifest.json
├── background.js
├── content.js
├── region-selector.js
├── popup.html / popup.js / popup.css
├── tab.html / tab.js / tab.css
├── db.js
├── lib/
│   └── jspdf.umd.min.js
├── icons/
├── docs/
│   ├── architecture.md
│   └── roadmap.md
├── scripts/
│   └── gen-icons.py
└── tests/
    ├── e2e.test.js
    ├── helpers.js
    ├── fixtures/
    ├── jest.config.js
    └── package.json
```

## Requirements

- Google Chrome or another Chromium-based browser with support for Manifest V3 extensions
- Node.js and npm for running the test suite

## Load the Extension Locally

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository directory.

The extension will then appear in the browser toolbar. The default keyboard shortcut is `Command+Shift+Y` on macOS and `Ctrl+Shift+Y` on other platforms.

## Usage

- Click the extension button to start a full-page capture.
- Right-click the extension action to use:
  - `Capture Region...`
  - `Render as...` device presets
- After capture, the extension opens `tab.html` with:
  - current capture preview
  - capture metadata
  - history
  - storage and behavior settings

## Development Notes

- This project has no bundler or compile step. The extension ships from the source files in this repository.
- `background.js` is a classic MV3 service worker and intentionally remains a non-module script.
- `tab.js` is loaded as an ES module.
- `docs/architecture.md` documents the capture pipeline, message protocol, and storage model.

## Testing

The automated tests live in `tests/` and use Jest with Puppeteer to run end-to-end extension flows against local fixture pages.

```bash
cd tests
npm install
npm test
```

The test suite covers:

- extension startup
- full-page capture flow
- result-tab rendering
- download button behavior
- panel-composite capture
- restricted-page edge cases

## Contributing

Pull requests are welcome.

If you plan to make non-trivial changes, start by reading `docs/architecture.md` and `docs/roadmap.md`, then inspect `background.js` and `content.js`, which contain most of the capture logic.

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

## Trademark Notice

`Evidexa`, `Evidexa Viewport`, and related logos or branding are not licensed for unrestricted reuse under the open source license. The Apache-2.0 license covers the code, but it does not grant permission to use trade names, trademarks, service marks, or product branding except for reasonable and customary reference to the origin of the project.
