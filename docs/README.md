# Documentation

Full documentation for the **Washington Trails** PWA. Start with whichever matches your task.

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Canonical, code-grounded design reference — every subsystem (routing, list, detail, map, GPX/geometry, elevation, GPS, bottom sheet, tile download), the data model, state, responsive design, and caching layers. With diagrams and `file:line` references. |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Developer guide — running locally, the service-worker dev gotcha, code conventions, the add-a-trail workflow, manual + offline testing, deployment, and GitHub Pages constraints. |
| [IOS-PWA-GUIDE.md](IOS-PWA-GUIDE.md) | iOS Safari PWA constraints (2025/2026) and how the app designs around them — service workers, Cache API, geolocation, Wake Lock, install, the 7-day eviction rule, manifest specifics, and the three-tier offline strategy. Honest about gaps. |
| [DATA-PIPELINE.md](DATA-PIPELINE.md) | How trail data, GPX, and hero images were extracted from saved AllTrails pages — JSON-LD scraping, the elevation-gain calibration insight, webarchive image extraction, base64 URL upscaling, and a reproducible new-trail checklist with runnable scripts. |
| [DECISIONS-AND-LESSONS.md](DECISIONS-AND-LESSONS.md) | Architecture Decision Records (with rejected alternatives) and the concrete bugs/lessons from building and testing — symptom → root cause → fix. |

See also [`../CLAUDE.md`](../CLAUDE.md) for a quick orientation and the golden rules.
