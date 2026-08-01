import React, { useState } from 'react';
import { HEDERA_BRAND_ASSETS } from '../../config/brandAssets';

interface HederaAttributionProps {
  variant?: "header" | "section";
  dark?: boolean;
  className?: string;
}

export const HederaAttribution: React.FC<HederaAttributionProps> = ({
  variant = 'header',
  dark = false,
  className = ''
}) => {
  const [imageError, setImageError] = useState(false);

  const wrapperClass = variant === 'header'
    ? 'w-[18px] h-[18px] min-w-[18px] max-w-[18px] flex-none aspect-square'
    : 'w-[22px] h-[22px] min-w-[22px] max-w-[22px] flex-none aspect-square';

  const baseText = variant === 'header'
    ? 'text-[11px] uppercase tracking-wider font-technical font-bold transition-colors'
    : 'text-xs uppercase tracking-wider font-technical font-bold transition-colors';

  const textClass = `${baseText} ${dark ? 'text-[#8A8F98] group-hover:text-white' : 'text-[#60646C] group-hover:text-[#15171A]'}`;
  const hoverBg = dark ? 'hover:bg-[#2E3132]' : 'hover:bg-[#F1F3F5]';

  return (
    <a
      href="https://hedera.com/"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Learn more about Hedera"
      className={`inline-flex items-center gap-[8px] w-fit flex-none rounded px-1.5 py-1 -mx-1.5 transition-colors group ${hoverBg} ${className}`}
    >
      {!imageError && (
        <div className={wrapperClass}>
          <img
            src={HEDERA_BRAND_ASSETS.logomark}
            alt="Hedera"
            onError={() => setImageError(true)}
            className="w-full h-full object-contain object-center block"
          />
        </div>
      )}
      <span className={textClass}>BUILT ON HEDERA</span>
    </a>
  );
};
