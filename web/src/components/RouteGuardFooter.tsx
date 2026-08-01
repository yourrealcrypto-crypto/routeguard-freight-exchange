import React from 'react';
import { RouteGuardBrand } from './brand/RouteGuardBrand';

interface RouteGuardFooterProps {
  onNavigate?: (path: string) => void;
}

export const RouteGuardFooter: React.FC<RouteGuardFooterProps> = ({ onNavigate }) => {
  return (
    <footer className="w-full bg-[#11151D] text-white border-t border-[#2E3132] py-12 mt-auto">
      <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-8">
        {/* Top Row: Brand & Links */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 border-b border-[#2E3132] pb-8">
          <div className="flex flex-col gap-2">
            <RouteGuardBrand variant="full-dark" />
            <p className="font-montserrat text-xs text-[#8A8F98] max-w-md mt-2">
              Software-to-software freight capacity exchange with deterministic winner selection &amp; x402 settlement-backed confirmation.
            </p>
          </div>

          <nav className="flex flex-wrap gap-6 font-technical text-xs text-[#8A8F98]">
            {onNavigate && (
              <>
                <button
                  onClick={() => onNavigate('/')}
                  className="hover:text-white transition-colors focus:outline-none"
                >
                  Product
                </button>
                <button
                  onClick={() => onNavigate('/proof')}
                  className="hover:text-white transition-colors focus:outline-none"
                >
                  Live Proof
                </button>
                <button
                  onClick={() => onNavigate('/control')}
                  className="hover:text-white transition-colors focus:outline-none"
                >
                  Operations Demo
                </button>
                <button
                  onClick={() => onNavigate('/judge')}
                  className="hover:text-white transition-colors focus:outline-none"
                >
                  Judge Mode
                </button>
                <button onClick={() => onNavigate('/pod-review')} className="hover:text-white transition-colors focus:outline-none">
                  POD Review
                </button>
              </>
            )}
          </nav>
        </div>

        {/* Bottom Row: Hedera Network Attribution & Disclaimer */}
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 text-center md:text-left text-[#8A8F98] font-technical text-xs">
          <div className="flex flex-col md:flex-row items-center gap-3">
            <span className="font-montserrat font-semibold text-xs text-[#DFE2EE] uppercase tracking-wider">
              Built using the Hedera network
            </span>
            <span className="hidden md:inline text-[#2E3132]">|</span>
            <span className="text-xs text-[#2D84EB]">(hedera:testnet)</span>
          </div>

          <p className="max-w-xl text-[11px] leading-relaxed text-[#8A8F98]/80">
            RouteGuard is an independent project built on the Hedera network. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.
          </p>
        </div>
      </div>
    </footer>
  );
};
