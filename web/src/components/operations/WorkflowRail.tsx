import React from 'react';
import { DemoSessionSnapshot } from '../../data/demoSessionTypes';
import { CheckCircle2 } from 'lucide-react';

interface Props {
  snapshot: DemoSessionSnapshot;
  selectedStep: number;
  onSelectStep: (step: number) => void;
}

export const WorkflowRail: React.FC<Props> = ({ snapshot, selectedStep, onSelectStep }) => {
  const { currentStep } = snapshot;
  const localLayer = snapshot.mode === 'local-simulation' ? 'Simulated · 0 network writes' : null;

  const stepsData = [
    { num: 1, title: 'Define shipment', actor: 'SHIPPER', hedera: 'No network write yet' },
    { num: 2, title: 'Fund escrow', actor: 'SHIPPER', hedera: 'HTS USDC · Smart-contract' },
    { num: 3, title: 'Activate tender', actor: 'SHIPPER', hedera: 'x402 access on Hedera' },
    { num: 4, title: 'Submit offer', actor: 'CARRIER', hedera: 'x402 exact payment' },
    { num: 5, title: 'Select winner', actor: 'SHIPPER', hedera: 'Smart contract logic' },
    { num: 6, title: 'Upload POD', actor: 'CARRIER', hedera: 'HCS anchor pending' },
    { num: 7, title: 'Review POD', actor: 'SHIPPER', hedera: 'No network write yet' },
    { num: 8, title: 'Release', actor: 'SYSTEM', hedera: 'Smart contract release' },
  ];

  return (
    <div className="bg-white border border-[#C1C7D0] rounded-[12px] p-4 shadow-md">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {stepsData.map((step) => {
          const isCompleted = step.num < currentStep;
          const isActive = step.num === currentStep;
          const isSelected = step.num === selectedStep;
          const isFuture = step.num > currentStep;

          return (
            <button
              key={step.num}
              onClick={() => onSelectStep(step.num)}
              disabled={isFuture && !isSelected}
              className={`flex flex-col p-3 text-left rounded-[8px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0031FF] ${isSelected ? 'bg-[#F7F8FA] ring-1 ring-[#DDE1E6]' : 'hover:bg-[#F7F8FA]'} ${isFuture ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isCompleted || isActive ? 'bg-[#15171A] text-white' : 'bg-[#F1F3F5] border border-[#DDE1E6]'}`}>
                  {isCompleted ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span className="font-montserrat font-bold text-[10px]">{step.num}</span>}
                </div>
                <span className={`font-technical text-[10px] font-bold tracking-wider uppercase ${step.actor === 'SHIPPER' ? 'text-[#0031FF]' : step.actor === 'CARRIER' ? 'text-[#0F766E]' : 'text-[#8A8F98]'}`}>{step.actor} ACTION</span>
              </div>
              <span className="font-montserrat font-bold text-[13px] text-[#15171A] mb-1 leading-tight">{step.title}</span>
              <span className="font-technical text-[9px] text-[#60646C] leading-tight">{localLayer ? `LOCAL LAYER: ${localLayer}` : `HEDERA LAYER: ${step.hedera}`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
