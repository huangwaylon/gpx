# Ume-chan's Trails — Data Pipeline

How the source data for the eight bundled trails was extracted from saved
AllTrails web pages and turned into the app's runtime assets
(`trails.js`, `gpx/*.gpx`, `images/*.webp`). This document exists so the
process is **reproducible** when adding a new trail.

> TL;DR for the impatient: skip to
> [Reproducing the pipeline for a new trail](#6-reproducing-the-pipeline-for-a-new-trail).

---

## 0. Where things live

| Path | Status | What it is |
| --- | --- | --- |
| `alltrails/` | **git-ignored** (see `.gitignore`) | Raw source: saved AllTrails `.html` page exports, `.webarchive` Safari archives, and `.gpx` downloads. Large (~340 MB), never deployed. |
| `trails.js` | committed | The final trail metadata array (`window.TRAILS`). The product of the metadata stages below. |
| `gpx/*.gpx` | committed | One GPX track per trail. Loaded and parsed **at runtime** by `app.js` (not pre-baked into JSON). |
| `images/*.webp` | committed | One hero photo per trail, `1200×800` WebP. |
| `sw.js` | committed | Service worker. Lists every GPX + image in `TRAIL_ASSETS` so they are cached on install for full offline use. |
| `app.js` | committed | Runtime: GPX parse, haversine distance, elevation smoothing, map + elevation profile. |

The app is a static PWA showing **8 Washington State trails**:

Lake 22, Snow Lake, Lake Valhalla, Talapus Lake, Mount Pilchuck,
Bridal Veil Falls & Lake Serene, Skyline Loop, The Enchantments Traverse.

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
| `aggregateRating.ratingValue` | `rating` | e.g. `4.7` |
| `aggregateRating.reviewCount` | `reviews` | e.g. `18454` (matches `trails.js`). |
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
constant for elevation, and `1609.344` inline (`mi → km`) for distance display.

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

### 2c. Hand-curated prose

The `summary`, `description`, and `tips[]` fields in `trails.js` were
**hand-written / edited** from the page's description text, official-trail
notes, and top reviews. They are intentionally tighter and more useful than
the raw AllTrails marketing blurb. Treat these as editorial, not mechanical
extraction. (The map/photo attribution lines in `app.js` credit AllTrails
for trail info and photos and USGS for the basemap.)

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
  eight files. At runtime the map actually frames the track via
  `map.fitBounds(trackLayer.getBounds())` (computed from the drawn polyline);
  the offline-tile bounding box (`trailBox()` in `app.js`) is computed from the
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

1. **Save the source.** From the AllTrails trail page, save **both** the
   `.html` and the `.webarchive` (Safari → File → Save As → *Web Archive*),
   and download the route `.gpx`. Drop all three in `alltrails/` (git-ignored).
2. **Extract JSON-LD metadata** from the `.html` (`@type: "LocalBusiness"`):
   name, geo lat/lon (→ `center`), `aggregateRating` (→ `rating`, `reviews`),
   `address.addressLocality` (→ `area`), and the hero `image` URL. (§2a)
3. **Pull the official numeric stats** from the embedded Next/RSC payload:
   `length` (→ miles), `elevation_gain` (→ feet), `route_type` (→ route),
   `difficulty_rating` (→ label). **Anchor on the primary trail object** and
   verify against the figures shown on the page — the page also embeds nearby
   trails. (§2b)
4. **Get the hero image.** Either extract it from the `.webarchive` with
   `plistlib` (no network), or — preferred for resolution — rewrite the image
   URL's base64 config to `1200×800 cover, webp` and fetch it. Save as
   `images/<slug>.webp`. (§4)
5. **Write the `trails.js` entry.** Use the existing objects as the template
   (`slug`, `name`, `area`, `img`, `gpx`, `rating`, `reviews`, `lengthMi`,
   `gainFt`, `diff`, `route`, `time`, `season`, `dogs`, `permit`, `center`,
   `summary`, `description`, `tips[]`). `gainFt` = **official DEM gain**, not
   raw GPX (§3). Hand-curate `summary` / `description` / `tips`. (§2c)
6. **Drop the assets in place.** GPX → `gpx/<File>.gpx`; image →
   `images/<slug>.webp`. Make sure `trails.js` `gpx:` and `img:` paths match
   the filenames exactly.
7. **Register both in the service worker.** Add the new `gpx/...` and
   `images/...` paths to `TRAIL_ASSETS` in `sw.js` so they are precached for
   offline. Bump `APP_V` (e.g. `wa-trails-app-v2` → `-v3`) so clients pick up
   the new asset list.
8. **Verify the GPX.** Run the §5 verifier. Confirm `length_mi` ≈ the
   AllTrails distance, bounds look right, and waypoint count is what you
   expect. The inflated `raw_gain_ft` is expected — do not ship it.

That's it. Load the app, open the new trail, and confirm the map track,
endpoints/waypoints, and elevation profile render.
