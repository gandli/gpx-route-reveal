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

        page.click("#play")
        page.wait_for_timeout(3000)
        paused = page.locator("#play").text_content()

        state = page.evaluate("""() => {
          const r = window.__reveal;
          const m = window.__map;
          return {
            hasRouteProgress: !!m.getLayer('route-progress'),
            hasRouteFull: !!m.getLayer('route-full'),
            routeCoords: (m.querySourceFeatures('route-progress')[0]?.geometry?.coordinates?.length) || 0,
            t: r ? r.state.t : null,
            zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(),
          };
        }""")
        page.screenshot(path=str(root / "e2e-shot.png"))
        browser.close()

    print("playBtn:", paused)
    print("state:", json.dumps(state))
    print("errors:", errors if errors else "none")
    print("warnings:", warnings[:5] if warnings else "none")
    ok = (state["hasRouteProgress"] and state["hasRouteFull"] and state["routeCoords"] > 0
          and state["t"] and state["t"] > 0 and not errors)
    print("E2E PASS" if ok else "E2E FAIL")
    sys.exit(0 if ok else 1)
finally:
    server.terminate()
    try: server.wait(timeout=3)
    except subprocess.TimeoutExpired: server.kill()
