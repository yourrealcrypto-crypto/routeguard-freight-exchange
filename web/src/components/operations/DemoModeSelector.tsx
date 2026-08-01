import React from 'react';
import { Code2, Laptop, Play } from 'lucide-react';
import type { DemoMode } from '../../data/demoSessionTypes';

interface Props { mode: DemoMode; onModeChange: (mode: DemoMode) => void; }
const options: Array<{ mode: DemoMode; title: string; tags: string[]; copy: string; icon: typeof Play }> = [
  { mode: 'completed-replay', title: 'Completed Proof Replay', tags: ['REAL TESTNET', 'IMMUTABLE', 'READ ONLY'], copy: 'Inspect the authoritative completed lifecycle exactly as recorded. This mode never submits a transaction.', icon: Play },
  { mode: 'local-simulation', title: 'Interactive Local Simulation', tags: ['FULLY INTERACTIVE', 'ZERO WRITES', 'SAME API SHAPE'], copy: 'Operate both roles through the production state machine using simulated references that cannot be mistaken for Hedera IDs.', icon: Laptop },
  { mode: 'interactive-testnet', title: 'Controlled Testnet Session', tags: ['DISABLED BY DEFAULT', 'SERVER SIGNED', 'TESTNET ONLY'], copy: 'Available only when an operator explicitly enables the guarded server capability. It never falls back to simulation.', icon: Code2 },
];

export const DemoModeSelector: React.FC<Props> = ({ mode, onModeChange }) => (
  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4" role="radiogroup" aria-label="Select demo mode">
    {options.map((option) => {
      const selected = option.mode === mode;
      const Icon = option.icon;
      return (
        <button key={option.mode} role="radio" aria-checked={selected} onClick={() => onModeChange(option.mode)} className={`flex flex-col items-start gap-3 p-5 rounded-[12px] border text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0031FF] ${selected ? 'bg-[#15171A] border-[#15171A] text-white shadow-md' : 'bg-white border-[#C1C7D0] shadow-sm hover:border-[#15171A] text-[#15171A]'}`}>
          <div className="flex items-center gap-2"><Icon className={`w-5 h-5 ${selected ? 'text-[#88A4FF]' : 'text-[#60646C]'}`} /><h3 className="font-montserrat font-bold text-sm">{option.title}</h3></div>
          <div className="flex flex-wrap gap-1.5">{option.tags.map((tag) => <span key={tag} className={`px-2 py-0.5 rounded text-[9px] font-technical uppercase font-bold tracking-wider ${selected ? 'bg-white/10 text-white' : 'bg-[#F1F3F5] text-[#60646C]'}`}>{tag}</span>)}</div>
          <p className={`font-montserrat text-xs leading-relaxed ${selected ? 'text-[#DFE2EE]' : 'text-[#60646C]'}`}>{option.copy}</p>
        </button>
      );
    })}
  </div>
);
