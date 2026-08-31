"""Reproduce camera occlusion: screenshot fudao-full at several t values."""
import subprocess, time, sys
from playwright.sync_api import sync_playwright

root = "/Users/user/gpx-route-reveal"
server = subprocess.Popen([sys.executable, "-m", "http.server", "4176", "--directory", f"{root}/dist"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 800})
        page.goto("http://localhost:4176/", wait_until="load", timeout=30000)
        page.wait_for_function("window.__map && window.__map.getLayer('satellite')", timeout=30000)
        page.select_option("#preset", "fudao-full")
        page.wait_for_function("window.__reveal && window.__reveal.track.name === 'Fudao Full Trail'", timeout=30000)
        page.evaluate("window.__reveal.setPlaying(false)")
        for t in (0.25, 0.45, 0.65, 0.85):
            page.evaluate(f"window.__reveal.setT({t})")
            page.wait_for_timeout(1200)  # let smoothing settle
            page.screenshot(path=f"{root}/occl-{int(t*100)}.png")
        b.close()
finally:
    server.terminate(); server.wait(timeout=3)
print("shots done")
