# Ume-chan's Trails — Data Pipeline

How the source data for the ten bundled trails was extracted from saved
AllTrails web pages and turned into the app's runtime assets
(`trails.js`, `gpx/*.gpx`, `images/*.webp`). This document exists so the
process is **reproducible** when adding a new trail.

> The original eight Washington trails were extracted from saved `.html`
> pages; the Japan trails came from `.webarchive`-only saves and a
> cleaner embedded-stats source (`trailGeoStats`). The differences are flagged
> in §1, §2b/§2d, and §6 — read those before adding a non-US trail.
>
> **Update (2026-06):** the app now ships **10 trails (8 Washington + 2
> Japan)**. Three Japan trails that were extracted earlier — Mt. Fuji: Gotemba
> Trail, Mount Daibosatsu Loop, and Mount Kinpu (Kanayama) — were removed from
> the app; their `trails.js` entries, GPX, and hero images are gone, though
> their saved AllTrails source pages remain in `alltrails/` as history. The
> remaining Japan trails are Mt. Fuji: Yoshida Trail and Mount Kinpu (Odarumi
> Pass). The narrative below still discusses the removed routes where they
> illustrate the process (e.g. the four-Fuji-route cross-link gotcha) — those
> passages are historical and flagged.

> TL;DR for the impatient: skip to
> [Reproducing the pipeline for a new trail](#6-reproducing-the-pipeline-for-a-new-trail).

---

## 0. Where things live

| Path | Status | What it is |
| --- | --- | --- |
| `alltrails/` | **partly committed** | Raw source: saved AllTrails `.html` page exports and `.gpx` downloads **are committed** (~8 MB). The `.webarchive` Safari archives are kept locally but **git-ignored** — they embed third-party secret tokens (a Mapbox access token) that GitHub push protection blocks. Not deployed by the app either way. |
| `trails.js` | committed | The final trail metadata array (`window.TRAILS`). The product of the metadata stages below. |
| `gpx/*.gpx` | committed | One GPX track per trail. Loaded and parsed **at runtime** by `app.js` (not pre-baked into JSON). |
| `images/*.webp` | committed | One hero photo per trail, `1200×800` WebP. |
| `sw.js` | committed | Service worker. Lists every GPX + image in `TRAIL_ASSETS` so they are cached on install for full offline use. |
| `app.js` | committed | Runtime: GPX parse, haversine distance, elevation smoothing, map + elevation profile. |

The app is a static PWA showing **8 Washington State trails + 2 Japan trails**:

**Washington (USGS topo basemap):**
Lake 22, Snow Lake, Lake Valhalla, Talapus Lake, Mount Pilchuck,
Bridal Veil Falls & Lake Serene, Skyline Loop, The Enchantments Traverse.

**Japan (GSI 地理院タイル basemap — each carries `tiles:"gsi"` in `trails.js`):**
Mt. Fuji: Yoshida Trail (5th Station Ascent), Mount Kinpu (Odarumi Pass).

> **Update (2026-06):** the Japan list was trimmed from four to two. Mt. Fuji:
> Gotemba Trail, Mount Daibosatsu Loop, and Mount Kinpu (Kanayama) were removed.
> Mount Kinpu (Odarumi Pass) is a **different** route from the removed Kinpu
> (Kanayama) and is still present. Note also that the `alltrails/` `.html`/`.gpx`
> source is now committed (the `.webarchive` archives stay git-ignored — see the
> §0 table and `.gitignore`).

---

## 1. Source material

Each AllTrails trail page was captured from the browser in **two** formats,
plus the trail's GPX download:

1. **`.html`** — the rendered page saved as a single HTML file. This is a
   Next.js app-router bundle, roughly **650–790 KB** each. It contains the
   structured data we extract (JSON-LD blocks plus an embedded React Server
   Components / Next data payload).
2. **`.webarchive`** — Safari's binary archive format. Unlike a plain HTML
   save, a webarchive **bundles the page _and_ all of its subresources**
   (scripts, CSS, fonts, **and images**) into a single Apple binary
   property-list (plist) file. Each is ~20 MB. This is what let us recover
   the hero images without hitting the network (see
   [§4](#4-extracting-hero-images-from-the-webarchive)).
3. **`.gpx`** — the track export, downloaded from the trail page's "Download
   route" option. Creator is `AllTrails.com`, GPX 1.1.

Naming in `alltrails/` is verbatim from the browser, e.g.:

```
Lake 22 Trail, Washington - 18,454 Reviews, Map | AllTrails.html
Lake 22 Trail, Washington - 18,454 Reviews, Map | AllTrails.webarchive
Lake_22_Trail.gpx
```

> ### Japan trails: `.webarchive`-only (recover HTML from `WebMainResource`)
> The Japan trails were saved as **`.webarchive` only — there is no
> `.html` file** for them. That is fine: the rendered page HTML is also
> inside the webarchive, under the top-level plist key
> **`WebMainResource` → `WebResourceData`** (the raw bytes of the main
> document). Decode those bytes to text and you have the same Next.js
> app-router HTML the `.html` saves contain, so **every HTML-based extractor
> below (§2a/§2b/§2d) works unchanged** once you've recovered it. (Contrast
> with §4, which reads `WebSubresources` from the *same* archive to get the
> embedded images; here it's `WebMainResource` for the document itself.)
>
> **Update (2026-06):** only two Japan trails ship now (Yoshida, Kinpu /
> Odarumi Pass). The Japan `.gpx` files are committed, but their `.webarchive`
> saves (and those of the three removed routes) are kept locally and **git-ignored**
> — webarchives embed third-party secret tokens that GitHub push protection blocks.
> The recovery technique is unchanged.
>
> ```python
> import plistlib
>
> def html_from_webarchive(webarchive_path):
>     """Recover the page's main HTML document out of a Safari .webarchive."""
>     with open(webarchive_path, "rb") as f:
>         archive = plistlib.load(f)
>     data = archive["WebMainResource"]["WebResourceData"]   # raw bytes
>     return data.decode("utf-8", errors="replace")
> ```
>
> Parse the returned string exactly like an `.html` file (the §2 helpers all
> take a path; either write the recovered HTML to a temp file or refactor them
> to accept a string). The §4 hero-image notes below also apply: the Japan
> webarchives embedded only tiny thumbnails, so heroes were re-fetched at
> `1200×800` with the same base64-config rewrite trick.

---

## 2. Extracting trail metadata from the HTML

There are **two** complementary sources of metadata inside each `.html`
file. Use both.

### 2a. JSON-LD (`<script type="application/ld+json">`)

The page embeds several JSON-LD blocks (verified: 8 blocks in the Lake 22
page). The one with `@type: "LocalBusiness"` is the primary trail record and
yields the human-facing fields:

| JSON-LD field | Maps to | Notes |
| --- | --- | --- |
| `name` | `name` | e.g. `"Lake 22 Trail"` |
| `description` | seed for `summary` / `description` | Marketing blurb; hand-edited (see §2c). |
| `geo.latitude`, `geo.longitude` | `center` | Strings; cast to number. Used as the map's fallback center. |
| `aggregateRating.ratingValue` | `rating` | e.g. `4.7`. **Update (2026-06): no longer used** — the `rating` field was removed from every `trails.js` object and the UI no longer shows star ratings. The value is still present in the source page; it just isn't carried into the app. |
| `aggregateRating.reviewCount` | `reviews` | e.g. `18454` (matched `trails.js` at the time). **Update (2026-06): no longer used** — the `reviews` field was removed from every `trails.js` object. (The saved-page filenames still read e.g. "18,454 Reviews" — that is legitimate source-data history.) |
| `image[0]` | hero image URL | An `images.alltrails.com` URL — see §4 for how it is decoded/upscaled. |
| `address.addressLocality` | seed for `area` | e.g. `"Granite Falls, Washington, United States"` → trimmed to `"Granite Falls, WA"`. |

Representative extractor:

```python
import json, re

def parse_jsonld_localbusiness(html_path):
    html = open(html_path, encoding="utf-8", errors="replace").read()
    blocks = re.findall(
        r'<script type="application/ld\+json"[^>]*>(.*?)</script>',
        html, re.S,
    )
    for block in blocks:
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        for item in (data if isinstance(data, list) else [data]):
            if item.get("@type") == "LocalBusiness":
                geo = item.get("geo", {})
                agg = item.get("aggregateRating", {})
                img = item.get("image")
                return {
                    "name":    item.get("name"),
                    "lat":     float(geo["latitude"]),
                    "lon":     float(geo["longitude"]),
                    "rating":  agg.get("ratingValue"),
                    "reviews": agg.get("reviewCount"),
                    "locality": (item.get("address") or {}).get("addressLocality"),
                    "image_url": img[0] if isinstance(img, list) else img,
                    "description": item.get("description"),
                }
    return None
```

### 2b. Authoritative numeric stats (in the Next data payload)

The JSON-LD does **not** carry the headline numeric stats. Those live deeper
in the page, inside the Next.js / RSC streamed payload as **backslash-escaped
JSON**. The relevant keys, all **in metric**, are:

| Embedded key | Unit | Convert to | Formula |
| --- | --- | --- | --- |
| `length` | meters | miles | `m / 1609.344` |
| `elevation_gain` | meters | feet | `m * 3.28084` |
| `route_type` | code | route string | `O` → `Out & back`, `L` → `Loop`, `P` → `Point to point` |
| `difficulty_rating` | integer | difficulty label | mapped to `Easy / Moderate / Hard / Very Hard` |

They appear in the raw HTML like this (note the escaped quotes):

```
...length\":9816.974... elevation_gain\":...  route_type\":\"O\"...
```

`9816.974 m ÷ 1609.344 = 6.1 mi`, which matches the published Lake 22 length
exactly. `app.js` uses the same factors at runtime — `FT = 3.28084` as a named
constant for elevation, and `MI_PER_KM = 1.609344` as a named constant
(`mi → km`) for distance display.

> ### ⚠️ Gotcha: the page embeds *many* trails, not just the one
> An AllTrails page also embeds the stats for **nearby / recommended
> trails** (the Lake 22 page contains ~24 separate trail stat objects).
> A naïve "grab the first `elevation_gain`" regex will pull the **wrong**
> trail. For example, the Lake 22 page contains an object reading
> `length 8690 m (5.4 mi) / elevation_gain 652.9 m (2142 ft) / route O`
> — that is **Mount Pilchuck's** stats appearing as a related trail.
>
> When extracting, anchor on the **primary trail object** — the one whose
> `length` matches the page's headline distance and whose name equals the
> page title — and read *its* sibling `elevation_gain` / `route_type`.
> Always sanity-check the converted numbers against the figures rendered on
> the page before committing them. The final values that shipped (table
> below) were verified this way.
>
> This is **especially** dangerous on the Mt. Fuji pages: each Fuji page
> cross-links **every Fuji route** plus many nearby trails, so a naïve
> `length` / `elevation_gain` regex easily matches the wrong route. For the
> Japan trails we sidestepped the problem entirely by reading the headline
> stats from the page's own `trailGeoStats` block instead — see §2d.
> (**Update (2026-06):** only the Yoshida Fuji route still ships, but the same
> cross-link hazard applies to its page — and to any new Fuji route you add.)

Representative extractor (returns *all* embedded stat objects so you can pick
the primary one):

```python
import re

M_PER_MI, FT_PER_M = 1609.344, 3.28084
ROUTE = {"O": "Out & back", "L": "Loop", "P": "Point to point"}

def extract_stat_objects(html_path):
    """Yield (length_mi, gain_ft, route) for every trail stat object on the page.
    The page embeds the primary trail AND nearby/recommended trails, so the
    caller must pick the object whose length matches the headline distance."""
    html = open(html_path, encoding="utf-8", errors="replace").read()
    for m in re.finditer(r'\\?"length\\?":\s*([0-9.]+)', html):
        length_m = float(m.group(1))
        window = html[m.start() - 120 : m.end() + 400]   # same JSON object
        eg = re.search(r'\\?"elevation_gain\\?":\s*([0-9.]+)', window)
        rt = re.search(r'\\?"route_type\\?":\s*\\?"([A-Z])', window)
        yield {
            "miles":  round(length_m / M_PER_MI, 1),
            "gain_ft": round(float(eg.group(1)) * FT_PER_M) if eg else None,
            "route":  ROUTE.get(rt.group(1)) if rt else None,
        }
```

### 2d. Authoritative headline stats from `trailGeoStats` (used for the Japan trails)

The §2b extractor walks every embedded trail-stat object and asks you to pick
the primary one by matching the headline length. That works for the Washington
pages, but on the **Fuji pages it is too error-prone** (those pages cross-link
every Fuji route plus many nearby trails — see the gotcha above). For the
Japan trails we read the headline stats from a single, unambiguous block
the page embeds for **the trail you're actually looking at**: **`trailGeoStats`**.

It is plain (not backslash-escaped) JSON, all **in metric**, and maps cleanly:

| `trailGeoStats` key | Unit | Maps to | Notes |
| --- | --- | --- | --- |
| `length` | meters | `lengthMi` | `m / 1609.344` |
| `elevationStart` | meters | (reference) | trailhead elevation |
| `elevationGain` | meters | `gainFt` | DEM-based — **use this**, same philosophy as §3 (`m * 3.28084`) |
| `elevationMax` | meters | (reference) | summit / high point |
| `durationMinutes` | minutes | `time` | raw figure |
| `durationFormatted` | string | `time` | e.g. `"3 h 46 min"` — copied straight into `trails.js` |

`difficulty_rating` and `route_type` are **still** read the §2b way:
`difficulty_rating` `5 → Hard` (the Yoshida route is Hard); `route_type`
`O → Out & back`, `L → Loop`, `P → Point to point` unchanged.

JSON-LD (§2a) still supplies `name`, `address.addressLocality` (→ `area`) and
the hero `image[0]` URL exactly as for the Washington trails. (It also carried
`aggregateRating` `ratingValue`+`reviewCount`, but **the `rating`/`reviews`
fields were removed from `trails.js` and the UI — see §2a — so those are no
longer extracted into the app.**)

Verified `trailGeoStats` values that shipped at extraction time (the bottom two
rows are the **removed** Gotemba/Daibosatsu/Kinpu-Kanayama routes, kept here as
a record of the technique):

| slug | `length` | = miles | `elevationGain` | = gain (ft) | `elevationMax` | `durationMinutes` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `fuji-yoshida` | 6,759 m | 4.2 | 1,433 m | 4,701 | 3,704 m | 226 |
| `fuji-gotemba` *(removed)* | 20,117 m | 12.5 | 2,370 m | 7,775 | 3,751 m | 710 |
| `daibosatsu` *(removed)* | 8,690 m | 5.4 | 614 m | 2,014 | 2,045 m | 221 |
| `kinpu` *(Kanayama, removed)* | 15,772 m | 9.8 | 1,312 m | 4,304 | 2,594 m | 442 |

> **Update (2026-06):** the three rows marked *(removed)* are no longer in the
> app — they are kept only to document the `trailGeoStats` extraction. The
> shipping Mount Kinpu (Odarumi Pass) route (`kinpu-odarumi`) is a separate,
> shorter trail (5.2 mi / 1,673 ft, Moderate, Out & back — see the final-stats
> table) and was **not** sourced from a `trailGeoStats`/AllTrails page the same
> way; its stats live in `trails.js`. The Odarumi Pass route's GPX is saved in
> `alltrails/` as `大弛峠__金峰山.gpx` (大弛峠 = Odarumi Pass); there is no
> separate English-named page capture for it.

> The Yoshida GPX is a **one-way ascent** (5th Station → crater rim), and the
> Yoshida page's `trailGeoStats` is **also** the one-way ascent (4.2 mi /
> 4,701 ft) — they agree, which is why the route is `Point to point`.
> **Update (2026-06):** the Yoshida GPX was **replaced** with a new track
> (now **2,438** track points, **0** waypoints — see §5); its route is still
> the one-way ascent and the shipped 4.2 mi / 4,701 ft stats are unchanged.
> Historically the Gotemba (round-trip out & back), Daibosatsu (loop), and
> Kinpu/Kanayama (out & back) GPX lengths likewise matched their official
> `trailGeoStats` lengths — but those three routes have since been removed.

### 2c. Hand-curated prose

The `summary`, `description`, and `tips[]` fields in `trails.js` were
**hand-written / edited** from the page's description text, official-trail
notes, and top reviews. They are intentionally tighter and more useful than
the raw AllTrails marketing blurb. Treat these as editorial, not mechanical
extraction. (The map/photo attribution lines in `app.js` credit AllTrails for
trail info and photos, and the per-trail basemap — USGS for US trails, GSI
地理院タイル for Japan — via `trailSource(trail).creditKey`.)

> ### The "[CLOSED]" wrinkle (the Mt. Fuji pages)
> The Fuji pages are flagged **`[CLOSED]`** on AllTrails — Fuji climbs only
> run roughly **July–September**, and the Yoshida route added a **2024+
> advance reservation + ¥2,000 entry fee + daily cap (~4,000)**. Decision: we
> **include** the Fuji trail(s), **drop the literal "[CLOSED]"** from the
> display `name`, and fold the seasonal-closure + reservation/fee facts into
> the hand-curated `permit`, `summary`, and `tips[]` instead. (The committed
> Yoshida GPX still carries `[CLOSED]` in its internal `<name>`; only the
> displayed `trails.js` `name` is cleaned up.) Difficulty is kept at AllTrails'
> value.
>
> **Update (2026-06):** historically this applied to **both** Fuji routes, and
> Gotemba (7,775 ft) was then the single biggest climb in the app. With Gotemba
> removed, only the Yoshida route remains, and the **biggest climb in the
> current app is The Enchantments Traverse (4,845 ft)**, followed by Yoshida
> (4,701 ft).

### Final shipped stats (reference)

| slug | name | miles | gain (ft) | difficulty | route |
| --- | --- | ---: | ---: | --- | --- |
| `lake-22` | Lake 22 Trail | 6.1 | 1,456 | Moderate | Out & back |
| `snow-lake` | Snow Lake Trail | 6.7 | 1,686 | Moderate | Out & back |
| `lake-valhalla` | Lake Valhalla Trail | 6.4 | 1,371 | Moderate | Out & back |
| `talapus-lake` | Talapus Lake Trail | 3.5 | 656 | Moderate | Out & back |
| `mount-pilchuck` | Mount Pilchuck Trail | 5.4 | 2,142 | Hard | Out & back |
| `bridal-veil` | Bridal Veil Falls & Lake Serene | 8.0 | 2,716 | Hard | Out & back |
| `skyline-loop` | Skyline Loop | 5.7 | 1,781 | Hard | Loop |
| `enchantments` | The Enchantments Traverse | 19.1 | 4,845 | Very Hard | Point to point |
| `fuji-yoshida` | Mt. Fuji: Yoshida Trail (5th Station Ascent) | 4.2 | 4,701 | Hard | Point to point |
| `kinpu-odarumi` | Mount Kinpu (Odarumi Pass) | 5.2 | 1,673 | Moderate | Out & back |

The two Japan trails carry `tiles:"gsi"`. Their `durationFormatted`-derived
`time` values are **3 h 46 min** (Yoshida) and **3 h 15 min** (Kinpu / Odarumi
Pass). **Update (2026-06):** the `rating`/`reviews` columns that used to follow
this table were dropped — those fields no longer exist in `trails.js` and star
ratings were removed from the UI (the list-card slot the star occupied now
shows the hike `time` ⏱). Three Japan trails — `fuji-gotemba` (12.5 mi /
7,775 ft), `daibosatsu` (5.4 mi / 2,014 ft), and `kinpu`/Kanayama (9.8 mi /
4,304 ft) — were removed from this table; their figures survive in the §2d
historical `trailGeoStats` table above.

---

## 3. The elevation-gain calibration insight (read this before "fixing" the stat)

**Do not compute the displayed elevation-gain stat from the raw GPX.** It
will be badly wrong.

Summing the positive deltas of the raw GPX `<ele>` values massively
**over-counts** total gain, because consumer/phone GPS elevation is noisy:
every little up-and-down jitter gets added in. Measured on Lake 22:

- Raw GPX positive-delta sum ≈ **+2,302 ft**
- AllTrails' official (DEM-based) gain ≈ **+1,456 ft**
- → about **58 % inflation** from noise alone.

Smoothing the elevation series with a moving-average window before summing
pulls it back toward the DEM truth. Wider window = more smoothing = lower
(more realistic) gain:

| Trail | raw | window 11 | window 21 | window 31 | official (DEM) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lake 22 | 2,302 | 1,697 | 1,480 | 1,419 | **1,456** |
| Enchantments | 8,080 | 5,777 | 5,181 | 4,912 | **4,845** |

### Decision

- **Displayed stat (`gainFt` in `trails.js`)** → use **AllTrails' official,
  DEM-based published value**. It is authoritative and stable; the GPX track
  is just one noisy recording.
- **Elevation-profile _curve_** → drawn from a **smoothed GPX series**, for
  shape only. At runtime, `app.js` `smoothEle()` applies a moving-average
  window of **15** and stores the result on each point as `p.se`. The profile
  SVG (`drawProfile()`) plots `p.se`; the profile's min–max ft label is also
  derived from the smoothed series.

So the number you read and the squiggle you see come from **two different
sources on purpose.** If someone "corrects" `gainFt` to a raw-GPX sum, the
numbers will inflate by ~50–60 %. Don't.

The same rule covers the Japan trails: the Yoshida `gainFt` comes from the
DEM-based `trailGeoStats.elevationGain` (§2d), **not** the raw GPX. (Mount Kinpu
/ Odarumi Pass's `gainFt` is likewise an authoritative DEM-style figure stored
in `trails.js`, not a raw-GPX sum.)

> Note: the moving-average window in `app.js` (15) is for *display shape*. The
> w11/w21/w31 figures above were from an offline calibration experiment used
> only to confirm that smoothing converges toward the DEM value and to justify
> trusting the official stat — they are not used to produce the shipped number.

---

## 4. Extracting hero images (from the webarchive)

### Why not just download the CDN URL?

Directly fetching the `images.alltrails.com` URLs failed in the build
environment — the image CDN returned **HTTP 403** through the proxy. So the
first round of heroes was recovered **with no network at all**, straight out
of the Safari `.webarchive`.

### The webarchive is a plist full of raw bytes

A `.webarchive` is an Apple binary property list. Its top-level keys are
`WebMainResource`, `WebSubframeArchives`, and **`WebSubresources`**.
`WebSubresources` is a list where each entry has:

- `WebResourceURL` — the original URL of the subresource
- `WebResourceMIMEType` — e.g. `image/webp`
- `WebResourceData` — the **raw bytes** of that resource

(The sibling `WebMainResource` key holds the page's own HTML document — that's
what §1 decodes for the Japan trails, which have no separate `.html` save.)

Python's standard-library `plistlib` reads this directly. The Lake 22
webarchive has 81 subresources; filtering by MIME type / host finds the
embedded trail photos:

```python
import plistlib

def extract_webarchive_images(webarchive_path, out_path):
    """Pull the hero photo bytes straight out of a Safari .webarchive — no network."""
    with open(webarchive_path, "rb") as f:
        archive = plistlib.load(f)

    candidates = []
    for res in archive.get("WebSubresources", []):
        mime = res.get("WebResourceMIMEType", "")
        url  = res.get("WebResourceURL", "")
        data = res.get("WebResourceData", b"")
        # the AllTrails hero is an images.alltrails.com photo (served as webp)
        if mime.startswith("image/") and "alltrails.com" in url and "photo" in url:
            candidates.append((len(data), data, url))

    if not candidates:
        raise SystemExit("no embedded trail photo found")

    # the hero is the largest embedded photo
    _, data, url = max(candidates, key=lambda c: c[0])
    with open(out_path, "wb") as f:
        f.write(data)
    return url
```

This initial pass yielded small heroes — about **44–79 KB**, `750×341` WebP
(that is the size the page actually rendered/saved).

### Upscaling: rewrite the AllTrails image URL config

The AllTrails image URLs are self-describing. The path segment after
`images.alltrails.com/` is a **base64-encoded JSON config** consumed by their
image service. Decoding one gives:

```json
{
  "bucket": "assets.alltrails.com",
  "key": "uploads/photo/image/65097905/d76fe5be0aa8f6f15d5091ee32accc45.jpg",
  "edits": {
    "toFormat": "webp",
    "resize": { "width": "3520", "height": "1600", "fit": "cover" },
    "rotate": null,
    "jpeg": { "...": "..." }
  }
}
```

> Wrapper detail: in the saved markup the real image URL is wrapped in a
> Next image proxy, e.g.
> `https://www.alltrails.com/mugen/image/trail-app-router?url=<percent-encoded images.alltrails.com URL>&w=750&q=75`.
> Unwrap the `url=` query param first (URL-decode it), **then** the inner path
> segment is the base64 config. The JSON-LD `image[0]` value is sometimes the
> bare `images.alltrails.com` URL directly.

Once the images domain was allow-listed, crisp heroes were fetched by
**editing that config**: decode it, set `edits.resize` to
`width=1200, height=800, fit=cover`, re-encode to base64, rebuild the URL,
and download. Result: **`1200×800` WebP, ~190–310 KB each** (~2 MB total),
saved as `images/<slug>.webp` (all eight verified at `1200×800`).

> **The four Japan heroes used this same path** — and *had* to. Their
> `.webarchive` saves embedded only **tiny thumbnails** (a few KB each), too
> small to use as a hero, so there was nothing worth pulling from
> `WebSubresources`. Instead the JSON-LD `image[0]` URL (§2a) was rewritten to
> `1200×800 cover, webp` with `upscale_alltrails_url()` below and re-fetched.
> Result: `images/{fuji-yoshida,fuji-gotemba,daibosatsu,kinpu}.webp`, all
> `1200×800`, **~140–313 KB** each.
>
> **Update (2026-06):** of those four, only `fuji-yoshida` still ships;
> `fuji-gotemba`, `daibosatsu`, and `kinpu` were removed and their `.webp` heroes
> deleted. The current second Japan trail, `kinpu-odarumi`, was added later via
> the same pipeline.

```python
import base64, json, urllib.parse, urllib.request

def upscale_alltrails_url(image_url, width=1200, height=800):
    """Rewrite an AllTrails image URL to request a higher-res WebP hero."""
    # 1. unwrap the mugen/next image proxy if present
    parsed = urllib.parse.urlparse(image_url)
    qs = urllib.parse.parse_qs(parsed.query)
    if "url" in qs:
        image_url = qs["url"][0]

    # 2. split off the base64 config segment
    base, seg = image_url.split("images.alltrails.com/", 1)
    seg = seg.split("?", 1)[0].split("/", 1)[0]

    # 3. decode -> edit -> re-encode
    pad = "=" * (-len(seg) % 4)
    cfg = json.loads(base64.urlsafe_b64decode(seg + pad))
    cfg["edits"]["resize"] = {"width": str(width), "height": str(height), "fit": "cover"}
    cfg["edits"]["toFormat"] = "webp"
    new_seg = base64.urlsafe_b64encode(
        json.dumps(cfg, separators=(",", ":")).encode()
    ).decode().rstrip("=")

    return f"https://images.alltrails.com/{new_seg}"

def fetch_hero(image_url, out_path, width=1200, height=800):
    url = upscale_alltrails_url(image_url, width, height)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(out_path, "wb") as f:
        f.write(r.read())
    return out_path
```

> **Gallery note:** each saved page embedded only **one** usable photo (the
> hero). There was no real photo gallery to harvest — the other embedded
> images are UI chrome, avatars, and map sprites. One hero per trail is all
> the source gives you.

---

## 5. GPX handling

### Runtime, not build-time

GPX files are **not** pre-processed into JSON. Each trail's `.gpx` is
committed under `gpx/` and parsed live in the browser by `app.js`
`loadTrail()`:

- A `DOMParser` reads the XML.
- **Track points:** every `<trkpt lat lon>` with a child `<ele>`. Cumulative
  distance `d` is accumulated point-to-point with the haversine helper `hav()`
  (Earth radius 6 371 000 m). Each point is stored as `{lat, lon, ele, d}`.
- **Waypoints:** every `<wpt lat lon>` with a child `<name>`. Each waypoint is
  then "snapped" to the nearest track point so it can be placed on the
  elevation profile (its along-track distance `d`).
- **Elevation smoothing:** `smoothEle()` runs (window 15) to populate `p.se`
  for the profile curve (see §3).
- **Bounds / framing:** the GPX `<metadata><bounds>` element is present in all
  ten files. At runtime the map actually frames the track via
  `map.fitBounds(trackLayer.getBounds())` (computed from the drawn polyline);
  the offline-tile bounding box (`gpxBox()` in `app.js`) is computed from the
  track points when available, falling back to `trail.center ± 0.02°`.

### Waypoints are sparse

Only some trails carry embedded `<wpt>` waypoints; most have none. Verified
counts in the committed GPX:

| GPX file | `<trkpt>` | `<wpt>` |
| --- | ---: | ---: |
| `Lake_22_Trail.gpx` | 1,558 | **5** |
| `Snow_Lake_Trail.gpx` | 828 | **4** |
| `Lake_Valhalla_Trail.gpx` | 1,541 | 0 |
| `Talapus_Lake_Trail.gpx` | 771 | 0 |
| `Mount_Pilchuck_Trail.gpx` | 1,221 | 0 |
| `Bridal_Veil_..._Lake_Serene_Trail.gpx` | 1,823 | 0 |
| `Skyline_Loop.gpx` | 1,258 | 0 |
| `The_Enchantments_Traverse.gpx` | 7,153 | 0 |
| `Mt_Fuji_Yoshida.gpx` | 2,438 | 0 |
| `Mount_Kinpu_Odarumi.gpx` | 1,507 | 0 |

(Both Japan GPX have **0** waypoints, so they show only trailhead/end
endpoint markers — no amber waypoint dots or dashed profile lines.)

(Lake 22's five waypoints are e.g. *Bridge*, *Waterfall*, *Vista* — they
render as amber dots on the map and dashed lines on the elevation profile.)

### Verifying a GPX (helper)

Use this to sanity-check a new GPX's stats against the AllTrails page before
committing it — distance via haversine, elevation min/max, declared bounds,
and waypoint count. It mirrors the runtime parse in `app.js`.

```python
import math
import xml.etree.ElementTree as ET

NS = {"g": "http://www.topografix.com/GPX/1/1"}
M_PER_MI, FT_PER_M = 1609.344, 3.28084

def haversine(la1, lo1, la2, lo2):
    R, d = 6371000.0, math.pi / 180
    p1, p2 = la1 * d, la2 * d
    dp, dl = (la2 - la1) * d, (lo2 - lo1) * d
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def verify_gpx(path):
    root = ET.parse(path).getroot()
    pts = [(float(t.get("lat")), float(t.get("lon")),
            float(t.findtext("g:ele", default="0", namespaces=NS)))
           for t in root.iterfind(".//g:trkpt", NS)]

    dist = sum(haversine(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1])
               for i in range(1, len(pts)))
    eles = [p[2] for p in pts]

    # raw GPX gain (expected to OVER-count vs AllTrails — see section 3)
    raw_gain_m = sum(max(0.0, eles[i] - eles[i-1]) for i in range(1, len(eles)))

    b = root.find(".//g:bounds", NS)
    bounds = {k: float(b.get(k)) for k in
              ("minlat", "minlon", "maxlat", "maxlon")} if b is not None else None

    return {
        "trkpts":      len(pts),
        "waypoints":   len(root.findall(".//g:wpt", NS)),
        "length_mi":   round(dist / M_PER_MI, 2),
        "ele_min_ft":  round(min(eles) * FT_PER_M),
        "ele_max_ft":  round(max(eles) * FT_PER_M),
        "raw_gain_ft": round(raw_gain_m * FT_PER_M),  # do NOT ship this number
        "bounds":      bounds,
    }

if __name__ == "__main__":
    import sys, json
    print(json.dumps(verify_gpx(sys.argv[1]), indent=2))
```

GPX-derived **length** should match the AllTrails figure closely and is fine
to trust. GPX-derived **gain** is the inflated raw number from §3 — use it
only to confirm the official stat is in a sane ballpark, never as the shipped
value.

---

## 6. Reproducing the pipeline for a new trail

Ordered checklist to add one trail end-to-end:

1. **Save the source.** From the AllTrails trail page, save the
   `.webarchive` (Safari → File → Save As → *Web Archive*) — and ideally the
   `.html` too — and download the route `.gpx`. Drop them in `alltrails/`
   (the `.html`/`.gpx` are committed; `.webarchive` is **git-ignored** — it embeds
   third-party secrets). If you only have the `.webarchive` (as with the Japan
   trails), recover the page HTML from its `WebMainResource.WebResourceData`
   bytes first (§1) — every HTML-based step below then works as written.
2. **Extract JSON-LD metadata** from the HTML (`@type: "LocalBusiness"`):
   name, geo lat/lon (→ `center`), `address.addressLocality` (→ `area`), and the
   hero `image` URL. (§2a) (`aggregateRating` is no longer carried into the app —
   the `rating`/`reviews` fields were removed; see §2a.)
3. **Pull the official numeric stats.** Read length / gain / max / duration
   from the page's **`trailGeoStats`** block (§2d) — this is the cleanest
   source and is **required** for cross-linked pages like the Fuji routes,
   where a naïve `length`/`elevation_gain` regex matches the wrong trail.
   (Older WA trails used the §2b Next/RSC payload: `length` → miles,
   `elevation_gain` → feet, **anchored on the primary trail object**.) Either
   way: `route_type` → route, `difficulty_rating` → label; `gainFt` =
   **DEM-based** gain. Verify against the figures shown on the page.
4. **Get the hero image.** Either extract it from the `.webarchive` with
   `plistlib` (no network), or — preferred for resolution, and **required**
   when the archive embedded only thumbnails (the Japan case) — rewrite the
   image URL's base64 config to `1200×800 cover, webp` and fetch it. Save as
   `images/<slug>.webp`. (§4)
5. **Write the `trails.js` entry.** Use the existing objects as the template
   (`slug`, `name`, `area`, `img`, `gpx`, `lengthMi`,
   `gainFt`, `diff`, `route`, `time`, `season`, `dogs`, `permit`, `center`,
   `summary`, `description`, `tips[]`). For a **non-US trail add
   `tiles:"gsi"`** so it uses the GSI 地理院タイル basemap instead of USGS topo
   (omit the field for US trails); the tile-source mechanism lives in
   `app.js` `TILE_SOURCES` / `trailSource()` — see `docs/ARCHITECTURE.md` and
   `docs/I18N.md`. `gainFt` = **official DEM gain**, not raw GPX (§3).
   Hand-curate `summary` / `description` / `tips`. (§2c)
6. **Drop the assets in place.** GPX → `gpx/<File>.gpx`; image →
   `images/<slug>.webp`. Make sure `trails.js` `gpx:` and `img:` paths match
   the filenames exactly.
7. **Register both in the service worker.** Add the new `gpx/...` and
   `images/...` paths to `TRAIL_ASSETS` in `sw.js` so they are precached for
   offline. Bump `APP_V` (currently `wa-trails-app-v15`) so clients pick up the
   new asset list. (`sw.js`'s tile handler — `isTile()` — already matches both
   `nationalmap.gov` and `cyberjapandata.gsi.go.jp` and serves/stores their tiles
   in **IndexedDB**, so a `tiles:"gsi"` trail's tiles save offline with no further change.)
8. **Verify the GPX.** Run the §5 verifier. Confirm `length_mi` ≈ the
   AllTrails distance, bounds look right, and waypoint count is what you
   expect. The inflated `raw_gain_ft` is expected — do not ship it.

That's it. Load the app, open the new trail, and confirm the map track,
endpoints/waypoints, and elevation profile render.
