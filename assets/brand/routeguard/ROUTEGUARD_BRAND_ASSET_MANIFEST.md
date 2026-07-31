# RouteGuard Freight Exchange — Production Brand Assets

Every asset below is derived from the approved production master
(`routeguard-freight-exchange-master.svg`). The master geometry is reused verbatim —
gateway path and 32-unit stroke, 42-unit corner radius, origin node r26, waypoints r10.5
at pitch 44, route centerline y 184, checkmark `M219 172 L258 213 L366 98` at stroke 29,
verified-route band 20 thick, terminal node r21, and the outlined RouteGuard /
FREIGHT EXCHANGE letterforms. Nothing was redrawn.

**Colors** — navy `#0E243A`, verified green `#0A9F4D`, descriptor gray `#474B4F`;
reverse set: structure `#F2F5F7`, wordmark `#FFFFFF`, descriptor `#B9BEC4`, green unchanged.

**Canonical group ids** — `routeguard-gateway`, `routeguard-inbound`, `routeguard-check`,
`routeguard-verified-route`, `routeguard-wordmark`, `routeguard-descriptor`
(`routeguard-terminal-node` inside the verified route). Composite canvases suffix the ids
of embedded instances so every id in a file stays unique.

**Technical baseline for every file** — explicit viewBox, `<title>` + `<desc>`, transparent
background unless the asset is an explicit canvas, flat fills and strokes only, all text
outlined, and no raster, base64, external URL, filter, shadow, gradient, mask or clip.

---

## Index

| # | File | Type | Background | Text | Min size |
| --- | --- | --- | --- | --- | --- |
| 01 | `routeguard-full-lockup-light.svg` | Logo | Light | Wordmark + descriptor | 320 px wide |
| 02 | `routeguard-full-lockup-dark.svg` | Logo | Charcoal | Wordmark + descriptor | 320 px wide |
| 03 | `routeguard-compact-header-light.svg` | Logo | Light | Wordmark | 200 px wide |
| 04 | `routeguard-compact-header-dark.svg` | Logo | Charcoal | Wordmark | 200 px wide |
| 05 | `routeguard-symbol.svg` | Logo | Any | None | 64 px wide |
| 06 | `routeguard-symbol-small.svg` | Logo | Any | None | 16 px wide |
| 07 | `routeguard-full-lockup-monochrome.svg` | Logo | Light / neutral | Wordmark + descriptor | 320 px wide |
| 08 | `routeguard-full-lockup-white.svg` | Logo | Dark | Wordmark + descriptor | 320 px wide |
| 09 | `routeguard-trust-lane-horizontal.svg` | Derived motif | Light | None | 480 px wide |
| 10 | `routeguard-route-divider.svg` | Derived motif | Light | None | 240 px wide |
| 11 | `routeguard-proof-rail-mobile.svg` | Derived motif | Light | None | 120 px wide |
| 12 | `routeguard-favicon.svg` | Logo | Any | None | 16 × 16 |
| 13 | `routeguard-app-icon.svg` | Logo | Own canvas | None | 192 × 192 |
| 14 | `routeguard-social-card.svg` | Composite | Own canvas | Yes | 1200 × 630 |
| 15 | `routeguard-video-title.svg` | Composite | Own canvas | Yes | 1920 × 1080 |

---

## 01 — `routeguard-full-lockup-light.svg`
- **viewBox** 0 0 1304 328 · transparent
- **Purpose** Formal full lockup — the primary identity.
- **Permitted** Homepage identity area, formal product introduction, presentations, video titles, social graphics, selected footer applications.
- **Prohibited** Charcoal or photographic backgrounds; navigation bars (use 03); sizes under 320 px wide, where the descriptor closes up.
- **Background** Light only (`#F4F4F4`–`#FFFFFF`).
- **Text** RouteGuard + FREIGHT EXCHANGE, outlined.
- **Type** Logo.

## 02 — `routeguard-full-lockup-dark.svg`
- **viewBox** 0 0 1304 328 · transparent
- **Purpose** Reverse of 01, identical geometry.
- **Permitted** Charcoal backgrounds, dark presentation openers, dark footers, video titles.
- **Prohibited** Light backgrounds; mid-tone backgrounds where near-white loses contrast; recoloring the green.
- **Background** Charcoal `#101820` or darker.
- **Text** RouteGuard + FREIGHT EXCHANGE, outlined.
- **Type** Logo.

## 03 — `routeguard-compact-header-light.svg`
- **viewBox** 0 0 1253 328 · transparent
- **Purpose** Compact lockup — symbol plus wordmark, verified route shortened so the terminal node closes at the right edge of RouteGuard. No descriptor.
- **Permitted** Desktop navigation, sticky headers, proof-page headers, operations-console sidebar.
- **Prohibited** Formal introductions and social graphics (use 01); adding the descriptor back at this width.
- **Background** Light.
- **Text** RouteGuard, outlined.
- **Type** Logo.

## 04 — `routeguard-compact-header-dark.svg`
- **viewBox** 0 0 1253 328 · transparent
- **Purpose** Reverse of 03.
- **Permitted** Charcoal navigation, dark proof headers, dark application sidebars.
- **Prohibited** Light backgrounds.
- **Background** Charcoal.
- **Text** RouteGuard, outlined.
- **Type** Logo.

## 05 — `routeguard-symbol.svg`
- **viewBox** 0 0 501 328 · transparent
- **Purpose** Standalone symbol: gateway, origin node, three waypoints, checkmark, short verified exit (terminal node at x 480), terminal node. Not a crop of the lockup — the verified route is intentionally shortened.
- **Permitted** App icon source, mobile navigation, collapsed sidebar, branded empty states, avatar and repository identity.
- **Prohibited** Any functional or status role — see *Identity, not status* below. Sizes under 64 px wide (use 06).
- **Background** Any with sufficient contrast.
- **Text** None.
- **Type** Logo.

## 06 — `routeguard-symbol-small.svg`
- **viewBox** 0 0 501 328 · transparent
- **Purpose** Separate optical size for 16–48 px: origin node, two waypoints (third dropped), checkmark, short verified exit. The standard symbol is untouched.
- **Permitted** 16–48 px UI placements, favicons, dense table and list rows, browser tabs.
- **Prohibited** Large-scale use (above 48 px, use 05); reintroducing the third waypoint.
- **Background** Any with sufficient contrast.
- **Text** None.
- **Type** Logo.

## 07 — `routeguard-full-lockup-monochrome.svg`
- **viewBox** 0 0 1304 328 · transparent
- **Purpose** One flat charcoal `#0E243A` lockup; the inbound → checkpoint → verified process stays legible through geometry and stroke weight alone, with no green.
- **Permitted** Single-color print, engraving, fax-grade documents, watermarks, legal and compliance packets.
- **Prohibited** Any partial recoloring; reintroducing green to one element only; use where full color is available.
- **Background** Light or neutral.
- **Text** RouteGuard + FREIGHT EXCHANGE, outlined.
- **Type** Logo.

## 08 — `routeguard-full-lockup-white.svg`
- **viewBox** 0 0 1304 328 · transparent
- **Purpose** One flat white lockup for dark backgrounds and single-color production.
- **Permitted** Dark backgrounds, photographic backgrounds with a controlled dark area, single-color reverse printing, merchandise.
- **Prohibited** Light backgrounds; adding a shadow, glow or outline to force contrast — darken the background instead.
- **Background** Dark.
- **Text** RouteGuard + FREIGHT EXCHANGE, outlined.
- **Type** Logo.

## 09 — `routeguard-trust-lane-horizontal.svg`
- **viewBox** 0 0 1304 328 · transparent
- **Purpose** Derived process motif: dotted inbound route → controlled checkpoint → verification → solid confirmed route → terminal state, at full route length and without any wordmark.
- **Permitted** "How it works", settlement-before-reservation proof, architecture sections, section transitions, process timelines.
- **Prohibited** Any use as a logo, in a header, as an avatar, or beside the wordmark where it would read as a second mark. Never label it "RouteGuard".
- **Background** Light.
- **Text** None.
- **Type** Derived motif — not a logo.

## 10 — `routeguard-route-divider.svg`
- **viewBox** 0 0 700 60 · transparent
- **Purpose** Restrained divider — master geometry at 35%: short dotted inbound segment, small verification pivot, solid confirmed segment with terminal node. No gateway, no wordmark.
- **Permitted** Section dividers, card-group transitions, proof-section heading accents.
- **Prohibited** Enlarging it to logo scale; stacking several per screen; use as a loading or progress indicator.
- **Background** Light.
- **Text** None.
- **Type** Derived motif — not a logo.

## 11 — `routeguard-proof-rail-mobile.svg`
- **viewBox** 0 0 328 541 · transparent
- **Purpose** Vertical adaptation of the process motif for mobile: inbound state → checkpoint (master gateway turned to face the vertical route, checkmark upright) → verified settlement → confirmed reservation.
- **Permitted** Mobile proof flows, vertical process explainers, step rails beside mobile copy.
- **Prohibited** Any logo use; rotating the lockup or the wordmark; presenting it as the RouteGuard mark.
- **Background** Light.
- **Text** None.
- **Type** Derived motif — not a logo.

## 12 — `routeguard-favicon.svg`
- **viewBox** 0 0 512 512 · transparent
- **Purpose** Favicon mark derived from the small-size symbol — gateway and verification checkmark only, squared for the 1:1 slot. Rendered previews: `routeguard-favicon-16.png`, `-32.png`, `-48.png`.
- **Permitted** Browser favicon (16 / 32 / 48), browser tab, bookmark, PWA small icon.
- **Prohibited** Use above 48 px as a brand mark; adding the wordmark; adding a background plate.
- **Background** Transparent; sits on browser chrome.
- **Text** None.
- **Type** Logo.

## 13 — `routeguard-app-icon.svg`
- **viewBox** 0 0 1024 1024 · explicit neutral canvas `#F4F4F4`
- **Purpose** Standalone symbol centred on a neutral square application canvas. No gradient, shadow or glass effect.
- **Safe area** Content occupies 720 × 720 (70.3% of the canvas), centred: 135 px at 192, 360 px at 512, 720 px at 1024. Guides ship in the hidden group `routeguard-app-icon-safe-area`.
- **Permitted** App stores, PWA manifest icons, desktop shortcuts, repository avatars.
- **Prohibited** Extending artwork into the safe-area margin; rounding or masking the canvas yourself (the platform does it); swapping the canvas for a brand color.
- **Background** Own canvas.
- **Text** None.
- **Type** Logo.

## 14 — `routeguard-social-card.svg`
- **viewBox** 0 0 1200 630 · explicit canvas `#F4F4F4`
- **Purpose** Open Graph / social card: full lockup, the line "Settlement-backed freight reservations", a restrained route motif, and "BUILT USING THE HEDERA NETWORK".
- **Permitted** Open Graph and Twitter card images, link previews, blog headers.
- **Prohibited** Placing the Hedera logo beside the RouteGuard logo; adding customer logos, partner claims, routes, vehicles or any data; editing the claim line to something unverified.
- **Background** Own canvas.
- **Text** Yes — all outlined.
- **Type** Composite application of the lockup.

## 15 — `routeguard-video-title.svg`
- **viewBox** 0 0 1920 1080 · explicit canvas `#101820`
- **Purpose** Video title: reverse lockup, subtitle "Live x402 Hedera testnet demonstration", restrained horizontal trust lane.
- **Permitted** Demo recording title cards, conference video openers, screen-recording intros.
- **Prohibited** Any fictional content, invented metrics, or partner marks; using it as a slide template.
- **Background** Own canvas.
- **Text** Yes — all outlined.
- **Type** Composite application of the lockup.

---

## Identity, not status

The RouteGuard symbol represents product identity. It must **not** become a generic status
icon. Do not use it as the icon for payment success, HCS confirmation, settlement,
evidence, audit or security — those need separate functional icons. The derived motifs
(09, 10, 11) explain the process; they are not marks and are never labelled as the logo.

## Clear space and minimum sizes

Clear space on all sides: the height of the gateway's stroke (32 units in master scale,
≈ 10% of the artwork height). Minimum sizes are listed per asset above; below them the
descriptor and waypoint dots close up.

## Not yet produced

Animated variants, merchandise lockups, stacked (vertical) lockup, and localized
descriptor versions. Ask before deriving them.
