import React, { useState, useEffect, useCallback } from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { RouteGuardHeader } from '../components/RouteGuardHeader';
import { RouteGuardFooter } from '../components/RouteGuardFooter';
import { DemoMode, Role, DemoSessionSnapshot } from '../data/demoSessionTypes';
import { gateway } from '../data/demoSessionGateway';
import { getRoleWorkspaceState } from '../data/demoRoleActionResolver';
import { DemoModeSelector } from '../components/operations/DemoModeSelector';
import { WorkflowRail } from '../components/operations/WorkflowRail';
import { OperationsWorkspace } from '../components/operations/OperationsWorkspace';
import { SessionPanel } from '../components/operations/SessionPanel';
import { CompletionProofReport } from '../components/operations/CompletionProofReport';
import { ReplayControls } from '../components/operations/ReplayControls';
import { CheckCircle2, RotateCcw } from 'lucide-react';

interface ControlPageProps {
  evidence: RouteGuardEvidence;
  onNavigate: (path: string) => void;
}

export const ControlPage: React.FC<ControlPageProps> = ({ evidence, onNavigate }) => {
  const [snapshot, setSnapshot] = useState<DemoSessionSnapshot | null>(null);
  const [mode, setMode] = useState<DemoMode>('completed-replay');
  const [selectedStep, setSelectedStep] = useState<number>(1);
  const [pageError, setPageError] = useState<string | null>(null);
  const [liveAuthorization, setLiveAuthorization] = useState('');

  // Replay specific states
  const [hasStartedReplay, setHasStartedReplay] = useState<boolean>(false);

  const initMode = useCallback(async (newMode: DemoMode) => {
    setPageError(null);
    try {
      const snap = await gateway.createSession(newMode, 'SHIPPER');
      setSnapshot(snap);
      if (newMode === 'completed-replay') {
        const snapAt1 = await gateway.setStep(snap.sessionId, 1);
        setSnapshot(snapAt1);
      }
      setSelectedStep(1);
      setHasStartedReplay(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Unable to initialize this demo mode.');
    }
  }, []);

  useEffect(() => {
    initMode(mode);
  }, [mode, initMode]);

  const updateStateAndWorkspace = useCallback((snap: DemoSessionSnapshot) => {
    setSnapshot(snap);
    if (snap.mode === 'completed-replay') {
      setSelectedStep(snap.currentStep);
    } else {
      const { step } = getRoleWorkspaceState(snap, snap.role);
      setSelectedStep(step);
      snap.currentStep = step;
    }
  }, []);

  useEffect(() => {
    if (!snapshot?.apiSession) return;
    return gateway.watchSession(snapshot.sessionId, updateStateAndWorkspace);
  }, [snapshot?.sessionId, snapshot?.apiSession, updateStateAndWorkspace]);

  // Replay Logic
  const ACTOR_SEQUENCE: Role[] = [
    'SHIPPER', // 1
    'SHIPPER', // 2
    'SHIPPER', // 3
    'CARRIER', // 4
    'SHIPPER', // 5
    'CARRIER', // 6
    'SHIPPER', // 7
    'CARRIER'  // 8
  ];

  if (!snapshot) return <div className="min-h-screen bg-[#F7F8FA] p-8 font-montserrat text-[#15171A]">{pageError ?? 'Loading verified evidence…'}</div>;

  const handleRoleChange = async (role: Role) => {
    const newSnap = await gateway.changeRole(snapshot.sessionId, role);
    updateStateAndWorkspace(newSnap);
  };

  const handleAction = async (action: string, payload?: any) => {
    let result;
    switch (action) {
      case 'defineShipment':
        result = await gateway.defineShipment(snapshot.sessionId);
        break;
      case 'openTender':
        result = await gateway.openTender(snapshot.sessionId);
        break;
      case 'fundEscrow':
        result = await gateway.fundEscrow(snapshot.sessionId);
        break;
      case 'submitOffer':
        result = await gateway.submitOffer(snapshot.sessionId, payload);
        break;
      case 'selectWinner':
        result = await gateway.selectWinner(snapshot.sessionId);
        break;
      case 'submitPod':
        result = await gateway.submitPod(snapshot.sessionId, payload);
        break;
      case 'acceptPod':
        result = await gateway.acceptPod(snapshot.sessionId);
        break;
      case 'releaseFreight':
        result = await gateway.releaseFreight(snapshot.sessionId);
        break;
      case 'requestCorrection':
        result = await gateway.requestCorrection(snapshot.sessionId);
        break;
      case 'openDispute':
        result = await gateway.openDispute(snapshot.sessionId);
        break;
    }
    if (result && result.success) {
      updateStateAndWorkspace(result.snapshot);
      setPageError(null);
    } else if (result?.error) {
      setPageError(result.error);
    }
  };

  const handleReset = async () => {
    if (snapshot.mode === 'completed-replay') {
      initMode('completed-replay');
    } else {
      const newSnap = await gateway.resetSession(snapshot.sessionId);
      updateStateAndWorkspace(newSnap);
    }
  };

  const handleSelectStep = async (step: number) => {
    if (snapshot.mode === 'completed-replay') {
      let newSnap = await gateway.setStep(snapshot.sessionId, step);
      newSnap = await gateway.changeRole(newSnap.sessionId, ACTOR_SEQUENCE[step - 1]!);
      updateStateAndWorkspace(newSnap);
    } else {
      setSelectedStep(step);
    }
  };

  const handleNextReplay = async () => {
    if (snapshot.mode !== 'completed-replay') return;

    if (!hasStartedReplay) {
      setHasStartedReplay(true);
      const newSnap = await gateway.changeRole(snapshot.sessionId, 'SHIPPER');
      updateStateAndWorkspace(newSnap);
      return;
    }

    if (snapshot.currentStep < 8) {
      const nextStep = snapshot.currentStep + 1;
      let newSnap = await gateway.setStep(snapshot.sessionId, nextStep);
      newSnap = await gateway.changeRole(newSnap.sessionId, ACTOR_SEQUENCE[nextStep - 1]!);
      updateStateAndWorkspace(newSnap);
    }
  };

  const handlePreviousReplay = async () => {
    if (snapshot.mode !== 'completed-replay') return;

    if (snapshot.currentStep > 1) {
      const prevStep = snapshot.currentStep - 1;
      let newSnap = await gateway.setStep(snapshot.sessionId, prevStep);
      newSnap = await gateway.changeRole(newSnap.sessionId, ACTOR_SEQUENCE[prevStep - 1]!);
      updateStateAndWorkspace(newSnap);
    } else if (snapshot.currentStep === 1 && hasStartedReplay) {
      setHasStartedReplay(false);
      const newSnap = await gateway.changeRole(snapshot.sessionId, 'SHIPPER');
      updateStateAndWorkspace(newSnap);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-[#15171A]">
      <RouteGuardHeader currentPath="/control" onNavigate={onNavigate} />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-5 md:px-12 py-8 md:py-12 flex flex-col gap-6">

        {/* COMPACT HERO */}
        <section className="flex flex-col gap-3 max-w-4xl mx-auto text-center items-center pb-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 bg-[#168A4A]/10 border border-[#168A4A]/20 rounded-full">
              <span className="w-2.5 h-2.5 rounded-full bg-[#168A4A]" />
              <span className="font-technical text-xs font-semibold text-[#168A4A] uppercase tracking-wider">
                THREE CONTROLLED MODES · TESTNET SAFE
              </span>
            </div>
          </div>
          <h1 className="font-montserrat font-bold text-3xl md:text-4xl text-[#15171A] leading-tight">
            Operate the freight lifecycle from either side
          </h1>
          <p className="font-montserrat text-sm md:text-base text-[#60646C] max-w-2xl">
            Follow one connected tender from shipper configuration through carrier offer, delivery evidence and settlement.
          </p>
        </section>

        {/* TWO-MODE SELECTOR */}
        <DemoModeSelector mode={mode} onModeChange={setMode} />

        {pageError && <div role="alert" className="rounded-[10px] border border-[#E02626]/30 bg-[#E02626]/5 px-4 py-3 font-montserrat text-sm text-[#9F1D1D]">{pageError}</div>}

        {mode === 'interactive-testnet' && snapshot.liveEnabled && (
          <div className="rounded-[12px] border border-[#C1C7D0] bg-white p-5 shadow-sm">
            <label htmlFor="live-authorization" className="font-technical text-[10px] font-bold uppercase tracking-wider text-[#60646C]">Session-only operator authorization</label>
            <div className="mt-2 flex flex-col sm:flex-row gap-3">
              <input id="live-authorization" type="password" autoComplete="off" value={liveAuthorization} onChange={(event) => { const value = event.target.value; setLiveAuthorization(value); gateway.setLiveAuthorization(value); }} className="min-w-0 flex-1 rounded-[8px] border border-[#C1C7D0] px-3 py-2 font-technical text-sm focus:outline-none focus:ring-2 focus:ring-[#0031FF]" aria-describedby="live-authorization-help" />
              <span className="self-center font-technical text-[10px] font-bold text-[#168A4A]">MEMORY ONLY · SERVER SIGNS</span>
            </div>
            <p id="live-authorization-help" className="mt-2 font-montserrat text-xs text-[#60646C]">Never stored in browser storage, URLs, or logs. Live mode does not fall back to simulation.</p>
          </div>
        )}

        {/* OPERATIONS COMMAND BAR */}
        <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-6 bg-white p-6 rounded-[12px] border border-[#C1C7D0] shadow-md">

          {/* LEFT: Current role */}
          <div className="flex flex-col gap-2 w-full lg:w-auto">
            <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">DEMO ROLE</span>
            <div role="tablist" aria-label="Operational views" className="flex p-1 bg-[#F1F3F5] rounded-[10px] w-full min-w-[300px]">
              <button
                role="tab"
                aria-selected={snapshot.role === 'SHIPPER'}
                onClick={() => handleRoleChange('SHIPPER')}
                className={`flex-1 min-h-[48px] px-6 font-montserrat font-bold text-sm uppercase tracking-wider rounded-[8px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0031FF] ${snapshot.role === 'SHIPPER' ? 'bg-[#0031FF] text-white shadow-sm' : 'text-[#60646C] hover:text-[#15171A]'}`}
              >
                SHIPPER VIEW
              </button>
              <button
                role="tab"
                aria-selected={snapshot.role === 'CARRIER'}
                onClick={() => handleRoleChange('CARRIER')}
                className={`flex-1 min-h-[48px] px-6 font-montserrat font-bold text-sm uppercase tracking-wider rounded-[8px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] ${snapshot.role === 'CARRIER' ? 'bg-[#0F766E] text-white shadow-sm' : 'text-[#60646C] hover:text-[#15171A]'}`}
              >
                CARRIER VIEW
              </button>
            </div>
          </div>

          <div className="hidden lg:block w-px self-stretch bg-[#DDE1E6] my-2" />

          {/* CENTER: Selected shipment snapshot */}
          <div className="flex flex-col justify-center gap-1.5 w-full lg:flex-1 lg:px-4">
            <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Selected Shipment</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-montserrat font-semibold text-[#15171A] text-sm">
              <span>{snapshot.route}</span>
              <span className="text-[#DDE1E6]">|</span>
              <span className="text-[#60646C]">{snapshot.transportMode} · {snapshot.weight}</span>
              <span className={`ml-auto lg:ml-2 px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider ${snapshot.lifecycleState === 'COMPLETED' ? 'bg-[#168A4A]/10 text-[#168A4A]' : 'bg-[#8259EF]/10 text-[#8259EF]'}`}>
                {snapshot.lifecycleState}
              </span>
            </div>
          </div>

          <div className="hidden lg:block w-px self-stretch bg-[#DDE1E6] my-2" />

          {/* RIGHT: Current mode & connection */}
          <div className="flex flex-col gap-2 w-full lg:w-72 items-start lg:items-end text-left lg:text-right">
            <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">CONNECTION</span>
            <div className={`font-montserrat font-bold text-sm ${mode === 'completed-replay' ? 'text-[#168A4A]' : 'text-[#0031FF]'}`}>
              {snapshot.connectionStatus}
            </div>
            <button onClick={handleReset} className="mt-1 flex items-center gap-1.5 font-technical text-[10px] font-bold tracking-wider text-[#60646C] uppercase hover:text-[#15171A] transition-colors focus:outline-none focus-visible:underline">
              <RotateCcw className="w-3.5 h-3.5" /> {mode === 'completed-replay' ? 'RESTART REPLAY' : 'RESET SCENARIO'}
            </button>
          </div>
        </div>

        {/* REPLAY CONTROLS */}
        {snapshot.mode === 'completed-replay' && (
          <ReplayControls
            currentStep={snapshot.currentStep}
            hasStartedReplay={hasStartedReplay}
            onPrevious={handlePreviousReplay}
            onNext={handleNextReplay}
            onRestart={() => initMode('completed-replay')}
          />
        )}

        {/* WORKFLOW PROGRESS RAIL */}
        <WorkflowRail snapshot={snapshot} selectedStep={selectedStep} onSelectStep={handleSelectStep} />

        {/* PRIMARY WORKSPACE AND SESSION PANEL */}
        <div className="flex flex-col lg:flex-row gap-6 items-start">

          <div className="flex-1 flex flex-col gap-6 w-full">
            {snapshot.mode === 'completed-replay' && !hasStartedReplay && selectedStep === 1 ? (
              <div className="bg-white border border-[#DDE1E6] rounded-[12px] p-8 md:p-12 flex flex-col items-center justify-center text-center gap-6 shadow-sm min-h-[400px]">
                <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Completed RouteGuard demo</h2>
                <p className="font-montserrat text-sm text-[#60646C] max-w-lg">Follow the completed freight lifecycle from shipment definition through carrier payment, with the associated Hedera testnet proof revealed at every step.</p>
                <div className="flex gap-6 mt-4">
                  <button onClick={() => { setHasStartedReplay(true); handleSelectStep(8); }} className="font-technical text-xs font-bold text-[#60646C] uppercase tracking-wider hover:text-[#15171A] focus:outline-none focus-visible:underline">VIEW FINAL REPORT</button>
                  <button onClick={handleReset} className="font-technical text-xs font-bold text-[#60646C] uppercase tracking-wider hover:text-[#15171A] focus:outline-none focus-visible:underline">RESTART</button>
                </div>
              </div>
            ) : (
              <OperationsWorkspace snapshot={snapshot} onAction={handleAction} selectedStep={selectedStep} />
            )}

            {/* ROLE-SPECIFIC PROOF REPORT DIRECTLY BELOW WORKSPACE */}
            {hasStartedReplay || snapshot.mode !== 'completed-replay' ? (
              <CompletionProofReport snapshot={snapshot} evidence={evidence} />
            ) : null}
          </div>

          <SessionPanel snapshot={snapshot} onNavigate={onNavigate} />

        </div>

      </main>
      <RouteGuardFooter onNavigate={onNavigate} />
    </div>
  );
};
