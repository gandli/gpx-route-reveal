# AGENTS.md — deployment guide for AI agents

Deterministic facts + commands. Every command below has been run and verified.

## Project shape

- Static SPA: Vite 6 + TypeScript strict + maplibre-gl 4. No server, no DB, no API keys, no env vars, no secrets.
- Runtime data comes from public key-free tile/route services (Esri World Imagery, AWS terrarium DEM, OpenFreeMap vectors, BRouter). Nothing is uploaded.
- `vite.config.ts` sets `base: "./"` — build output is subpath-safe (required for Pages under `/gpx-route-reveal/`). Do not change it.

## Local run

```bash
npm ci
npm run dev        # http://localhost:5173, demo.gpx auto-loads
npm run build      # vite bundle only (NO type check) → dist/
npx tsc --noEmit   # type check — run separately, CI does not gate on it
```

LAN preview (phone testing): `npm run dev -- --host` → open `http://<lan-ip>:5173`.

## Deploy — do not deploy manually

Deployment is automatic: **push to `main` → GitHub Actions `deploy.yml` → GitHub Pages**.

- Live URL: https://gandli.github.io/gpx-route-reveal/
- Workflow: `npm ci` → `npm run build` → upload `dist/` → `actions/deploy-pages`. Concurrency group `pages` cancels stale runs.
- There is no other deploy target. Do not add Vercel/Netlify/Workers config.

## Hard workflow rule (repo owner mandate)

Never push to `main` directly. Always: feature branch → PR → wait for bots (GitGuardian + Sourcery; Sourcery skips under 10★, that's fine; the only workflow is `deploy.yml`, which runs on push to main — there is no separate CI job) → squash merge + delete branch.

## Verify a deploy actually landed

```bash
git fetch -q && git log origin/main --oneline -1          # merge landed on main
gh run list --workflow=deploy.yml --limit 1 \
  --json status,conclusion,headSha --jq '.[0]'            # conclusion=success, headSha=merge sha
curl -s -o /dev/null -w "%{http_code}\n" \
  https://gandli.github.io/gpx-route-reveal/              # 200
curl -s https://gandli.github.io/gpx-route-reveal/ | grep -o 'assets/index-[^"]*\.js'
# compare with local: ls dist/assets/  — hashed filename must match, else CDN lag, re-check in ~30s
```

Pitfall: `gh run list` may show an older run — filter by `headSha` matching the merge commit.

## Known pitfalls

- **Pages enablement**: `actions/configure-pages` with `enablement: true` fails on the *first ever* run if the Pages site doesn't exist (`Resource not accessible by integration`, GITHUB_TOKEN lacks admin). One-time fix: `gh api -X POST repos/gandli/gpx-route-reveal/pages -f build_type=workflow`, then rerun the failed workflow.
- **E2E**: `python scripts/e2e.py` (Playwright, needs a local `npm run build` first — it serves `dist/`). Asserts route layers, pick-route, presets, panel collapse, loop state, head/line sync. Run it before opening a PR that touches `src/`.
- **Demo media** (MP4/GIF for README) lives in the GitHub Release `demo-media`, not in the repo. Don't commit large binaries.

## Where things are

- `src/main.ts` — map style, DOM wiring, preset routes table (`PRESETS`)
- `src/animate.ts` — `RouteReveal`: growth animation + camera follow
- `src/route.ts` — `fetchBrouterRoute` (shared by map picker and presets)
- `src/recorder.ts` — WebM export via `MediaRecorder`
- `.github/workflows/deploy.yml` — the only deploy path
