# RouteGuard logo specification

Version 1.0 — 2026-07-31

## Naming hierarchy

- Primary brand: **RouteGuard**
- Formal product: **RouteGuard Freight Exchange**
- Operational application: **RouteGuard Control**

The primary wordmark is always `RouteGuard`, with that exact capitalization.
The formal descriptor is always `FREIGHT EXCHANGE`.

## Production source of truth

`routeguard-freight-exchange-master.svg` is the production source of truth for
the formal lockup. Its typography is outlined and has no runtime font
dependency. `routeguard-freight-exchange-editable.svg` is an authoring aid,
not the production source.

## Construction

The mark reads left to right as a compact process:

1. one origin node and exactly three waypoints form the inbound route;
2. an interrupted rounded gateway represents the controlled checkpoint;
3. one continuous green check represents verification;
4. a thinner green route confirms successful passage and ends in one terminal
   node.

The check is deliberately heavier than the confirmed route. The gateway is
architectural and interrupted at the horizontal route plane; it is not a
checkbox, shield, map pin, road, or vehicle.

## Palette

| Role | Value |
|---|---|
| Charcoal | `#11151D` |
| Verified green | `#10B981` |
| Muted descriptor | `#60646C` |
| White | `#FFFFFF` |

Only these flat colors belong in the logo system. Do not add gradients,
shadows, glow, blur, textures, or 3D effects.

## Files and viewBoxes

| File | Use | ViewBox |
|---|---|---|
| `routeguard-freight-exchange-master.svg` | Formal production lockup | `0 0 1305 329` |
| `routeguard-freight-exchange-editable.svg` | Live-text authoring master | `0 0 1305 329` |
| `routeguard-horizontal-compact.svg` | Header lockup without descriptor | `0 0 1305 329` |
| `routeguard-symbol.svg` | Small UI and icon contexts | `0 0 256 256` |
| `routeguard-monochrome.svg` | One-color reproduction | `0 0 1305 329` |
| `routeguard-reverse.svg` | Charcoal surfaces | `0 0 1305 329` |

All SVGs have transparent backgrounds.

## Typography and outlines

The closest locally available open-source match to the approved reference is
Poppins.

- `RouteGuard`: Poppins Medium (500), 138 units, tracking −4.9 units.
- `FREIGHT EXCHANGE`: Poppins Regular (400), 63 units, tracking 12.57 units.

The production, compact, monochrome, and reverse files contain Poppins glyph
outlines as SVG paths. Their individual outline boxes are fitted to the
measured reference glyph boxes to preserve the approved word widths and
spacing without bitmap tracing. The editable file retains semantic live text
and records the family, weight, size, tracking, and baseline directly in the
SVG; it is the closest font-editable approximation rather than geometric
authority.

## Clear space

Maintain clear space on every side equal to the diameter of one small waypoint
dot in the selected lockup. For the formal master this is 22 viewBox units.
For the symbol this is 10 viewBox units. Nothing may enter that area.

## Minimum sizes

- Formal full lockup: minimum 320 px wide for screen use.
- Compact horizontal lockup: minimum 220 px wide.
- Symbol: minimum 16 px square; use the supplied size-specific render rather
  than downscaling the full lockup.
- Print: do not reproduce the formal lockup below 55 mm wide.

At very small sizes, preserve the supplied symbol geometry. Do not remove,
merge, or add route nodes.

## Background use

### Light backgrounds

Use the production master on white or very light neutral surfaces. Maintain
strong contrast for charcoal and muted descriptor text.

### Dark backgrounds

Use `routeguard-reverse.svg` on charcoal surfaces. Gateway, inbound route,
wordmark, and descriptor are white; verification remains green. The green
`#10B981` has sufficient contrast against charcoal `#11151D` for the large
graphic strokes used here.

### Monochrome

Use `routeguard-monochrome.svg` only when color reproduction is unavailable.
Every component becomes charcoal while the gateway interruption, heavier check,
thinner route, and node sequence preserve the process meaning.

## Choosing a lockup

- Use the formal full lockup for title pages, formal product identification,
  and external collateral.
- Use the compact lockup in application headers and horizontally constrained
  navigation.
- Use the symbol for favicons, mobile headers, collapsed sidebars, and
  application icons.
- Use the wordmark alone only when an already-present symbol makes the brand
  unmistakable; no wordmark-only asset is part of this controlled family.

## Accessibility

SVG files include a title and description and are suitable as meaningful
images. If surrounding text already names RouteGuard, mark the placed logo as
decorative to avoid repeated announcements. Never rely on green alone to
communicate success: the check shape, gateway interruption, and continuing
route carry the same meaning without color.

## Prohibited treatments

Do not:

- redraw, rotate, skew, stretch, or rearrange the components;
- change the node count or route baseline;
- disconnect the checkmark;
- make the verified route heavier than the check;
- substitute arrows, pins, roads, trucks, shields, crypto motifs, Hedera
  marks, or other symbols;
- recolor individual components outside the approved variants;
- add gradients, shadows, glow, blur, raster effects, outlines, or 3D styling;
- place the light-background master on a low-contrast dark surface;
- typeset a replacement descriptor or alter its spelling.
