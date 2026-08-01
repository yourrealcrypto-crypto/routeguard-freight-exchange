import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyableIdentifierProps {
  value: string | null;
  label?: string;
  truncate?: boolean;
  className?: string;
}

export const CopyableIdentifier: React.FC<CopyableIdentifierProps> = ({
  value,
  label,
  truncate = false,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <div className={`text-[#8A8F98] italic text-xs font-technical ${className}`}>
        [Not available]
      </div>
    );
  }

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayValue = truncate && value.length > 24
    ? `${value.substring(0, 12)}...${value.substring(value.length - 10)}`
    : value;

  return (
    <div className={`inline-flex flex-col gap-1 max-w-full ${className}`}>
      {label && (
        <span className="font-montserrat text-[11px] font-semibold text-[#8A8F98] uppercase tracking-wider">
          {label}
        </span>
      )}
      <div className="inline-flex items-center gap-2 bg-[#F1F3F5] dark:bg-[#181C24] px-2.5 py-1.5 rounded border border-[#DDE1E6] dark:border-[#2E3132] max-w-full">
        <code className="font-technical text-xs md:text-[13px] text-[#15171A] dark:text-[#DFE2EE] break-all select-all">
          {displayValue}
        </code>
        <button
          onClick={handleCopy}
          type="button"
          aria-label={`Copy ${label || 'identifier'}`}
          className="p-1 rounded text-[#60646C] hover:text-[#15171A] dark:hover:text-white transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-[#0031FF]"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-[#168A4A]" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
};
