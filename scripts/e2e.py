#!/usr/bin/env python3
"""Headless E2E for gpx-route-reveal. Serves dist/ via vite preview, drives via Playwright.
Run from repo root. Requires: python playwright in the hermes venv, `npm run build` already run."""
import subprocess, sys, time, json, pathlib, os

PW = "/Users/user/.hermes/hermes-agent/venv/bin/python"
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
os.chdir(root)

# start vite preview on a fixed port, capture errors
server = subprocess.Popen(
    ["node", "node_modules/vite/bin/vite.js", "preview", "--port", "5199", "--strictPort"],
    cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
)
time.sleep(1.5)

errors, warnings = [], []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: (errors.append(m.text) if m.type == "error" else None) or
                                     (warnings.append(m.text) if m.type == "warning" else None))
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto("http://localhost:5199", wait_until="domcontentloaded")
        page.wait_for_selector("#map canvas", timeout=20000)
        page.wait_for_function("window.__map !== undefined", timeout=15000)

        page.set_input_files("#file", str(root / "public" / "demo.gpx"))
        page.wait_for_selector("#meta:not([hidden])", timeout=10000)
        # auto-load + this drop both queue a build; let them settle, then play
        page.wait_for_timeout(1500)
        page.evaluate("window.__reveal.setPlaying(true)")
        page.wait_for_timeout(3000)
        paused = page.locator("#play").is_disabled()  # playing → Play disabled, Pause enabled

        state = page.evaluate("""() => {
          const r = window.__reveal;
          const m = window.__map;
          return {
            hasRouteProgress: !!m.getLayer('route-progress'),
            hasRouteFull: !!m.getLayer('route-full'),
            routeCoords: (m.querySourceFeatures('route-progress')[0]?.geometry?.coordinates?.length) || 0,
            // head dot must sit at the growth tip: last progress coord == head coord
            headSync: (() => {
              const line = m.querySourceFeatures('route-progress')[0]?.geometry?.coordinates;
              const head = m.querySourceFeatures('head')[0]?.geometry?.coordinates;
              return !!line?.length && !!head &&
                Math.abs(line[line.length - 1][0] - head[0]) < 1e-6 &&
                Math.abs(line[line.length - 1][1] - head[1]) < 1e-6;
            })(),
            t: r ? r.state.t : null,
            zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(),
          };
        }""")
        page.screenshot(path=str(root / "e2e-shot.png"))

        # --- pick-route flow: click Pick, then two map points → BRouter route ---
        page.evaluate("window.__reveal && window.__reveal.setPlaying(false)")
        page.click("#pick")
        hint1 = page.locator("#drop").text_content()
        page.mouse.click(800, 400)  # start
        page.wait_for_timeout(200)
        hint2 = page.locator("#drop").text_content()
        page.mouse.click(400, 500)  # end
        page.wait_for_function(
            "window.__reveal && window.__reveal.track.name === 'Picked route'", timeout=30000)
        pick_state = page.evaluate("""() => {
          const m = window.__map, r = window.__reveal;
          return {
            pts: r.track.points.length,
            km: r.track.distanceKm,
            hasRoute: !!m.getLayer('route-progress'),
            pickLayer: !!m.getLayer('pick-a'),
          };
        }""")
        page.screenshot(path=str(root / "e2e-shot-pick.png"))

        # --- collapsible panel: <details> native, collapse hides controls ---
        page.click("#panel summary")
        collapsed = page.locator("#panel:not([open])").count() == 1 and not page.is_visible("#controls")
        page.screenshot(path=str(root / "e2e-shot-collapsed.png"))
        page.click("#panel summary")
        expanded = page.is_visible("#controls")

        # --- loop toggle: click Loop → state.loop true + aria-pressed ---
        page.click("#loop")
        loop_on = page.evaluate("window.__reveal.state.loop === true && document.getElementById('loop').getAttribute('aria-pressed') === 'true'")
        # visual: active loop must look different from inactive (bg color changes)
        loop_bg_on = page.evaluate("getComputedStyle(document.getElementById('loop')).backgroundColor")
        page.click("#loop")
        loop_off = page.evaluate("window.__reveal.state.loop === false")
        loop_bg_off = page.evaluate("getComputedStyle(document.getElementById('loop')).backgroundColor")

        # --- loop ON then load a new route: fresh reveal (loop=false) must clear the button ---
        page.click("#loop")
        page.select_option("#preset", "wushan-yushan")
        page.wait_for_function(
            "window.__reveal && window.__reveal.track.name === 'Wushan → Yushan'", timeout=30000)
        loop_cleared = page.evaluate(
            "!window.__reveal.state.loop && document.getElementById('loop').getAttribute('aria-pressed') !== 'true'")

        # --- preset route: select Yongquan → Baiyun ---
        page.select_option("#preset", "yongquan-baiyun")
        page.wait_for_function(
            "window.__reveal && window.__reveal.track.name === 'Yongquan → Baiyun'", timeout=30000)
        preset_state = page.evaluate("""() => ({
          pts: window.__reveal.track.points.length,
          km: window.__reveal.track.distanceKm,
        })""")

        # --- fudao full trail: multi-waypoint preset must route through all stops ---
        page.select_option("#preset", "fudao-full")
        page.wait_for_function(
            "window.__reveal && window.__reveal.track.name === 'Fudao Full Trail'", timeout=30000)
        fudao_state = page.evaluate("""() => ({
          pts: window.__reveal.track.points.length,
          km: window.__reveal.track.distanceKm,
        })""")
        browser.close()

    print("playBtn:", paused)
    print("state:", json.dumps(state))
    print("pickHint1:", hint1, "| pickHint2:", hint2)
    print("pickState:", json.dumps(pick_state))
    print("panel collapsed:", collapsed, "| re-expanded:", expanded)
    print("loop on:", loop_on, "| loop off:", loop_off, "| loop cleared on reload:", loop_cleared)
    print("presetState:", json.dumps(preset_state, ensure_ascii=False),
          "fudaoFull:", json.dumps(fudao_state, ensure_ascii=False))
    print("errors:", errors if errors else "none")
    print("warnings:", warnings[:5] if warnings else "none")
    ok = (state["hasRouteProgress"] and state["hasRouteFull"] and state["routeCoords"] > 0
          and state["headSync"]
          and state["t"] and state["t"] > 0 and not errors
          and pick_state["pts"] > 2 and pick_state["km"] > 0 and pick_state["hasRoute"]
          and collapsed and expanded and loop_on and loop_off and loop_cleared
          and loop_bg_on != loop_bg_off and loop_bg_off == "rgba(0, 0, 0, 0)"
          and preset_state["pts"] > 2 and preset_state["km"] > 1
          and fudao_state["pts"] > 300 and fudao_state["km"] > 8)
    print("E2E PASS" if ok else "E2E FAIL")
    sys.exit(0 if ok else 1)
finally:
    server.terminate()
    try: server.wait(timeout=3)
    except subprocess.TimeoutExpired: server.kill()
