import React from 'react';
import { Download, FileCode } from 'lucide-react';
import { downloadEvidenceJson, getRouteGuardEvidence } from '../data/routeguardEvidence';

interface EvidenceDownloadButtonProps {
  className?: string;
  variant?: 'primary' | 'secondary' | 'dark';
}

export const EvidenceDownloadButton: React.FC<EvidenceDownloadButtonProps> = ({
  className = '',
  variant = 'secondary',
}) => {
  const evidence = getRouteGuardEvidence();

  const handleDownload = () => {
    downloadEvidenceJson(evidence);
  };

  const baseClasses =
    'h-11 px-5 rounded-[10px] font-montserrat font-semibold text-xs tracking-wider uppercase inline-flex items-center justify-center gap-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] cursor-pointer';

  const variantClasses = {
    primary: 'bg-[#000000] text-white hover:bg-[#222222]',
    secondary: 'bg-white border border-[#DDE1E6] text-[#15171A] hover:bg-[#F1F3F5]',
    dark: 'bg-[#181C24] border border-[#2E3132] text-white hover:bg-[#2E3132]',
  }[variant];

  return (
    <button
      onClick={handleDownload}
      type="button"
      className={`${baseClasses} ${variantClasses} ${className}`}
      title="Download verifiable evidence JSON payload"
    >
      <FileCode className="w-4 h-4 text-[#2D84EB]" />
      <span>Download Evidence JSON</span>
      <Download className="w-4 h-4 opacity-70" />
    </button>
  );
};
