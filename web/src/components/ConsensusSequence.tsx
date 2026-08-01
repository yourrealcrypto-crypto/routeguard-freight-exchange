import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { ExternalExplorerLink } from './ExternalExplorerLink';
import { CopyableIdentifier } from './CopyableIdentifier';
import { ShieldCheck } from 'lucide-react';

interface ConsensusSequenceProps {
  evidence: RouteGuardEvidence;
  variant?: string;
}

export const ConsensusSequence: React.FC<ConsensusSequenceProps> = ({ evidence }) => {
  const { messages, topic } = evidence;

  return (
    <div className="bg-[#11151D] text-white rounded-[10px] p-6 md:p-8 relative overflow-hidden border border-[#2E3132]">
      <div className="flex flex-col gap-2 mb-8">
        <h3 className="font-montserrat font-bold text-xl text-white">
          Proof of delivery on Hedera
        </h3>
        <p className="font-montserrat text-sm text-[#8A8F98]">
          One HCS topic records the ordered evidence from encrypted POD submission through shipper acceptance and final freight settlement.
        </p>
      </div>

      <div className="mb-10 font-technical text-[10px] text-[#8A8F98] uppercase font-bold tracking-widest">
        HCS TOPIC · {topic.topicId}
      </div>

      {/* Connected 5-step timeline */}
      <div className="flex flex-col relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-[#2E3132] before:via-[#0031FF] before:to-[#2E3132]">
        {messages.map((msg, index) => {
          return (
            <div key={msg.sequenceNumber} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active py-4">
              {/* Icon / Marker */}
              <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-[#11151D] bg-[#181C24] shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow z-10">
                <span className="font-technical text-sm font-bold text-[#0031FF]">{msg.sequenceNumber}</span>
              </div>

              {/* Card */}
              <div className={`w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-[8px] border border-[#2E3132] bg-[#181C24] flex flex-col gap-3 hover:border-[#0031FF]/50 transition-colors`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="font-technical font-bold text-sm text-[#DFE2EE] uppercase tracking-wide break-all">
                      {msg.messageType}
                    </span>
                    <span className="font-montserrat text-xs text-[#8A8F98]">
                      {msg.freightMeaning}
                    </span>
                  </div>
                  <span className="px-2 py-1 bg-[#168A4A]/10 border border-[#168A4A]/30 text-[#168A4A] rounded text-[10px] font-technical uppercase font-bold tracking-wider flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> {msg.status || 'LIVE PROVEN'}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#2E3132]/50 font-technical text-xs text-[#8A8F98]">
                  <span>{msg.timestamp}</span>
                  <ExternalExplorerLink
                    type="tx"
                    id={msg.hash}
                    label={`Seq ${msg.sequenceNumber}`}
                    variant="dark"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
