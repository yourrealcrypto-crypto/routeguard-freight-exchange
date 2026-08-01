import React from 'react';
import { ExternalLink } from 'lucide-react';
import { getHashScanUrl } from '../data/routeguardEvidence';

interface ExternalExplorerLinkProps {
  type: 'topic' | 'tx' | 'account' | 'token';
  id: string | null;
  label?: string;
  className?: string;
  variant?: 'light' | 'dark' | 'button';
}

export const ExternalExplorerLink: React.FC<ExternalExplorerLinkProps> = ({
  type,
  id,
  label,
  className = '',
  variant = 'light',
}) => {
  if (!id) return null;

  const url = getHashScanUrl(type, id);
  const displayLabel = label || `${type.toUpperCase()}: ${id}`;

  if (variant === 'button') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`h-11 px-5 bg-transparent border border-[#DDE1E6] dark:border-[#76777C] text-[#15171A] dark:text-white font-montserrat font-semibold text-xs tracking-wider uppercase rounded-[10px] inline-flex items-center justify-center gap-2 hover:bg-[#F1F3F5] dark:hover:bg-[#2E3132] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] ${className}`}
      >
        <span>{displayLabel}</span>
        <ExternalLink className="w-4 h-4 text-[#2D84EB]" />
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 font-technical text-xs hover:underline focus:outline-none focus:ring-2 focus:ring-[#0031FF] rounded px-1 ${
        variant === 'dark' ? 'text-[#2D84EB]' : 'text-[#0031FF]'
      } ${className}`}
    >
      <span className="break-all">{displayLabel}</span>
      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
    </a>
  );
};
