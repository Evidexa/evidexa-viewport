if (!window.__evidexaRegionSelectorLoaded) {
  window.__evidexaRegionSelectorLoaded = true;

  (function () {
    const Z = 2147483647

    // ── Overlay ──────────────────────────────────────────────────────────────
    const overlay = document.createElement("div")
    overlay.id = "__evidexa_region_overlay"
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: Z,
      cursor: "crosshair",
      userSelect: "none",
      background: "rgba(0,0,0,0.35)"
    })

    // Selection rectangle
    const sel = document.createElement("div")
    Object.assign(sel.style, {
      position: "fixed",
      border: "2px solid #18b5b3",
      background: "rgba(24,181,179,0.08)",
      boxSizing: "border-box",
      display: "none",
      pointerEvents: "none",
      zIndex: Z + 1
    })

    // Dimension label
    const label = document.createElement("div")
    Object.assign(label.style, {
      position: "fixed",
      background: "#18b5b3",
      color: "#fff",
      fontSize: "11px",
      fontFamily: "monospace",
      padding: "2px 6px",
      borderRadius: "3px",
      pointerEvents: "none",
      zIndex: Z + 2,
      display: "none",
      whiteSpace: "nowrap"
    })

    // Hint bar
    const hint = document.createElement("div")
    Object.assign(hint.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(29,35,51,0.92)",
      color: "#fff",
      fontSize: "13px",
      fontFamily: "system-ui, sans-serif",
      padding: "8px 18px",
      borderRadius: "8px",
      zIndex: Z + 2,
      pointerEvents: "none",
      whiteSpace: "nowrap",
      boxShadow: "0 2px 12px rgba(0,0,0,0.4)"
    })
    hint.textContent = "Drag to select a region  •  Esc to cancel"

    document.body.appendChild(overlay)
    document.body.appendChild(sel)
    document.body.appendChild(label)
    document.body.appendChild(hint)

    // ── Drag state ───────────────────────────────────────────────────────────
    let startX = 0, startY = 0
    let dragging = false

    function cleanup() {
      overlay.remove()
      sel.remove()
      label.remove()
      hint.remove()
      window.__evidexaRegionSelectorLoaded = false
    }

    function getRect(x1, y1, x2, y2) {
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1)
      }
    }

    overlay.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging = true
      startX = e.clientX
      startY = e.clientY
      sel.style.display = "block"
      label.style.display = "block"
      updateSelection(e.clientX, e.clientY)
    })

    overlay.addEventListener("mousemove", (e) => {
      if (!dragging) return
      updateSelection(e.clientX, e.clientY)
    })

    overlay.addEventListener("mouseup", (e) => {
      if (!dragging) return
      dragging = false
      const r = getRect(startX, startY, e.clientX, e.clientY)
      if (r.w < 10 || r.h < 10) {
        sel.style.display = "none"
        label.style.display = "none"
        return
      }
      cleanup()
      chrome.runtime.sendMessage({
        type: "REGION_SELECTED",
        payload: { x: r.x, y: r.y, w: r.w, h: r.h, dpr: window.devicePixelRatio || 1 }
      })
    })

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        cleanup()
        chrome.runtime.sendMessage({ type: "REGION_CANCELLED" })
      }
    }, { once: true })

    function updateSelection(cx, cy) {
      const r = getRect(startX, startY, cx, cy)
      sel.style.left = r.x + "px"
      sel.style.top = r.y + "px"
      sel.style.width = r.w + "px"
      sel.style.height = r.h + "px"

      label.textContent = `${r.w} × ${r.h}`
      const lx = Math.min(r.x + r.w + 6, window.innerWidth - 80)
      const ly = Math.max(r.y - 22, 4)
      label.style.left = lx + "px"
      label.style.top = ly + "px"
    }
  })()
}
