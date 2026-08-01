import React from 'react';
import { ROUTEGUARD_BRAND_ASSETS, RouteGuardBrandVariant } from '../../config/brandAssets';

interface RouteGuardBrandProps {
  variant: RouteGuardBrandVariant;
  className?: string;
  alt?: string;
  ariaHidden?: boolean;
}

export const RouteGuardBrand: React.FC<RouteGuardBrandProps> = ({
  variant,
  className = '',
  alt,
  ariaHidden,
}) => {
  const isFull = variant === 'full-light' || variant === 'full-dark';
  const isSymbol = variant === 'symbol' || variant === 'symbol-small';
  const isTrustLane = variant === 'trust-lane';
  const isProofRail = variant === 'proof-rail';

  const assetPath = (() => {
    switch (variant) {
      case 'compact-light':
        return ROUTEGUARD_BRAND_ASSETS.compactHeaderLight;
      case 'compact-dark':
        return ROUTEGUARD_BRAND_ASSETS.compactHeaderDark;
      case 'full-light':
        return ROUTEGUARD_BRAND_ASSETS.fullLockupLight;
      case 'full-dark':
        return ROUTEGUARD_BRAND_ASSETS.fullLockupDark;
      case 'symbol':
        return ROUTEGUARD_BRAND_ASSETS.symbol;
      case 'symbol-small':
        return ROUTEGUARD_BRAND_ASSETS.symbolSmall;
      case 'trust-lane':
        return ROUTEGUARD_BRAND_ASSETS.trustLaneHorizontal;
      case 'proof-rail':
        return ROUTEGUARD_BRAND_ASSETS.proofRailMobile;
      default:
        return ROUTEGUARD_BRAND_ASSETS.compactHeaderLight;
    }
  })();

  const defaultAlt = isTrustLane || isProofRail
    ? ''
    : isFull
    ? 'RouteGuard Freight Exchange'
    : 'RouteGuard';

  const computedAlt = alt !== undefined ? alt : defaultAlt;
  const isDecorative = ariaHidden || computedAlt === '';

  return (
    <img
      src={assetPath}
      alt={computedAlt}
      aria-hidden={isDecorative}
      className={className || (isTrustLane ? 'w-full max-w-full h-auto' : isProofRail ? 'w-auto h-full max-h-full' : isSymbol ? (variant === 'symbol-small' ? 'h-7 w-auto' : 'h-9 w-auto') : 'h-8 md:h-9 w-auto shrink-0')}
      data-brand-asset={assetPath}
    />
  );
};
