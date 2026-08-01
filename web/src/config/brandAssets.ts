/**
 * RouteGuard Freight Exchange - Production Brand Asset Paths
 * Centralized asset mapping as specified by ROUTEGUARD_BRAND_ASSET_MANIFEST.md
 */

export const ROUTEGUARD_BRAND_ASSETS = {
  compactHeaderLight: '/brand/routeguard/routeguard-compact-header-light.svg',
  compactHeaderDark: '/brand/routeguard/routeguard-compact-header-dark.svg',
  fullLockupLight: '/brand/routeguard/routeguard-full-lockup-light.svg',
  fullLockupDark: '/brand/routeguard/routeguard-full-lockup-dark.svg',
  symbol: '/brand/routeguard/routeguard-symbol.svg',
  symbolSmall: '/brand/routeguard/routeguard-symbol-small.svg',
  trustLaneHorizontal: '/brand/routeguard/routeguard-trust-lane-horizontal.svg',
  proofRailMobile: '/brand/routeguard/routeguard-proof-rail-mobile.svg',
  favicon: '/brand/routeguard/routeguard-favicon.svg',
} as const;

export type RouteGuardBrandVariant =
  | 'compact-light'
  | 'compact-dark'
  | 'full-light'
  | 'full-dark'
  | 'symbol'
  | 'symbol-small'
  | 'trust-lane'
  | 'proof-rail';

export const HEDERA_BRAND_ASSETS = {
  logomark: '/brand/hedera/hedera-logomark.svg',
} as const;
