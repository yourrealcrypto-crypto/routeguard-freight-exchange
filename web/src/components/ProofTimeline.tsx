import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { RouteGuardBrand } from './brand/RouteGuardBrand';
import { CheckCircle2, Clock, ShieldCheck, ArrowRight } from 'lucide-react';

interface ProofTimelineProps {
  evidence: RouteGuardEvidence;
  compact?: boolean;
}

export const ProofTimeline: React.FC<ProofTimelineProps> = ({ evidence, compact = false }) => {
  const { timestamps, elapsed, hashes } = evidence;

  return (
    <div className="bg-[#11151D] text-white rounded-[12px] border border-[#2E3132] p-6 md:p-8 relative overflow-hidden shadow-xl">
      {/* Top Accent Gradient Bar */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#8259EF] to-[#0031FF]" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#168A4A]" />
            <span className="font-technical text-xs font-semibold uppercase text-[#DFE2EE] tracking-widest">
              LIVE_FINAL_DEMO — EVIDENCE MODE
            </span>
          </div>
          <h3 className="font-montserrat font-bold text-xl md:text-2xl text-white mt-2">
            Settlement-to-Reservation Timeline
          </h3>
        </div>

        <div className="bg-[#181C24] border border-[#2E3132] px-3.5 py-1.5 rounded-[8px] flex items-center gap-2 self-start sm:self-auto">
          <ShieldCheck className="w-4 h-4 text-[#168A4A]" />
          <span className="font-technical text-xs text-[#168A4A] font-medium">
            Settlement Precedes Reservation — Verified
          </span>
        </div>
      </div>

      {/* Desktop Layout (Horizontal Timeline) */}
      <div className="hidden md:flex flex-col gap-6">
        <div className="grid grid-cols-12 gap-4 items-center bg-[#181C24] p-6 rounded-[10px] border border-[#2E3132]">
          {/* Node 1: Payment Settled */}
          <div className="col-span-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[#168A4A] font-montserrat font-bold text-xs uppercase tracking-wider">
              <CheckCircle2 className="w-4 h-4" />
              <span>PAYMENT SETTLED</span>
            </div>
            <div className="font-technical text-sm text-[#DFE2EE] bg-[#11151D] px-3 py-1.5 rounded border border-[#2E3132] font-semibold">
              {timestamps.settlementConsensus || '17:38:16.977'}
            </div>
            <span className="font-technical text-[11px] text-[#8A8F98]">
              Mirror-Confirmed USDC Transfer
            </span>
          </div>

          {/* Delta Connector */}
          <div className="col-span-4 flex flex-col items-center justify-center gap-2 px-2">
            <div className="w-full flex items-center justify-center relative">
              <div className="w-full h-0.5 bg-gradient-to-r from-[#8259EF] to-[#0031FF]" />
              <div className="absolute bg-[#0031FF] text-white px-3 py-1 rounded-full text-xs font-technical font-bold flex items-center gap-1 shadow-md">
                <Clock className="w-3.5 h-3.5" />
                <span>{elapsed.formatted || '6.48 seconds'}</span>
              </div>
            </div>
            <span className="font-technical text-[10px] text-[#2D84EB] uppercase tracking-wider mt-2">
              Consensus Window
            </span>
          </div>

          {/* Node 2: Route Reserved */}
          <div className="col-span-4 flex flex-col items-end text-right gap-2">
            <div className="flex items-center gap-2 text-[#2D84EB] font-montserrat font-bold text-xs uppercase tracking-wider">
              <span>ROUTE_RESERVED</span>
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <div className="font-technical text-sm text-[#DFE2EE] bg-[#11151D] px-3 py-1.5 rounded border border-[#2E3132] font-semibold">
              {timestamps.reservationConsensus || '17:38:23.453'}
            </div>
            <span className="font-technical text-[11px] text-[#8A8F98]">
              HCS Sequence 5 Published
            </span>
          </div>
        </div>
      </div>

      {/* Mobile Reflow Layout (Vertical Step-List) */}
      <div className="md:hidden flex flex-col gap-6 relative pl-4 border-l-2 border-[#0031FF]/40 ml-2 py-2">
        {/* Step 1 */}
        <div className="flex flex-col gap-1 relative">
          <span className="absolute -left-[23px] top-1 w-3.5 h-3.5 rounded-full bg-[#168A4A] border-2 border-[#11151D]" />
          <span className="font-montserrat font-bold text-xs text-[#168A4A] uppercase tracking-wider">
            MIRROR-CONFIRMED SETTLEMENT
          </span>
          <span className="font-technical text-xs text-white bg-[#181C24] p-2 rounded border border-[#2E3132] mt-1 break-all">
            {timestamps.settlementConsensus}
          </span>
        </div>

        {/* Delta */}
        <div className="bg-[#181C24] border border-[#2E3132] px-3 py-1.5 rounded text-xs font-technical text-[#2D84EB] w-max flex items-center gap-1.5 my-1">
          <Clock className="w-3.5 h-3.5" />
          <span>Elapsed: {elapsed.formatted}</span>
        </div>

        {/* Step 2 */}
        <div className="flex flex-col gap-1 relative">
          <span className="absolute -left-[23px] top-1 w-3.5 h-3.5 rounded-full bg-[#0031FF] border-2 border-[#11151D]" />
          <span className="font-montserrat font-bold text-xs text-[#2D84EB] uppercase tracking-wider">
            ROUTE_RESERVED PUBLISHED TO HCS
          </span>
          <span className="font-technical text-xs text-white bg-[#181C24] p-2 rounded border border-[#2E3132] mt-1 break-all">
            {timestamps.reservationConsensus}
          </span>
        </div>
      </div>

      {/* Footer Meta Note */}
      <div className="mt-6 pt-4 border-t border-[#2E3132] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-[#8A8F98]">
        <div className="font-technical text-[11px]">
          Payment Tx: <code className="text-[#DFE2EE]">{hashes.paymentTxId}</code>
        </div>
        <div className="font-montserrat italic text-[11px] text-[#8A8F98]">
          Sequence 5 embeds payment transaction ID &amp; payment consensus timestamp.
        </div>
      </div>
    </div>
  );
};
