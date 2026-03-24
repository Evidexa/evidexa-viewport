if (!window.__screenshotScriptLoaded) {
  window.__screenshotScriptLoaded = true
  chrome.runtime.onMessage.addListener(handleMessage)
}

var hiddenElements = []
var detectedScrollSelector = null

// Returns up to 4 independently scrollable panels visible in the viewport.
//
// Panel detection heuristic:
//   • querySelectorAll("*") is intentional. Panel containers have no reliable
//     class, role, or tag pattern across apps (Outlook uses <div> inside a custom
//     element; Teams uses deeply nested flex containers). A targeted selector
//     would be brittle. The full sweep runs once per capture, not on every frame.
//   • Threshold ≥15% vpW AND ≥30% vpH: wide enough to exclude decorative scrollboxes
//     (tags list, dropdown) while capturing email lists and thread panes that
//     are typically ≈20–40% wide × ≈40–70% tall in fixed-layout apps.
//   • Innermost wins: if an ancestor and a descendant both qualify, keep the
//     descendant so we scroll the element that actually moves, not a wrapper.
//   • Capped at 4 panels to bound canvas memory and tile count.
function findScrollPanels() {
  const vpH = window.innerHeight
  const vpW = window.innerWidth
  const found = []
  const all = document.querySelectorAll("*")
  for (const el of all) {
    if (el === document.documentElement || el === document.body) continue
    const style = getComputedStyle(el)
    const overflowY = style.overflowY
    if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") continue
    if (el.scrollHeight <= el.clientHeight + 50) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < vpW * 0.15) continue
    if (rect.height < vpH * 0.30) continue
    // Skip ancestors that already contain a qualifying child (keep innermost)
    const alreadyCovered = found.some((p) => p.el.contains(el))
    if (alreadyCovered) {
      // Replace parent with child if child is inside an already-found panel
      const parentIdx = found.findIndex((p) => el.contains(p.el))
      if (parentIdx !== -1) found.splice(parentIdx, 1)
    }
    found.push({ el, rect })
  }
  // Sort largest area first, then cap at 4.
  // The cap is applied after sorting so DOM order cannot bias selection —
  // the 4 largest qualifying panels win regardless of where they appear in the tree.
  found.sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
  return found.slice(0, 4)
}

function cssSelectorFor(el) {
  if (el.id) return "#" + CSS.escape(el.id)
  const parts = []
  let node = el
  while (node && node !== document.body) {
    let selector = node.tagName.toLowerCase()
    if (node.id) { selector = "#" + CSS.escape(node.id); parts.unshift(selector); break }
    const siblings = Array.from(node.parentNode ? node.parentNode.children : [])
    const idx = siblings.indexOf(node) + 1
    selector += ":nth-child(" + idx + ")"
    parts.unshift(selector)
    node = node.parentNode
  }
  return parts.join(" > ") || el.tagName.toLowerCase()
}

function handleMessage(message, sender, sendResponse) {
  switch (message.type) {
    case "GET_DIMENSIONS": {
      // Probe whether the window can actually scroll — scrollHeight > innerHeight
      // is not reliable for fixed-layout webapps (Outlook, Teams, etc.) where
      // absolutely-positioned elements inflate scrollHeight but the viewport never moves.
      const _prevY = window.scrollY
      const _probe = _prevY > 0 ? _prevY - 1 : _prevY + 2
      window.scrollTo({ top: _probe, behavior: "instant" })
      const _canScroll = window.scrollY !== _prevY
      window.scrollTo({ top: _prevY, behavior: "instant" })
      const bodyScrolls = _canScroll && document.documentElement.scrollHeight > window.innerHeight + 10

      if (bodyScrolls) {
        detectedScrollSelector = null
        // Sample background color from a corner pixel (used for panel composite fill)
        const bgColor = getComputedStyle(document.documentElement).backgroundColor || "#ffffff"
        sendResponse({
          bodyScrolls: true,
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth),
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          devicePixelRatio: window.devicePixelRatio || 1,
          panels: [],
          bgColor
        })
        return false
      }

      // Fixed-layout app: find all independently scrollable panels
      const rawPanels = findScrollPanels()
      const bgColor = getComputedStyle(document.documentElement).backgroundColor || "#ffffff"
      const panels = rawPanels.map((p) => {
        const sel = cssSelectorFor(p.el)
        return {
          selector: sel,
          rect: {
            left: Math.round(p.rect.left),
            top: Math.round(p.rect.top),
            width: Math.round(p.rect.width),
            height: Math.round(p.rect.height)
          },
          scrollHeight: p.el.scrollHeight,
          clientHeight: p.el.clientHeight,
          scrollWidth: p.el.scrollWidth,
          clientWidth: p.el.clientWidth
        }
      })

      sendResponse({
        bodyScrolls: false,
        scrollHeight: window.innerHeight,
        scrollWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
        panels,
        bgColor
      })
      return false
    }

    case "INJECT_CAPTURE_CSS": {
      let captureStyle = document.getElementById("__evidexa_capture_style")
      if (!captureStyle) {
        captureStyle = document.createElement("style")
        captureStyle.id = "__evidexa_capture_style"
        document.head.appendChild(captureStyle)
      }
      captureStyle.textContent = [
        "::-webkit-scrollbar { display: none !important; }",
        "html, body { scrollbar-width: none !important; scroll-behavior: auto !important; }"
      ].join("\n")
      sendResponse({ ok: true })
      return false
    }

    case "HIDE_FIXED": {
      hiddenElements = []
      const vpH = window.innerHeight
      const vpW = window.innerWidth
      const all = document.querySelectorAll("*")
      for (const el of all) {
        const pos = getComputedStyle(el).position
        if (pos !== "fixed" && pos !== "sticky") continue
        const rect = el.getBoundingClientRect()
        // Tall + narrow elements are sidebars — they stitch correctly across
        // tiles and should remain visible.
        if (rect.height > vpH * 0.6 && rect.width < vpW * 0.4) continue
        // Off-screen elements have no visual impact.
        if (rect.bottom < 0 || rect.top > vpH || rect.right < 0 || rect.left > vpW) continue
        hiddenElements.push({ el, originalVisibility: el.style.visibility })
        el.style.visibility = "hidden"
      }
      sendResponse({ hiddenCount: hiddenElements.length })
      return false
    }

    case "RESTORE_FIXED": {
      for (const { el, originalVisibility } of hiddenElements) {
        el.style.visibility = originalVisibility
      }
      hiddenElements = []
      const captureStyle = document.getElementById("__evidexa_capture_style")
      if (captureStyle) captureStyle.remove()
      sendResponse({ done: true })
      return false
    }

    case "SCROLL_TO": {
      const { y, scrollSelector } = message.payload
      const sel = scrollSelector || detectedScrollSelector
      const target = sel ? document.querySelector(sel) : null
      if (target) {
        target.scrollTop = y
      } else {
        window.scrollTo({ top: y, behavior: "instant" })
      }
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => {
        const actual = target ? target.scrollTop : window.scrollY
        sendResponse({ done: true, actualScrollY: actual })
      })
      return true
    }

    case "SCROLL_TOP": {
      const sel = message.payload && message.payload.scrollSelector
        ? message.payload.scrollSelector
        : detectedScrollSelector
      const target = sel ? document.querySelector(sel) : null
      if (target) {
        target.scrollTop = 0
      } else {
        window.scrollTo({ top: 0, behavior: "instant" })
      }
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => {
        sendResponse({ done: true })
      })
      return true
    }

    case "SCROLL_PANEL": {
      const { selector: panelSel, y: panelY } = message.payload
      const panelEl = panelSel ? document.querySelector(panelSel) : null
      if (panelEl) {
        panelEl.scrollTop = panelY
      }
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => {
        sendResponse({ done: true, actualScrollY: panelEl ? panelEl.scrollTop : 0 })
      })
      return true
    }

    case "SCROLL_PANEL_TOP": {
      const { selector: topSel } = message.payload
      const topEl = topSel ? document.querySelector(topSel) : null
      if (topEl) topEl.scrollTop = 0
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => {
        sendResponse({ done: true })
      })
      return true
    }

    default:
      return false
  }
}
