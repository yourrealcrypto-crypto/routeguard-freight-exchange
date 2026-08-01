# RouteGuard logo reference measurements

Reference: `reference/routeguard-logo-reference.png`

Measurement date: 2026-07-31

## Method

The 1448 × 1086 px PNG was inspected programmatically by classifying dark and
green foreground pixels, computing connected components, and checking the
result against the raster at original resolution. Anti-aliased boundary values
are reported to the nearest useful pixel; font rasterization and the soft
off-white source canvas can shift thresholded edges by about 1 px.

All normalized values below use the visible-logo bounds (1305 × 329 px) as
100% width and 100% height. Coordinates are relative to the visible-logo
origin at source pixel (75, 384).

## Canvas and principal bounds

| Measurement | Source pixels | Visible-relative pixels | Normalized |
|---|---:|---:|---:|
| Raster canvas | 1448 × 1086 | — | — |
| Visible-logo bounds | x 75–1379, y 384–712 | 1305 × 329 | 100.00% × 100.00% |
| Total aspect ratio | — | 1305:329 | 3.9666:1 |
| Symbol bounds | x 75–513, y 384–712 | x 0–438, y 0–328 | 33.64% × 100.00% |
| Wordmark bounds | x 554–1326, y 418–521 | x 479–1251, y 34–137 | 59.23% × 31.61% |
| Descriptor bounds | x 555–1326, y 607–651 | x 480–1251, y 223–267 | 59.16% × 13.68% |

## Symbol construction

| Measurement | Measured pixels | Normalized to visible bounds |
|---|---:|---:|
| Gateway outer bounds | x 189–513, y 384–712 (325 × 329) | x 8.74%–33.56%, y 0%–100% |
| Gateway stroke | 31–32 px | 2.45% W / 9.73% H |
| Gateway outer corner radius | about 60 px | 4.60% W / 18.24% H |
| Horizontal route centerline | source y 568 | y 184 | 55.93% H |
| Origin node | 52 px diameter; center about (100.5, 567.5) | 3.98% W / 15.81% H |
| Waypoint dots | 21–22 px diameter | 1.69% W / 6.69% H |
| Waypoint centers | source x 157, 201.5, 245.5 | x 82, 126.5, 170.5 | 6.28%, 9.69%, 13.07% W |
| Waypoint spacing | 44–44.5 px center-to-center | 3.37%–3.41% W |
| Checkmark bounds | x 280–454, y 468–611 (175 × 144) | x 205–379, y 84–227 | 13.41% W × 43.77% H |
| Checkmark stroke | about 28 px | 2.15% W / 8.51% H |
| Verified-route stroke | about 20 px | 1.53% W / 6.08% H |
| Terminal node | 42 px diameter; center about (1359, 568) | 3.22% W / 12.77% H |

## Spacing and hierarchy

| Measurement | Pixels | Normalized |
|---|---:|---:|
| Symbol-to-wordmark gap | 40 px | 3.07% W |
| Wordmark-to-route gap | about 36 px (ink bottom to route top) | 10.94% H |
| Route-to-descriptor gap | about 29 px (route bottom to ink top) | 8.81% H |
| Wordmark cap/ink height | 104 px | 31.61% H |
| Descriptor cap/ink height | 45 px | 13.68% H |

## SVG reconstruction mapping

The production master uses `viewBox="0 0 1305 329"`, exactly matching the
visible-logo aspect ratio. Geometry is therefore expressed directly in
visible-relative reference pixels:

- gateway outer bounds: x 114–438, y 0–328;
- route centerline: y 184;
- origin center: (26, 184);
- waypoint centers: (82, 184), (126, 184), and (170, 184);
- check centerline: (219, 173) → (258, 214) → (365, 98);
- verified route: x 321–1284 at y 184;
- terminal center: (1284, 184);
- wordmark ink target: x 479–1251, y 34–137;
- descriptor ink target: x 480–1252, y 223–267.

The approved palette replaces the raster’s color and compression variation;
geometry, alignment, proportion, and hierarchy remain the comparison targets.
