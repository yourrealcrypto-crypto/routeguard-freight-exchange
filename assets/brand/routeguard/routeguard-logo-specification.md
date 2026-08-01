# RouteGuard Freight Exchange — logo specification

Vector reconstruction of `uploads/routeguard-logo-reference.png` (1448 × 1086).
The PNG is the visual authority; every value below was measured from it.

**Status: VECTOR RECONSTRUCTION — NOT YET FROZEN**

## Files

| File | Purpose |
| --- | --- |
| `routeguard-freight-exchange-master.svg` | Production master. All text outlined, no font dependency, transparent background. |
| `routeguard-freight-exchange-editable.svg` | Editable master. Live text, identical geometry, typography record in a comment. |
| `routeguard-freight-exchange-overlay.png` | 50% overlay, source PNG under the reconstruction. |
| `routeguard-freight-exchange-side-by-side.png` | Source and reconstruction at identical scale. |
| `RouteGuard Logo Reconstruction.dc.html` | Spec sheet / fidelity review page. |
| `ROUTEGUARD_BRAND_ASSET_MANIFEST.md` | Derived production asset family (15 assets). |

## Coordinate system

- `viewBox="0 0 1304 328"` (width 1304, height 328, aspect ratio 3.9756 : 1)
- Origin maps to PNG pixel (75, 384); 1 unit = 1 source pixel, so the SVG rendered
  at 1304 × 328 is pixel-comparable with the source crop.
- Visible bounding box fills the viewBox exactly: left edge = start-node outer edge,
  right edge = terminal-node outer edge, top = gateway outer top, bottom = gateway outer bottom.
- Background: transparent. No filters, gradients, masks, clips, or raster data.

## Colors (sampled from stroke interiors, anti-aliased edges excluded)

| Role | Hex | Source sample (R,G,B) | Applied to |
| --- | --- | --- | --- |
| Dark navy | `#0E243A` | 14, 37, 58 | gateway, wordmark |
| Verified green | `#0A9F4D` | 10, 159, 77 | nodes, checkmark, verified route |
| Descriptor gray | `#474B4F` | 71, 74, 78 | FREIGHT EXCHANGE |

One flat color per role; no tints or opacity anywhere.

## Route centerline

- `y = 184` — shared by the start node, all three waypoints, the verified route band,
  and the terminal node.
- Both gateway openings straddle this line.

## `routeguard-gateway`

- Rounded square, drawn as two open paths (upper section, lower section).
- Stroke `#0E243A`, `stroke-width="32"`, `stroke-linecap="butt"`, no fill.
- Stroke centerline rectangle: x 130 → 423, y 16 → 312 (293 × 296).
- Outer bounds 114 → 439 × 0 → 328; inner bounds 146 → 407 × 32 → 296.
- Corner radius: 42 on the centerline (58 outer, 26 inner).
- Left opening (inbound side): centerline ends at y 135 and y 218 — an 83-unit gap.
- Right opening (verified side): centerline ends at y 155 and y 213 — a 58-unit gap.

## `routeguard-inbound`

| Node | Center | r | Diameter |
| --- | --- | --- | --- |
| Start node | 26, 184 | 26 | 52 |
| Waypoint 1 | 82, 184 | 10.5 | 21 |
| Waypoint 2 | 126, 184 | 10.5 | 21 |
| Waypoint 3 | 170, 184 | 10.5 | 21 |

- Start-node edge to waypoint 1 center: 56. Waypoint pitch: 44 (constant).
- Waypoint 3 to the checkmark's lower-left cap: 38 of clear space.

## `routeguard-check`

- Polyline `M219 172 L258 213 L366 98`.
- Stroke `#0A9F4D`, `stroke-width="29"`, round cap and round join.
- Short arm: 219,172 → 258,213 (length 56.6, 46.4° down-right).
- Long arm: 258,213 → 366,98 (length 157.7, 46.8° up-right).
- Vertex at 258,213 sits 29 below the route centerline; ink bottom 227, ink top 84.
- Deliberately heavier than the route (29 vs 20) so the checkpoint reads as the event.

## `routeguard-verified-route`

- Band `M337 174 L1283 174 L1283 194 L321 194 Z` — 20 thick, centered on y 184.
- Left end is cut parallel to the checkmark's long arm (top-left 337, bottom-left 321),
  reproducing the constant 26-unit gap the source keeps between check and route.
- Right end runs into the terminal node center, so the node forms the cap.
- Terminal node: center 1283, 184, r 21 (diameter 42) — half the start node, closing the route.
- Run length: 946 from cut to terminal center; the band passes through the gateway's
  right opening and beneath the wordmark.

## `routeguard-wordmark`

- Family: **Plus Jakarta Sans** (static instances; unitsPerEm 1000, capHeight 745).
- `Route`: weight 500 · `Guard`: weight 800 — the source measures stems of 14 and 21
  units against a 101-unit cap height (0.139 and 0.208 ratios).
- Font size 136.5 for both; baseline `y = 137`; cap height 101.7; ascender top 33.7.
- Ink extents: x 479 → 1252.85 (774), aligned flush left with the descriptor.
- Manual kerning — every glyph is placed by absolute x (no tracking value):

| Glyph | R | o | u | t | e | G | u | a | r | d |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| x | 467.67 | 556.17 | 641.67 | 720.04 | 768.17 | 847.99 | 953.99 | 1035.5 | 1115.49 | 1168.5 |
| ink left | 479 | 563 | 650 | 724 | 775 | 854 | 960 | 1040 | 1123 | 1173 |

- `Route` / `Guard` join: `e` ink ends at 845.3, `G` ink starts at 854 — 8.7 of optical gap.
- Wordmark sits above the route line with 39 of clear space (ink bottom 138.6 → band top 174... measured from cap: baseline 137 to band top 174 = 37).

## `routeguard-descriptor`

- FREIGHT EXCHANGE, Plus Jakarta Sans weight 700, font size 59.5, baseline `y = 268`.
- Cap height 44.3 — 0.436 of the wordmark cap height, keeping it clearly secondary.
- Ink extents x 480 → 1248.45; left edge aligns with the wordmark (479), right edge
  optically flush (1252.85 wordmark / 1248.45 descriptor).
- Tracking: manual per-glyph x (letter gaps 15–16, word space 43):

| Glyph | F | R | E | I | G | H | T | E | X | C | H | A | N | G | E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| x | 475.72 | 523.72 | 576.72 | 626.72 | 654.02 | 710.72 | 765.35 | 839.72 | 889.35 | 938.02 | 991.72 | 1046.35 | 1101.72 | 1158.03 | 1214.72 |
| ink left | 480 | 528 | 581 | 631 | 657 | 715 | 766 | 844 | 890 | 941 | 996 | 1047 | 1106 | 1161 | 1219 |

- Descriptor cap top 223.7 sits 29.7 below the route band bottom (194).

## Fidelity check

Reconstruction rendered at source scale (1304 × 328 placed at PNG 75, 384), then
compared pixel-by-pixel against the PNG (ink threshold, mismatch as a share of all
ink pixels in the region):

| Region | Mismatch |
| --- | --- |
| Whole logo | 9.2% |
| Symbol (gateway, nodes, checkmark, route) | 3.3% |
| Wordmark | 15.3% |
| Descriptor | 18.7% |

Class bounding boxes match the source to within 1px (navy 189–1326 × 384–711 in both;
green 75–1379 × 467–611 vs 468–611 in the source). The residual text mismatch is soft
edges in the source raster plus small letterform differences — the source is an AI-rendered
raster with no font metadata, so the wordmark is a metric match (cap height, stem ratio,
per-glyph ink position and width), not a glyph-for-glyph identity.

Known deviations, all deliberate:

1. Left gateway opening — the source gap is centered 8 units above the route line
   (an artifact of the raster). Reproduced as measured; center it on y 184 if the
   design should be mathematically balanced.
2. `R` of Route is ~5 units narrower than the source `R`; source `G` of Guard is
   ~6 units narrower than Plus Jakarta Sans ExtraBold. Typeface difference, not placement.
3. Gateway strokes end square (butt) at both openings, matching the source terminations.

## Not yet produced (awaiting sign-off on this master)

Symbol-only, monochrome, reversed / dark-background, favicon, and web variants.
