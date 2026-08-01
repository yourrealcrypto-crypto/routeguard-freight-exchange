import React, { useState } from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { ChevronDown, ChevronUp, Cpu, CheckCircle } from 'lucide-react';

interface ProtocolDetailsProps {
  evidence: RouteGuardEvidence;
}

export const ProtocolDetails: React.FC<ProtocolDetailsProps> = ({ evidence }) => {
  const [isOpen, setIsOpen] = useState(true);
  const { payment, token, parties } = evidence;

  return (
    <div className="bg-[#F1F3F5] dark:bg-[#181C24] border border-[#DDE1E6] dark:border-[#2E3132] rounded-[10px] p-5 md:p-6 transition-all">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between font-montserrat font-bold text-sm text-[#15171A] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0031FF] rounded p-1"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2.5">
          <Cpu className="w-4 h-4 text-[#2D84EB]" />
          <span>x402 Protocol &amp; Technical Parameters</span>
        </div>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-[#8A8F98]" />
        ) : (
          <ChevronDown className="w-4 h-4 text-[#8A8F98]" />
        )}
      </button>

      {isOpen && (
        <div className="mt-4 pt-4 border-t border-[#DDE1E6] dark:border-[#2E3132] flex flex-col gap-4 font-technical text-xs">
          <div className="grid grid-cols-2 gap-y-3 gap-x-4 bg-white dark:bg-[#11151D] p-4 rounded border border-[#DDE1E6] dark:border-[#2E3132]">
            <span className="text-[#8A8F98]">x402 Spec Version:</span>
            <span className="text-right text-[#15171A] dark:text-[#DFE2EE] font-bold">2</span>

            <span className="text-[#8A8F98]">Payment Scheme:</span>
            <span className="text-right text-[#15171A] dark:text-[#DFE2EE] font-bold">exact</span>

            <span className="text-[#8A8F98]">Network Namespace:</span>
            <span className="text-right text-[#2D84EB] font-bold">{token.network || 'hedera:testnet'}</span>

            <span className="text-[#8A8F98]">Asset Token ID:</span>
            <span className="text-right text-[#15171A] dark:text-[#DFE2EE]">{token.tokenId || '0.0.429274'}</span>

            <span className="text-[#8A8F98]">Atomic Amount:</span>
            <span className="text-right text-[#15171A] dark:text-[#DFE2EE] font-bold">
              {payment.amountAtomic || '10000 atomic USDC'}
            </span>

            <span className="text-[#8A8F98]">Pay To Account:</span>
            <span className="text-right text-[#15171A] dark:text-[#DFE2EE] break-all">
              {parties.receiverAccountId || '0.0.9215954'}
            </span>
          </div>

          <div className="bg-white dark:bg-[#11151D] p-4 rounded border border-[#DDE1E6] dark:border-[#2E3132] flex flex-col gap-2">
            <span className="font-montserrat font-semibold text-[11px] text-[#8A8F98] uppercase">
              Orchestration Lifecycle
            </span>
            <div className="flex flex-col gap-1.5 border-l-2 border-[#2D84EB] pl-3">
              <div className="flex justify-between items-center text-[#15171A] dark:text-[#DFE2EE]">
                <span>1. x402 v2 exact payload</span>
                <CheckCircle className="w-3.5 h-3.5 text-[#168A4A]" />
              </div>
              <div className="flex justify-between items-center text-[#15171A] dark:text-[#DFE2EE]">
                <span>2. Facilitator verify</span>
                <CheckCircle className="w-3.5 h-3.5 text-[#168A4A]" />
              </div>
              <div className="flex justify-between items-center text-[#15171A] dark:text-[#DFE2EE]">
                <span>3. Direct Settlement</span>
                <CheckCircle className="w-3.5 h-3.5 text-[#168A4A]" />
              </div>
              <div className="flex justify-between items-center text-[#15171A] dark:text-[#DFE2EE]">
                <span>4. Mirror confirmation</span>
                <CheckCircle className="w-3.5 h-3.5 text-[#168A4A]" />
              </div>
              <div className="flex justify-between items-center font-bold text-[#2D84EB]">
                <span>5. ROUTE_RESERVED</span>
                <CheckCircle className="w-3.5 h-3.5 text-[#2D84EB]" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
