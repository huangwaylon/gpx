// Trail data — 8 Washington State (USA) trails + 5 Japan trails.
// Stats sourced from AllTrails (length/gain/difficulty); geometry from bundled GPX.
// `tiles` picks the offline basemap source: omitted = USGS topo (US), "gsi" = GSI 地理院タイル (Japan).
window.TRAILS = [
  {
    slug: "lake-22",
    name: "Lake 22 Trail",
    area: "Granite Falls, WA",
    img: "images/lake-22.webp",
    gpx: "gpx/Lake_22_Trail.gpx",
    rating: 4.7, reviews: 18454,
    lengthMi: 6.1, gainFt: 1456, diff: "Moderate",
    route: "Out & back", time: "3 h 17 min",
    season: "Apr – Nov", dogs: "Leashed",
    permit: "NW Forest Pass or day-use fee (Recreation.gov app)",
    center: [48.0700, -121.7555],
    summary: "A beautiful hike to an alpine lake through old-growth forest, ending with stunning views of Mount Pilchuck rising behind a turquoise lake.",
    description: "Lake Twenty-Two Trail climbs through lush old-growth rainforest off the Mountain Loop Highway east of Granite Falls. The path starts gently on a dirt staircase, with Twenty-Two Creek flowing alongside. A bridge crosses the creek about a mile in beside a pretty waterfall. From there the trail steepens, with rocks and creek crossings, then gentle switchbacks lead to a long talus slope beneath the wall of Lake Twenty-Two. The trail flattens near the lake outlet stream, arriving at a turquoise lake with the steep wall of Mount Pilchuck looming behind. A short loop circles the lake.",
    tips: [
      "Rocky trail — sturdy hiking boots are necessary.",
      "Waterproof boots recommended for creek crossings.",
      "Not the best fit for young kids due to rocks and water.",
      "Very popular — arrive early, parking fills fast on weekends."
    ]
  },
  {
    slug: "snow-lake",
    name: "Snow Lake Trail",
    area: "Snoqualmie Pass, WA",
    img: "images/snow-lake.webp",
    gpx: "gpx/Snow_Lake_Trail.gpx",
    rating: 4.7, reviews: 19522,
    lengthMi: 6.7, gainFt: 1686, diff: "Moderate",
    route: "Out & back", time: "3 h 40 min",
    season: "Jul – Oct", dogs: "Leashed",
    permit: "NW Forest Pass or day-use fee (Recreation.gov app)",
    center: [47.4570, -121.4355],
    summary: "One of the most popular hikes in the Alpine Lakes Wilderness, climbing past waterfalls to a large lake beneath Chair Peak.",
    description: "Starting at the Alpental Ski Area, this trail climbs alongside the South Fork Snoqualmie River with Snoqualmie Mountain on your right. You'll pass numerous waterfalls and follow steep switchbacks up to Snow Lake. Just before the 2-mile mark you reach the Source Lake Overlook junction; turn north to continue to the lake. At the top you'll have incredible views of Snow Lake with Chair Peak in the background. It's also a popular entrance into the larger Alpine Lakes Wilderness and a great base for overnight trips.",
    tips: [
      "Winter brings avalanche terrain — come prepared.",
      "Snowshoes or microspikes recommended depending on season.",
      "Trail can be hard to follow in winter — record your hike.",
      "Get an early start; this is a very busy trailhead."
    ]
  },
  {
    slug: "lake-valhalla",
    name: "Lake Valhalla Trail",
    area: "Leavenworth, WA",
    img: "images/lake-valhalla.webp",
    gpx: "gpx/Lake_Valhalla_Trail.gpx",
    rating: 4.7, reviews: 3108,
    lengthMi: 6.4, gainFt: 1371, diff: "Moderate",
    route: "Out & back", time: "3 h 16 min",
    season: "May – Oct", dogs: "Leashed",
    permit: "NW Forest Pass or parking fee",
    center: [47.7989, -121.0906],
    summary: "A rewarding hike to a beautiful alpine lake — steep at first, then gradual. Bring a swimsuit and a lunch.",
    description: "This trail takes you to a beautiful alpine lake near Stevens Pass. The trail is steep in the beginning but becomes more gradual as you get closer to the lake. Bring your swimsuit and a lunch and spend the afternoon taking in the scenery and enjoying the water. A great moderate day hike popular with backpackers, anglers, and day hikers alike.",
    tips: [
      "Mosquitoes can be bad in early summer — bring bug spray.",
      "Bring a swimsuit; the lake is great for a dip.",
      "NW Forest Pass required at the trailhead."
    ]
  },
  {
    slug: "talapus-lake",
    name: "Talapus Lake Trail",
    area: "Snoqualmie Pass, WA",
    img: "images/talapus-lake.webp",
    gpx: "gpx/Talapus_Lake_Trail.gpx",
    rating: 4.7, reviews: 3350,
    lengthMi: 3.5, gainFt: 656, diff: "Moderate",
    route: "Out & back", time: "1 h 42 min",
    season: "May – Oct", dogs: "Leashed",
    permit: "NW Forest Pass",
    center: [47.4074, -121.5166],
    summary: "A quiet, scenic forest hike to a peaceful lake — short enough for an easy afternoon, gorgeous in fall.",
    description: "A well-maintained, family-friendly trail to a serene lake. The access road is rough but the trail itself is in good shape. It can get crowded, but arriving early helps you beat the crowds. Go in the fall for beautiful colors and photos. The lake is a great spot to stop for lunch before heading back the way you came.",
    tips: [
      "The access road is rough — drive carefully.",
      "Arrive early to beat the crowds.",
      "Stunning fall colors — best in autumn."
    ]
  },
  {
    slug: "mount-pilchuck",
    name: "Mount Pilchuck Trail",
    area: "Granite Falls, WA",
    img: "images/mount-pilchuck.webp",
    gpx: "gpx/Mount_Pilchuck_Trail.gpx",
    rating: 4.8, reviews: 6055,
    lengthMi: 5.4, gainFt: 2142, diff: "Hard",
    route: "Out & back", time: "~3 h 30 min",
    season: "Jun – Oct", dogs: "Leashed",
    permit: "NW Forest Pass (Mount Pilchuck State Park)",
    center: [48.0638, -121.8071],
    summary: "A challenging climb to a restored fire lookout tower with panoramic views of Baker, Rainier, Puget Sound, and the Olympics.",
    description: "Mount Pilchuck Trail climbs to an old fire lookout tower offering panoramic summit views. There's a fantastic change in scenery as you ascend — lush old-growth forest at the bottom giving way to arid, rocky overlooks toward the top. The terrain can be rough and requires a good sense of balance to navigate the rocky pathway. From the lookout, enjoy great views of Mount Baker, Mount Rainier, Puget Sound, and the Olympics.",
    tips: [
      "Rocky terrain near the top — good balance required.",
      "The final road to the trailhead is rough with potholes.",
      "Expect mud and snow as late as mid-summer — dress accordingly.",
      "One of the busiest trails in the area — arrive early."
    ]
  },
  {
    slug: "bridal-veil",
    name: "Bridal Veil Falls & Lake Serene",
    area: "Gold Bar, WA",
    img: "images/bridal-veil.webp",
    gpx: "gpx/Bridal_Veil_Falls_and_Lunch_Rock_via_Lake_Serene_Trail.gpx",
    rating: 4.7, reviews: 15473,
    lengthMi: 8.0, gainFt: 2716, diff: "Hard",
    route: "Out & back", time: "5 h 10 min",
    season: "Apr – Sep", dogs: "Leashed",
    permit: "NW Forest Pass",
    center: [47.7967, -121.5680],
    summary: "What it lacks in length it makes up for in elevation gain — a steep climb to a stunning blue lake ringed by high ridges, with a worthy waterfall side trip.",
    description: "Lake Serene is an alpine lake nestled in the Cascades, accessed off Mount Index Road near Stevens Pass. The first mile and a half is a well-manicured, slightly inclined path; partway you can detour a half-mile to Bridal Veil Falls — well worth the side trip. Back on the main trail, the final two miles to the lake climb hard through long wooden steps, rocky passages, and switchbacks, with a very steep grade about 1.4 miles in. At the top you're rewarded with a stunning blue lake surrounded by high ridges. Cross the log bridge to reach 'Lunch Rock,' a large smooth slab where people relax and jump in.",
    tips: [
      "Get an early start — the trailhead parking fills fast.",
      "The side trip to Bridal Veil Falls is worth the extra mile.",
      "Crampons and ice axes recommended in winter.",
      "NW Forest Pass required."
    ]
  },
  {
    slug: "skyline-loop",
    name: "Skyline Loop",
    area: "Paradise, Mt. Rainier NP",
    img: "images/skyline-loop.webp",
    gpx: "gpx/Skyline_Loop.gpx",
    rating: 4.9, reviews: 29808,
    lengthMi: 5.7, gainFt: 1781, diff: "Hard",
    route: "Loop", time: "~3 h 30 min",
    season: "Jun – Sep", dogs: "Not allowed",
    permit: "Mount Rainier NP entrance fee",
    center: [46.7962, -121.7268],
    summary: "The most popular route out of Paradise on Mount Rainier's south side — lush meadows, glacier views, rivers, waterfalls, and Panorama Point.",
    description: "The Skyline Trail is the classic loop out of Paradise on the southern side of Mount Rainier, with something for everyone: wildflower meadows, glacier views, rivers, and waterfalls. The loop can be done in either direction, though many choose clockwise. If you don't want the full loop, many hikers turn around at Panorama Point — the summit push has steep sections with loose rock and some scrambling. On the western side, an optional Glacier Vista offshoot overlooks the Nisqually Glacier. You'll start at the Jackson Visitor Center (restrooms, food, exhibits).",
    tips: [
      "Dogs are not allowed — this is a National Park trail.",
      "Oct–May the route requires spikes, snowshoes, and poles.",
      "Don't attempt in winter without snow/ice experience.",
      "Steep loose rock near Panorama Point — some scrambling."
    ]
  },
  {
    slug: "enchantments",
    name: "The Enchantments Traverse",
    area: "Leavenworth, WA",
    img: "images/enchantments.webp",
    gpx: "gpx/The_Enchantments_Traverse.gpx",
    rating: 4.8, reviews: 7089,
    lengthMi: 19.1, gainFt: 4845, diff: "Very Hard",
    route: "Point to point", time: "10 – 13 h",
    season: "Jul – Oct", dogs: "Not allowed",
    permit: "Overnight permit required (lottery)",
    center: [47.5110, -120.7755],
    summary: "A bucket-list traverse through soft tundra meadows, glacial lakes, and impossible granite — one of the great alpine adventures of the Pacific Northwest.",
    description: "This epic trip through the Alpine Lakes Wilderness wanders past tundra meadows, glacial-cirque lakes, trickling streams, and granite rock formations that look like another world. Usually done as an overnight, though fit hikers can do it in a long day. Starting from the Stuart Lake Trailhead, head south to Colchuk Lake with views of Dragontail and Colchuk Peaks, then tackle the brutal ascent up Aasgard Pass. The trail passes scree, alpine meadows, and countless lakes — mountain goats are common. Descend through the Lower Enchantments past Tranquil, Inspiration, and Perfection Lakes, then down past Snow Creek Falls to Snow Lakes and out to Icicle Creek Road.",
    tips: [
      "Overnight permits are required (competitive lottery).",
      "Some sections require off-trail navigation — bring offline maps.",
      "Significant elevation loss on the descent — hard on the knees.",
      "Only for experienced adventurers. Two cars or a shuttle needed."
    ]
  },

  // ───────────────────────── Japan (GSI 地理院タイル basemap) ─────────────────────────
  {
    slug: "fuji-yoshida",
    name: "Mt. Fuji: Yoshida Trail (5th Station Ascent)",
    area: "Fujiyoshida, Yamanashi",
    img: "images/fuji-yoshida.webp",
    gpx: "gpx/Mt_Fuji_Yoshida.gpx",
    tiles: "gsi",
    rating: 4.6, reviews: 448,
    lengthMi: 4.2, gainFt: 4701, diff: "Hard",
    route: "Point to point", time: "3 h 46 min",
    season: "Jul – Sep", dogs: "Not allowed",
    permit: "Climbing season only · Yoshida Trail reservation + ¥2,000 entry fee (2024–)",
    center: [35.3800, 138.7403],
    summary: "The most popular route up Mt. Fuji — a relentless switchback climb from the Subaru Line 5th Station up through volcanic cinder and a line of mountain huts to the 3,710 m crater rim, the classic spot to watch the sunrise (goraikō).",
    description: "This is the busiest of Mt. Fuji's four routes and the one most first-timers choose. From the Subaru Line 5th Station (≈2,300 m) the trail climbs steadily through cinder slopes and dwarf pine, passing red torii gates, small shrines, and a near-continuous string of mountain huts. The ascending and descending trails are separate above the 6th Station, so this track follows the up-route only, finishing at the Yoshida-side crater rim near Kusushi Shrine (≈3,710 m); the true summit, Kengamine (3,776 m), is a 30–60 min walk around the crater (ohachi-meguri). Many climbers break the ascent with an overnight hut stay to acclimatize and reach the rim for dawn.",
    tips: [
      "Climbing season only — roughly early July to early September. Off-season the route is snowbound, hut-less, and genuinely dangerous.",
      "Since 2024 the Yoshida Trail requires an advance reservation and a ¥2,000 entry fee (daily cap ~4,000; the 5th-Station gate is closed roughly 2 pm–3 am except for hut guests).",
      "Altitude reaches ~3,710 m — climb slowly and watch for altitude sickness. An overnight hut stay helps you acclimatize.",
      "Even in summer the summit can be near freezing with high wind. Bring warm layers, rain gear, a headlamp, and cash for huts and toilets."
    ]
  },
  {
    slug: "fuji-gotemba",
    name: "Mt. Fuji: Gotemba Trail",
    area: "Gotemba, Shizuoka",
    img: "images/fuji-gotemba.webp",
    gpx: "gpx/Mt_Fuji_Gotemba.gpx",
    tiles: "gsi",
    rating: 4.7, reviews: 137,
    lengthMi: 12.5, gainFt: 7775, diff: "Hard",
    route: "Out & back", time: "11 h 50 min",
    season: "Jul – Sep", dogs: "Not allowed",
    permit: "Climbing season only · no gate fee (¥1,000 conservation donation requested)",
    center: [35.3508, 138.7609],
    summary: "The longest, quietest, and most demanding of Mt. Fuji's four routes — a vast climb over black volcanic sand from the low Gotemba trailhead (1,440 m) to the 3,750 m crater rim, with the famous 'sunabashiri' sand-run on the way down.",
    description: "The Gotemba route starts far lower than the others (≈1,440 m), so it is the longest and has by far the most elevation gain — a serious undertaking for fit, experienced, well-acclimatized hikers. Huts and water are sparse, and the trail crosses long, open slopes of loose cinder with little shelter and big exposure to wind and sun. The reward on the descent is the sunabashiri (大砂走り) — a kilometres-long plunge down soft volcanic sand that loses altitude fast. Because of its length most people climb it over two days, staying at one of the few huts near the 7th–8th Stations.",
    tips: [
      "Climbing season only — roughly early July to early September, like all Fuji routes.",
      "The longest route by far (about 10–12 h round trip). Start well before dawn, or split it with a hut stay.",
      "Few huts and little water — carry more than you think you need, plus cash.",
      "Gaiters help on the sunabashiri sand descent, which is fun but hard on the knees. Watch for altitude sickness up high."
    ]
  },
  {
    slug: "daibosatsu",
    name: "Mount Daibosatsu Loop",
    area: "Kōshū, Yamanashi",
    img: "images/daibosatsu.webp",
    gpx: "gpx/Mount_Daibosatsu_Loop.gpx",
    tiles: "gsi",
    rating: 4.6, reviews: 29,
    lengthMi: 5.4, gainFt: 2014, diff: "Hard",
    route: "Loop", time: "3 h 41 min",
    season: "Apr – Nov", dogs: "Leashed",
    permit: "No permit — free; parking at Kamihikawa Pass (上日川峠)",
    center: [35.7385, 138.8449],
    summary: "A friendly ridge loop in the Okuchichibu mountains with one of the best Mt. Fuji panoramas in Yamanashi — easy access to a breezy 2,000 m skyline and the historic Daibosatsu Pass.",
    description: "One of Japan's '100 Famous Mountains' and a perfect first alpine ridge. From Kamihikawa Pass (≈1,580 m) the loop climbs gently to the historic Daibosatsu Pass (1,897 m), then follows an open, grassy skyline over Raikō-iwa and the wooded summit of Daibosatsu-rei (2,057 m). The ridge gives sweeping views over Lake Kamihikawa to Mt. Fuji and the Southern Alps before dropping back through forest to the trailhead. Well-marked and hugely popular on clear weekends.",
    tips: [
      "Very easy access and well-signed — a great introduction to Japanese alpine ridge walking.",
      "The summit ridge is open and windy; bring an extra layer even on warm days.",
      "Best in autumn for colour and crisp Mt. Fuji views; expect snow and ice from late November into April (microspikes).",
      "Parking and toilets at Kamihikawa Pass fill early on fine weekends."
    ]
  },
  {
    slug: "kinpu",
    name: "Mount Kinpu (Kanayama)",
    area: "Hokuto, Yamanashi",
    img: "images/kinpu.webp",
    gpx: "gpx/Mount_Kinpu_Kanayama.gpx",
    tiles: "gsi",
    rating: 4.8, reviews: 2,
    lengthMi: 9.8, gainFt: 4304, diff: "Hard",
    route: "Out & back", time: "7 h 22 min",
    season: "Jun – Oct", dogs: "Leashed",
    permit: "No permit — free; trailhead parking near Mizugaki / Kanayama",
    center: [35.8755, 138.5996],
    summary: "A rugged full-day climb to the granite crown of Mt. Kinpu (2,599 m) and its iconic Gojō-iwa rock pillar, high on the Yamanashi–Nagano border in the wild Okuchichibu range.",
    description: "Mt. Kinpu is one of Japan's '100 Famous Mountains' and the high point of the Okuchichibu massif. From the Mizugaki/Kanayama trailhead the path climbs steadily through deep forest and mossy granite, passing huts and springs, before breaking out onto a boulder-strewn alpine ridge. The summit is crowned by Gojō-iwa (五丈岩), a giant granite tower visible for miles, with huge views across to Mt. Fuji, Yatsugatake, and the Southern and Central Alps. A long, rocky, rewarding day out.",
    tips: [
      "A long day with real elevation gain — start early and pace yourself on the rocky upper ridge.",
      "Granite boulder-hopping near the top; sturdy boots and careful footing required.",
      "Roughly June to October; snow lingers late and arrives early at 2,600 m.",
      "Gojō-iwa is a sacred rock pillar — enjoy it, but think twice about scrambling up it."
    ]
  },
  {
    slug: "kinpu-odarumi",
    name: "Mount Kinpu (Odarumi Pass)",
    area: "Odarumi Pass, Yamanashi",
    img: "images/kinpu-odarumi.webp",
    gpx: "gpx/Mount_Kinpu_Odarumi.gpx",
    tiles: "gsi",
    rating: 4.7, reviews: 14,
    lengthMi: 5.2, gainFt: 1673, diff: "Moderate",
    route: "Out & back", time: "3 h 15 min",
    season: "Jun – Oct", dogs: "Leashed",
    permit: "No permit — free; parking at Odarumi Pass (大弛峠)",
    center: [35.8733, 138.6443],
    summary: "The gentlest way to the granite crown of Mt. Kinpu (2,599 m) — a high alpine ridge walk from Odarumi Pass, the highest road pass in Japan, over Asahidake to the iconic Gojō-iwa rock pillar with huge Mt. Fuji and Southern Alps views.",
    description: "This is the easiest of the routes up Mt. Kinpu, one of Japan's '100 Famous Mountains.' It begins high — at Odarumi Pass (大弛峠, ≈2,360 m), the highest pass in Japan reachable by car — so most of the climbing is already behind you. The trail works through subalpine forest of moss and dwarf pine over the shoulder of Asahidake (朝日岳, 2,579 m), dips into a saddle, then rises onto a boulder-strewn alpine ridge to the summit. There the giant granite tower of Gojō-iwa (五丈岩) stands against sweeping views of Mt. Fuji, Yatsugatake, and the Southern and Central Alps. Return the way you came.",
    tips: [
      "Starts high at Odarumi Pass (≈2,360 m) — the most approachable way up Kinpu — but the air is thin and the weather turns fast.",
      "The road over Odarumi Pass closes in winter; the hiking season is realistically June to October.",
      "Boulder-hopping on the upper ridge near the summit — sturdy boots and careful footing required.",
      "Gojō-iwa is a sacred rock pillar — enjoy the views, but think twice about scrambling up it."
    ],
    // Optional upcoming-hike plan shared from YAMAP. Locale-neutral data; the few
    // text bits that differ by language carry { en, ja }. Rendered as a tappable
    // card on the detail sheet (see renderPlanCard in app.js). Stats are the plan's
    // own (a 瑞牆山・金峰山 round trip), shown inside the YAMAP-labelled card.
    plan: {
      url: "https://yamap.com/plans/code/qYx4uH75fDMQ5Sf695kWr4nNt8klIkHTwoN03pgpk5hccIVnh0FTucGyv4sHd3EZOZI",
      dateISO: "2026-06-27",
      party: 7,
      distKm: 7.9,
      gainM: 557,
      pace: 90,
      paceLabel: { en: "Relaxed", ja: "ややゆっくり" },
      constant: 15,
      by: { en: "Umeda", ja: "うめだ" },
      totalTime: "6:22",        // 行動時間 7:00 → 13:22 (includes the 2 h summit rest)
      sunrise: "4:30",
      sunset: "19:06",
      // Hour-by-hour itinerary (1日目). `depart` marks a rest/stay; leg times to the
      // next stop are computed in renderTimeline(). Fully offline — no YAMAP needed.
      itinerary: [
        { time: "7:00",  type: "start",    name: { en: "Odarumi Pass (start)", ja: "大弛峠駐車場" } },
        { time: "7:39",  type: "pass",     name: { en: "Asahi Pass",           ja: "朝日峠" } },
        { time: "8:18",  type: "peak",     name: { en: "Asahidake",            ja: "朝日岳" } },
        { time: "8:46",  type: "junction", name: { en: "Junction",             ja: "分岐" } },
        { time: "8:52",  type: "junction", name: { en: "Junction",             ja: "分岐" } },
        { time: "9:20",  depart: "11:20", type: "peak",
                         name: { en: "Mt. Kinpu (summit)", ja: "金峰山（甲州御岳山）" } },
        { time: "11:42", type: "junction", name: { en: "Junction",             ja: "分岐" } },
        { time: "11:48", type: "junction", name: { en: "Junction",             ja: "分岐" } },
        { time: "12:21", type: "peak",     name: { en: "Asahidake",            ja: "朝日岳" } },
        { time: "12:49", type: "pass",     name: { en: "Asahi Pass",           ja: "朝日峠" } },
        { time: "13:22", type: "goal",     name: { en: "Odarumi Pass",         ja: "大弛峠" } }
      ]
    }
  }
];
