import React from 'react';
import { DemoSessionSnapshot } from '../../data/demoSessionTypes';
import { CopyableIdentifier } from '../CopyableIdentifier';
import { Square, RotateCcw } from 'lucide-react';

interface Props {
  snapshot: DemoSessionSnapshot;
  onNavigate: (path: string) => void;
}

export const SessionPanel: React.FC<Props> = ({ snapshot, onNavigate }) => {
  const { mode, role, currentStep } = snapshot;
  const isLive = mode === 'completed-replay' || mode === 'interactive-testnet';

  return (
    <div className="w-full lg:w-80 flex flex-col gap-6 shrink-0 lg:sticky lg:top-24">

      {/* SESSION PANEL */}
      <div className="bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md flex flex-col gap-4">
        <h3 className="font-montserrat font-bold text-base text-[#15171A] border-b border-[#DDE1E6] pb-3">Session Profile</h3>
        <div className="flex flex-col gap-3 font-technical text-xs mt-1 text-[#15171A]">
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Mode</span><span className="font-bold">{mode.replace('-', ' ').toUpperCase()}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Role</span><span className={`font-bold ${role === 'SHIPPER' ? 'text-[#0031FF]' : 'text-[#0F766E]'}`}>{role}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Session ID</span><span className="font-bold">{snapshot.sessionId}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Connection</span><span className="font-bold">{snapshot.connectionStatus}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Current step</span><span className="font-bold">{snapshot.currentStep} / 8</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Lifecycle state</span><span className="font-bold">{snapshot.lifecycleState}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Network write count</span><span className="font-bold">{snapshot.writeCount}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Latest transaction</span>
            {isLive ? <CopyableIdentifier value={snapshot.latestTransaction} /> : <span className="font-bold">{snapshot.latestTransaction}</span>}
          </div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">HCS topic / sequence</span>
            {isLive ? (
              <div className="font-bold">
                <CopyableIdentifier value={snapshot.hcsTopic} />
                <span className="ml-1">seq {snapshot.hcsSequence}</span>
              </div>
            ) : <span className="font-bold">{snapshot.hcsTopic}</span>}
          </div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Escrow state</span><span className="font-bold">{snapshot.escrowState}</span></div>
          <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Locked amount</span><span className="font-bold">{snapshot.lockedAmount !== undefined ? `${snapshot.lockedAmount.toFixed(2)} USDC` : '—'}</span></div>
        </div>
      </div>
    </div>
  );
};
