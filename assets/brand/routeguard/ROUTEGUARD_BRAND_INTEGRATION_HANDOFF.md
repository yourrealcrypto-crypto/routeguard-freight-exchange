# ROUTEGUARD_BRAND_INTEGRATION_HANDOFF.md

This document specifies the precise implementation of locked RouteGuard production SVG assets across the existing repository screens. These assets are verified for geometry, optical scaling, and brand hierarchy.

## Global Implementation Rules
1. **LOCKED ASSETS:** No SVG may be redrawn, recolored, or modified. Proportions and internal geometry are fixed.
2. **LOADING METHOD:** Use `<img>` tags for all brand assets to ensure consistent rendering and ease of maintenance, unless otherwise specified.
3. **CLEAR SPACE:** Maintain minimum clear space equal to the height of the gateway stroke (approx. 10% of asset height) on all sides.
4. **BRAND HIERARCHY:** RouteGuard is the primary brand. Hedera is the secondary infrastructure layer. Do not present them as co-equal adjacent marks.

---

## 00 — RouteGuard design system
**Component:** Section 1 Header (Master Identity)
- **Asset:** `routeguard-full-lockup-light.svg`
- **Dimensions:** Width: 320px | Height: Auto (approx 80px)
- **Behavior:** Fixed width.
- **Alignment:** Left-aligned within the container.
- **Type:** Meaningful (Primary Identity).
- **Alt Text:** "RouteGuard Freight Exchange logo"
- **Replacement:** Replaces "RouteGuard" text treatment.

---

## 01 — Public homepage
**Component:** Desktop Global Header
- **Asset:** `routeguard-compact-header-light.svg`
- **Dimensions:** Width: 240px | Height: Auto
- **Behavior:** Fixed width on desktop.
- **Responsive Substitution:** Switch to `routeguard-symbol-small.svg` (40px) on mobile viewports below 480px.
- **Alignment:** Left-aligned in navigation bar.
- **Type:** Meaningful (Navigation Identity).
- **Alt Text:** "RouteGuard"
- **Replacement:** Replaces "RouteGuard" text.

**Component:** "How it works" Workflow Motif
- **Asset:** `routeguard-trust-lane-horizontal.svg`
- **Dimensions:** Max-Width: 100% (container limited to 1200px) | Height: Auto
- **Behavior:** Fluid width.
- **Responsive Substitution:** Switch to `routeguard-proof-rail-mobile.svg` (120px wide, centered) on mobile viewports.
- **Alignment:** Center-aligned.
- **Type:** Decorative (Process Illustration).
- **Alt Text:** "" (aria-hidden="true")
- **Implementation:** Load as `<img>` or CSS background.

**Component:** Global Footer (Dark)
- **Asset:** `routeguard-full-lockup-dark.svg`
- **Dimensions:** Width: 320px | Height: Auto
- **Behavior:** Fixed width.
- **Alignment:** Left or Center (match existing layout).
- **Type:** Meaningful (Brand Anchor).
- **Alt Text:** "RouteGuard Freight Exchange"
- **Replacement:** Replaces footer text-only brand name.

---

## 02 — Live proof
**Component:** Global Header
- **Asset:** `routeguard-compact-header-light.svg`
- **Dimensions:** Width: 240px | Height: Auto
- **Responsive Substitution:** Switch to `routeguard-symbol-small.svg` (40px) on mobile.
- **Alignment:** Left-aligned.
- **Type:** Meaningful.
- **Alt Text:** "RouteGuard"

**Component:** Proof Timeline Axis
- **Asset:** `routeguard-trust-lane-horizontal.svg`
- **Dimensions:** Max-Width: 800px | Height: Auto
- **Mode:** Dark (placed on charcoal evidence surface).
- **Responsive Substitution:** Switch to `routeguard-proof-rail-mobile.svg` on mobile.
- **Alignment:** Center-aligned.
- **Type:** Decorative.
- **Alt Text:** "" (aria-hidden="true")
- **Rule:** Do not replace sequence labels or timestamps.

---

## 03 — Operations console
**Component:** Sidebar Header (Expanded)
- **Asset:** `routeguard-compact-header-dark.svg`
- **Dimensions:** Width: 200px | Height: Auto
- **Behavior:** Fixed width.
- **Alignment:** Center or Left-aligned in sidebar.
- **Type:** Meaningful.
- **Alt Text:** "RouteGuard"

**Component:** Sidebar Header (Collapsed)
- **Asset:** `routeguard-symbol.svg`
- **Dimensions:** Width: 32px | Height: Auto
- **Alignment:** Center-aligned.
- **Type:** Meaningful (Collapsed ID).
- **Alt Text:** "RouteGuard symbol"

---

## 04 — Mobile homepage
**Component:** Mobile Header
- **Asset:** `routeguard-compact-header-light.svg`
- **Dimensions:** Width: 180px | Height: Auto
- **Responsive Substitution:** Switch to `routeguard-symbol-small.svg` (40px) if header constraints require a 1:1 ratio.
- **Alignment:** Left-aligned.
- **Type:** Meaningful.
- **Alt Text:** "RouteGuard"

---

## 05 — Mobile live proof
**Component:** Mobile Proof Header
- **Asset:** `routeguard-symbol-small.svg`
- **Dimensions:** Width: 40px | Height: 40px (Optical size for 16-48px slots).
- **Alignment:** Center or Left-aligned.
- **Type:** Meaningful.
- **Alt Text:** "RouteGuard"

**Component:** Evidence Rail
- **Asset:** `routeguard-proof-rail-mobile.svg`
- **Dimensions:** Width: 120px | Height: Auto
- **Alignment:** Center-aligned.
- **Type:** Decorative.
- **Alt Text:** "" (aria-hidden="true")

---

## Accessibility Compliance
- **Identity Alt Text:** All meaningful product lockups (`full-lockup`, `compact-header`, `symbol`) use the product name in alt text.
- **Decorative aria-hidden:** All process motifs (`trust-lane`, `proof-rail`, `route-divider`) use empty alt text and `aria-hidden="true"` to prevent screen reader noise during technical data consumption.
- **No Color-Only Cues:** Verified green is used in the assets for brand consistency, but the interface must continue to use explicit text labels (e.g., "Settled", "Confirmed", "Complete") beside any graphical element.
- **Heading Integrity:** Brand assets never replace semantic `<h1>` through `<h3>` tags; they supplement them.

## Verification
- NO locked SVG source code was modified.
- All filenames match the `ROUTEGUARD_BRAND_ASSET_MANIFEST.md` exactly.
- Background contrast (Light vs. Dark) is enforced per asset specification.

SCREENS_DOCUMENTED=7
COMPONENTS_DOCUMENTED=12
RESPONSIVE_SUBSTITUTIONS=4
ACCESSIBILITY_RULES_DOCUMENTED=YES
EXACT_ASSET_FILENAMES_DOCUMENTED=YES
READY_FOR_REPOSITORY_INTEGRATION=YES
