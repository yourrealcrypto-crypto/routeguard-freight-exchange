import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { CopyableIdentifier } from './CopyableIdentifier';
import { ExternalExplorerLink } from './ExternalExplorerLink';
import { Shield, CheckCircle2, Gavel, Award } from 'lucide-react';

interface EvidenceCardProps {
  evidence: RouteGuardEvidence;
  variant?: 'logistics' | 'decision' | 'dark-evidence';
}

export const EvidenceCard: React.FC<EvidenceCardProps> = ({
  evidence,
  variant = 'logistics',
}) => {
  const { auction, winner, hashes, topic } = evidence;

  if (variant === 'dark-evidence') {
    return (
      <div className="bg-[#11151D] text-white rounded-[10px] p-6 border-l-4 border-l-[#8259EF] relative overflow-hidden shadow-lg flex flex-col justify-between gap-6">
        <div className="flex items-center justify-between border-b border-[#2E3132] pb-3">
          <div className="flex items-center gap-2 text-[#2D84EB]">
            <Shield className="w-4 h-4" />
            <span className="font-technical text-xs uppercase tracking-wider font-semibold">
              Cryptographic Proof Layer
            </span>
          </div>
          <span className="px-2 py-0.5 bg-[#168A4A] text-white rounded text-[10px] font-technical uppercase font-bold">
            SETTLED
          </span>
        </div>

        <div className="flex flex-col gap-3 font-technical text-xs text-[#DFE2EE]">
          <div className="flex justify-between border-b border-[#2E3132] pb-2">
            <span className="text-[#8A8F98]">Sequence:</span>
            <span className="font-bold text-white">5 (ROUTE_RESERVED)</span>
          </div>
          <div className="flex justify-between border-b border-[#2E3132] pb-2">
            <span className="text-[#8A8F98]">Consensus Timestamp:</span>
            <span className="text-white">2026-07-27T17:38:23.453Z</span>
          </div>
          <div className="flex flex-col gap-1 pt-1">
            <span className="text-[#8A8F98] text-[11px] uppercase">HCS Topic ID:</span>
            <CopyableIdentifier value={topic.topicId} />
          </div>
        </div>

        <div className="pt-3 border-t border-[#2E3132] flex items-center justify-between">
          <span className="font-montserrat text-xs text-[#168A4A] font-semibold flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Settlement Precedes Reservation
          </span>
          <ExternalExplorerLink type="topic" id={topic.topicId} label="HashScan" variant="dark" />
        </div>
      </div>
    );
  }

  if (variant === 'decision') {
    return (
      <div className="bg-white rounded-[10px] p-6 border border-[#DDE1E6] shadow-sm flex flex-col justify-between gap-6">
        <div className="flex justify-between items-start border-b border-[#DDE1E6] pb-3">
          <div className="flex items-center gap-2">
            <Gavel className="w-4 h-4 text-[#0031FF]" />
            <h3 className="font-montserrat font-bold text-lg text-[#15171A]">Decision Engine</h3>
          </div>
          <span className="px-2.5 py-1 bg-[#F1F3F5] border border-[#DDE1E6] rounded text-[10px] font-technical text-[#60646C] uppercase font-semibold">
            {winner.decisionEngineType || 'DETERMINISTIC'}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <span className="font-montserrat text-[11px] font-semibold text-[#8A8F98] uppercase block mb-1">
              Selected Carrier Capacity
            </span>
            <span className="font-technical text-sm font-bold text-[#15171A] bg-[#F1F3F5] px-2.5 py-1 rounded inline-block border border-[#DDE1E6]">
              {winner.selectedCarrier || 'carrier-alpha'}
            </span>
          </div>

          <div>
            <span className="font-montserrat text-[11px] font-semibold text-[#8A8F98] uppercase block mb-1">
              Evaluation Result
            </span>
            <div className="flex items-center gap-1.5 text-[#168A4A] font-montserrat font-bold text-xs">
              <Award className="w-4 h-4" />
              <span>{winner.resultStatus || 'QUALIFIED · WINNER'}</span>
            </div>
          </div>

          <div className="pt-3 border-t border-[#DDE1E6] flex flex-col gap-2">
            <div>
              <span className="font-montserrat text-[11px] text-[#8A8F98] block">
                Decision Manifest Hash:
              </span>
              <code className="font-technical text-xs text-[#60646C] break-all">
                {hashes.decisionManifestHash}
              </code>
            </div>
            <div>
              <span className="font-montserrat text-[11px] text-[#8A8F98] block">
                Evaluated Bid Set Hash:
              </span>
              <code className="font-technical text-xs text-[#60646C] break-all">
                {hashes.evaluatedBidSetHash}
              </code>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Logistics Tender Card Default
  return (
    <div className="bg-white rounded-[10px] p-6 border border-[#DDE1E6] shadow-sm flex flex-col justify-between gap-6">
      <div className="flex justify-between items-start border-b border-[#DDE1E6] pb-3">
        <div>
          <span className="font-montserrat text-[11px] font-semibold text-[#8A8F98] uppercase block">
            Operational Status
          </span>
          <h3 className="font-montserrat font-bold text-xl text-[#15171A] mt-0.5">
            {auction.tenderId || 'Tender #4091'}
          </h3>
        </div>
        <span className="px-2.5 py-1 bg-[#168A4A] text-white rounded font-technical text-[10px] uppercase font-bold tracking-wider">
          {auction.status || 'CLOSED'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 font-technical text-xs text-[#60646C]">
        <div>
          <span className="text-[#8A8F98] block text-[10px] uppercase">Route:</span>
          <span className="font-semibold text-[#15171A]">{auction.routeOrigin} &gt; {auction.routeDestination}</span>
        </div>
        <div>
          <span className="text-[#8A8F98] block text-[10px] uppercase">Volume:</span>
          <span className="font-semibold text-[#15171A]">{auction.equipmentType}</span>
        </div>
        <div>
          <span className="text-[#8A8F98] block text-[10px] uppercase">Departure:</span>
          <span className="font-semibold text-[#15171A]">{auction.departureDate}</span>
        </div>
        <div>
          <span className="text-[#8A8F98] block text-[10px] uppercase">Total Offers:</span>
          <span className="font-semibold text-[#15171A]">{auction.totalCarrierOffers}</span>
        </div>
      </div>

      <div className="pt-2 border-t border-[#DDE1E6] flex items-center justify-between text-xs font-montserrat text-[#60646C]">
        <span>Winner: <strong className="font-technical text-[#15171A]">{winner.selectedCarrier}</strong></span>
        <span className="text-[#168A4A] font-semibold">Settlement Verified</span>
      </div>
    </div>
  );
};
