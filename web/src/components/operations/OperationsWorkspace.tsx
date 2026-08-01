import React, { useState } from 'react';
import { DemoSessionSnapshot } from '../../data/demoSessionTypes';
import { getRoleWorkspaceState } from '../../data/demoRoleActionResolver';
import { CheckCircle2, UploadCloud, FileText } from 'lucide-react';

interface Props {
  snapshot: DemoSessionSnapshot;
  onAction: (action: string, payload?: any) => Promise<void>;
  selectedStep: number;
}

export const OperationsWorkspace: React.FC<Props> = ({ snapshot, onAction, selectedStep }) => {
  const { mode, role, currentStep, lifecycleState } = snapshot;
  const isLive = mode === 'completed-replay';
  const isPreview = mode !== 'completed-replay';
  const isLocal = mode === 'local-simulation';

  const formatUSDC = (val?: number) => val !== undefined ? `${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 })} USDC` : '—';

  // The resolver maps lifecycleState + role -> what step UI to show if they are just viewing their "current" state
  // But if the user clicks a specific step on the rail, we show that step's UI.
  // Wait, the prompt says: "When the role switch changes: automatically display the selected role’s next available workspace"
  // Let's rely on the parent (ControlPage) to manage `selectedStep`, which we receive here as a prop.

  const renderStep1 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <div className="flex justify-between items-center border-b border-[#DDE1E6] pb-3">
        <h2 className="font-montserrat font-bold text-lg text-[#15171A]">{role === 'SHIPPER' ? 'Step 1: Define Shipment' : 'Step 1: Waiting for Shipper'}</h2>
      </div>

      {role === 'CARRIER' && lifecycleState === 'DRAFT' && !isLive ? (
        <div className="font-technical text-sm text-[#60646C]">Waiting for shipper to define shipment and activate tender...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-sm text-[#15171A]">
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Origin</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.route.split(' → ')[0]}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Destination</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.route.split(' → ')[1]}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Mode</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.transportMode}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Equipment</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.equipment}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Weight</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.weight}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Pickup</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.pickupWindow}</span></div>
            <div className="flex flex-col gap-1"><span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Delivery</span><span className="bg-[#F7F8FA] border border-[#DDE1E6] px-3 py-2 rounded-[6px]">{snapshot.deliveryDeadline}</span></div>
          </div>

          <div className="flex flex-col md:flex-row gap-6 mt-2 border-t border-[#DDE1E6] pt-5">
            <div className="flex-1 flex flex-col gap-1">
              <span className="font-technical text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">SYNTHETIC LOGISTICS VALUE</span>
              <span className="font-montserrat font-bold text-[#15171A]">{snapshot.illustrativeQuote}</span>
            </div>
            <div className="flex-1 flex flex-col gap-1">
              <span className="font-technical text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">HTS TESTNET PRINCIPAL</span>
              <span className="font-montserrat font-bold text-[#15171A]">{snapshot.maxBudget}</span>
            </div>
          </div>
        </>
      )}

      {role === 'SHIPPER' && currentStep === 1 && lifecycleState === 'DRAFT' && !isLive && (
        <div className="mt-2">
          <button disabled={mode === 'interactive-testnet' && !snapshot.liveEnabled} onClick={() => onAction('defineShipment')} className="w-full md:w-auto h-10 px-6 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0031FF] disabled:cursor-not-allowed disabled:opacity-50">
            {mode === 'interactive-testnet' && !snapshot.liveEnabled ? 'LIVE SESSION DISABLED' : 'DEFINE SHIPMENT'}
          </button>
        </div>
      )}
    </div>
  );

  const renderStep2 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">{role === 'SHIPPER' ? 'Step 2: Fund Escrow' : 'Step 2: Waiting for Escrow Funding'}</h2>
      {role === 'CARRIER' && !isLive && currentStep < 3 ? (
        <div className="font-technical text-sm text-[#60646C]">Waiting for shipper to provide escrow funding...</div>
      ) : (
        <>
          <div className="flex flex-col gap-2 font-technical text-sm text-[#15171A]">
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">Shipper provides</span><span className="font-bold">{snapshot.maxBudget}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">Destination</span><span className="font-bold">RouteGuard freight escrow</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2 gap-4"><span className="text-[#8A8F98] uppercase">Status</span><span className="font-bold text-[#8259EF] text-right">{snapshot.connectionStatus}</span></div>
          </div>
          {role === 'SHIPPER' && currentStep === 2 && lifecycleState === 'SHIPMENT_DEFINED' && !isLive && (
            <button onClick={() => onAction('fundEscrow')} className="w-full md:w-auto self-start h-10 px-6 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] transition-colors">
              {isLocal ? 'SIMULATE ESCROW FUNDING' : 'FUND TESTNET ESCROW'}
            </button>
          )}
        </>
      )}
    </div>
  );

  const renderStep3 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">{role === 'SHIPPER' ? 'Step 3: Activate Tender' : 'Step 3: Waiting for Tender Activation'}</h2>
      {role === 'CARRIER' && !isLive && currentStep < 4 ? (
        <div className="font-technical text-sm text-[#60646C]">Waiting for shipper to activate tender...</div>
      ) : (
        <>
          <div className="flex flex-col gap-2 font-technical text-sm text-[#15171A]">
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">x402 tender-access fee</span><span className="font-bold text-[#168A4A]">0.001 USDC</span></div>
          </div>
          {role === 'SHIPPER' && currentStep === 3 && lifecycleState === 'ESCROW_FUNDED' && !isLive && (
            <div className="flex flex-col gap-2">
              <button onClick={() => onAction('openTender')} className="w-full md:w-auto self-start h-10 px-6 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] transition-colors">
                {isLocal ? 'SIMULATE TENDER ACTIVATION' : 'ACTIVATE TESTNET TENDER'}
              </button>
              <span className="font-technical text-[10px] text-[#8A8F98] uppercase tracking-wider">{snapshot.connectionStatus}</span>
            </div>
          )}
        </>
      )}
    </div>
  );

  const [offerInput] = useState(mode === 'completed-replay' ? '0.75' : '0.015');

  const renderStep4 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">Step 4: Carrier Offer</h2>
      {role === 'SHIPPER' && currentStep === 4 && lifecycleState === 'TENDER_OPEN' && !isLive ? (
        <div className="font-technical text-sm text-[#60646C]">Waiting for carrier to submit an offer...</div>
      ) : role === 'CARRIER' && currentStep === 4 && (lifecycleState === 'TENDER_OPEN' || isLive) ? (
        <div className="flex flex-col gap-3 max-w-sm">
          {isLive && (
            <div className="bg-[#168A4A]/10 border border-[#168A4A]/20 rounded-[8px] p-4 font-technical text-xs flex justify-between items-center mb-2">
              <div className="flex flex-col gap-1">
                <span className="text-[#168A4A] font-bold tracking-wider uppercase">Carrier</span>
                <span className="font-bold text-[#15171A] text-sm">carrier-alpha</span>
              </div>
              <span className="px-3 py-1 bg-[#168A4A] text-white rounded-[4px] font-bold uppercase tracking-wider">QUALIFIED</span>
            </div>
          )}
          <div className="bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px] p-4 font-technical text-xs mb-2">
            <span className="text-[#8A8F98] font-bold tracking-wider uppercase mb-2 block">Carrier Qualification</span>
            <div className="flex flex-col gap-1.5 text-[#15171A]">
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Equipment match</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Weight supported</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Pickup window supported</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Delivery deadline achievable</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Carrier qualified</div>
              <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-[#168A4A]"/> Offer not above maximum budget</div>
            </div>
          </div>
          <label className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Offer Amount (USDC)</label>
          <div className="bg-[#F7F8FA] border border-[#DDE1E6] rounded-[6px] px-3 py-2 font-montserrat text-sm font-bold text-[#15171A] flex items-center">
            {offerInput}
          </div>
          <div className="flex justify-between border-b border-[#F1F3F5] pb-2 mt-2 font-technical text-xs"><span className="text-[#8A8F98] uppercase">Protected x402 carrier-offer access</span><span className="font-bold text-[#168A4A]">SUCCEEDED</span></div>
          {!isLive && (
            <>
              <button onClick={() => onAction('submitOffer', Number(offerInput))} className="mt-2 h-10 bg-[#0F766E] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0D625A] transition-colors">
                {isLocal ? 'SIMULATE CARRIER OFFER' : 'SUBMIT TESTNET OFFER'}
              </button>
              {isPreview && <span className="font-technical text-[10px] text-center text-[#8A8F98] uppercase tracking-wider mt-1">{snapshot.connectionStatus}</span>}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 font-technical text-sm">
          <p className="font-montserrat text-xs text-[#60646C]">Offers received.</p>
          {snapshot.carrierOffers.map((o, i) => (
            <div key={i} className="flex justify-between items-center p-3 bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px]">
              <div className="flex flex-col">
                <span className="font-bold">{o.carrierId}</span>
                {o.evidenceClassification === 'simulated-comparison-offer' && <span className="text-[10px] text-[#8259EF] font-bold tracking-wider mt-0.5">SUBMITTED IN TEST ENGINE</span>}
                {o.evidenceClassification === 'synthetic-comparison-offer' && <span className="text-[10px] text-[#0031FF] font-bold tracking-wider mt-0.5">SYNTHETIC COMPARISON DATA</span>}
                {o.evidenceClassification === 'live-proven-winning-offer' && <span className="text-[10px] text-[#168A4A] font-bold tracking-wider mt-0.5">VERIFIED TESTNET EVENT</span>}
              </div>
              <span className="font-bold text-[#168A4A]">{formatUSDC(o.amountUsdc)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderStep5 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">Step 5: Select Qualified Winner & Allocate</h2>
      {role === 'CARRIER' && currentStep === 5 && lifecycleState === 'OFFER_SUBMITTED' && !isLive ? (
        <div className="font-technical text-sm text-[#60646C]">Offer submitted. Waiting for shipper selection...</div>
      ) : (
        <div className="font-technical text-sm">
          {snapshot.carrierOffers.map((o, i) => {
            const isWinner = o.selectionResult === 'winner';
            const isRejected = o.selectionResult === 'rejected';

            return (
              <div key={i} className={`flex justify-between items-center p-4 rounded-[8px] mb-3 ${isWinner ? 'bg-[#168A4A]/5 border border-[#168A4A]/20' : 'bg-[#F7F8FA] border border-[#DDE1E6]'}`}>
                <div className="flex flex-col gap-0.5">
                  <span className={`font-bold ${isWinner ? 'text-[#15171A]' : 'text-[#60646C]'}`}>{o.carrierId}</span>
                  <span className={`font-bold text-sm ${isWinner ? 'text-[#168A4A]' : 'text-[#15171A]'}`}>{formatUSDC(o.amountUsdc)}</span>
                  {o.qualification === 'not-qualified' && (
                    <span className="text-[10px] uppercase font-bold tracking-wider text-[#E02626] mt-1">{o.reason}</span>
                  )}
                  {o.evidenceClassification === 'simulated-comparison-offer' && <span className="text-[10px] text-[#8259EF] font-bold tracking-wider mt-1 uppercase">SUBMITTED IN TEST ENGINE</span>}
                  {o.evidenceClassification === 'synthetic-comparison-offer' && <span className="text-[10px] text-[#0031FF] font-bold tracking-wider mt-1 uppercase">SYNTHETIC COMPARISON OFFER</span>}
                  {o.evidenceClassification === 'live-proven-winning-offer' && <span className="text-[10px] text-[#168A4A] font-bold tracking-wider mt-1 uppercase">LIVE-PROVEN WINNING OFFER</span>}
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  {o.qualification === 'qualified' ? (
                    <span className="text-[#168A4A] font-bold text-xs uppercase tracking-wider bg-[#168A4A]/10 px-2 py-0.5 rounded">QUALIFIED</span>
                  ) : (
                    <span className="text-[#E02626] font-bold text-xs uppercase tracking-wider bg-[#E02626]/10 px-2 py-0.5 rounded">NOT QUALIFIED</span>
                  )}
                  {isWinner ? (
                    <span className="text-[#168A4A] font-bold text-xs uppercase tracking-wider">WINNER</span>
                  ) : isRejected ? (
                    <span className="text-[#E02626] font-bold text-xs uppercase tracking-wider">REJECTED</span>
                  ) : null}
                </div>
              </div>
            );
          })}

          {isLive && <div className="mt-4 p-4 bg-[#F1F3F5] rounded-[8px] border border-[#DDE1E6] font-montserrat text-sm text-[#60646C]">
            <strong>The lower 0.70 USDC offer is rejected</strong> because it fails a shipper-defined equipment rule. The lowest valid qualified offer therefore wins.
          </div>}

          {currentStep > 5 && (
            <div className="mt-4 pt-4 border-t border-[#DDE1E6] grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1 p-3 bg-[#F7F8FA] rounded-[6px] border border-[#DDE1E6]">
                <span className="text-[10px] font-bold text-[#8A8F98] tracking-wider uppercase">SHIPPER</span>
                <span className="text-xs">funded {snapshot.maxBudget}</span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-[#F7F8FA] rounded-[6px] border border-[#DDE1E6]">
                <span className="text-[10px] font-bold text-[#8A8F98] tracking-wider uppercase">ESCROW</span>
                <span className="text-xs">locks {formatUSDC(snapshot.winningAmount)} for {snapshot.selectedWinner}</span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-[#F7F8FA] rounded-[6px] border border-[#DDE1E6]">
                <span className="text-[10px] font-bold text-[#8A8F98] tracking-wider uppercase">SHIPPER</span>
                <span className="text-xs">receives {formatUSDC(snapshot.excessRefund)}</span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-[#F7F8FA] rounded-[6px] border border-[#DDE1E6]">
                <span className="text-[10px] font-bold text-[#8A8F98] tracking-wider uppercase">CARRIER</span>
                <span className="text-xs">received 0 USDC</span>
              </div>
            </div>
          )}

          {role === 'SHIPPER' && currentStep === 5 && lifecycleState === 'OFFER_SUBMITTED' && !isLive && (
            <button onClick={() => onAction('selectWinner')} className="mt-4 w-full md:w-auto h-10 px-6 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] transition-colors">
              SELECT QUALIFIED WINNER
            </button>
          )}
        </div>
      )}
    </div>
  );

  const [podFile, setPodFile] = useState<string | null>(null);

  const renderStep6 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">Step 6: Upload POD</h2>
      {role === 'SHIPPER' && currentStep === 6 && lifecycleState === 'WINNING_AMOUNT_LOCKED' && !isLive ? (
        <div className="font-technical text-sm text-[#60646C]">Winner and financial allocation confirmed. Waiting for carrier POD...</div>
      ) : role === 'CARRIER' && currentStep === 6 && lifecycleState === 'WINNING_AMOUNT_LOCKED' && !isLive ? (
        <div className="flex flex-col gap-4 max-w-sm">
          <div className="bg-[#168A4A]/10 border border-[#168A4A]/20 rounded-[8px] p-4 flex flex-col gap-1">
            <span className="font-technical text-[10px] font-bold text-[#168A4A] tracking-wider uppercase">OFFER SELECTED</span>
            <span className="font-montserrat font-bold text-[#15171A]">Winning amount: {formatUSDC(snapshot.winningAmount)}</span>
            <span className="font-technical text-xs text-[#60646C]">Payment state: LOCKED PENDING ACCEPTED POD</span>
          </div>

          <div className="flex flex-col gap-2">
            {!podFile ? (
              <>
                <button onClick={() => setPodFile('synthetic_pod_data.json')} className="h-10 bg-white border border-[#DDE1E6] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F7F8FA] transition-colors">
                  USE PREDEFINED SYNTHETIC POD
                </button>
                <div className="border-2 border-dashed border-[#DDE1E6] rounded-[8px] p-6 text-center hover:bg-[#F7F8FA] transition-colors cursor-pointer flex flex-col items-center justify-center gap-2" onClick={() => setPodFile('demo_delivery_receipt.pdf')}>
                  <UploadCloud className="w-6 h-6 text-[#8A8F98]" />
                  <span className="font-montserrat text-sm font-semibold text-[#15171A]">SELECT DEMO FILE</span>
                  <span className="font-technical text-[10px] text-[#8A8F98] uppercase tracking-wider">PDF, JPEG, PNG, JSON</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between p-4 bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px]">
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-[#0F766E]" />
                  <div className="flex flex-col font-technical text-xs">
                    <span className="font-bold text-[#15171A]">{podFile}</span>
                    <span className="text-[#8A8F98]">1.2 MB · {podFile.endsWith('.json') ? 'JSON' : 'PDF'}</span>
                  </div>
                </div>
                <button onClick={() => setPodFile(null)} className="text-[#E02626] font-technical text-[10px] uppercase font-bold hover:underline focus:outline-none">Remove</button>
              </div>
            )}
          </div>

          <button disabled={!podFile} onClick={() => onAction('submitPod')} className="h-10 bg-[#0F766E] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0D625A] transition-colors disabled:opacity-50">
            UPLOAD DEMO POD
          </button>
        </div>
      ) : (
        <div className="font-technical text-sm">
          <p className="font-montserrat text-xs text-[#60646C]">POD uploaded.</p>
          <div className="flex items-center gap-2 mt-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]"/> File provided</div>
        </div>
      )}
    </div>
  );

  const renderStep7 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">Step 7: Review POD</h2>
      {role === 'CARRIER' && currentStep === 7 && lifecycleState === 'POD_SUBMITTED' && !isLive ? (
        <div className="font-technical text-sm text-[#60646C]">POD submitted. Waiting for shipper review...</div>
      ) : (
        <>
          <div className="flex flex-col gap-2 font-technical text-sm text-[#15171A] max-w-sm">
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">POD received from</span><span className="font-bold">{snapshot.selectedWinner}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">POD state</span><span className="font-bold text-[#168A4A]">{snapshot.podState}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">Carrier signature</span><span className="font-bold text-[#168A4A]">{isLocal ? 'SIMULATED' : 'VERIFIED'}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">Encryption</span><span className="font-bold text-[#168A4A]">{isLocal ? 'SIMULATED' : 'COMPLETE'}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">HCS evidence</span><span className="font-bold text-[#8259EF]">{snapshot.hcsTopic}</span></div>
            <div className="flex justify-between border-b border-[#F1F3F5] pb-2"><span className="text-[#8A8F98] uppercase">Adviser</span><span className="font-bold">DETERMINISTIC · NON-BINDING</span></div>
          </div>
          {role === 'SHIPPER' && currentStep === 7 && lifecycleState === 'POD_SUBMITTED' && !isLive && (
            <div className="flex flex-col md:flex-row gap-3 mt-2">
              <button onClick={() => onAction('acceptPod')} className="flex-1 h-10 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] transition-colors">
                ACCEPT POD
              </button>
              <button className="flex-1 h-10 bg-white border border-[#DDE1E6] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F1F3F5] transition-colors">
                REQUEST CORRECTION
              </button>
              <button className="flex-1 h-10 bg-white border border-[#DDE1E6] text-[#E02626] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F1F3F5] transition-colors">
                OPEN DISPUTE
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderStep8 = () => (
    <div className="flex flex-col gap-5 bg-white border border-[#C1C7D0] rounded-[12px] p-6 shadow-md">
      <h2 className="font-montserrat font-bold text-lg text-[#15171A]">Step 8: Release and Complete</h2>
      {role === 'CARRIER' && (
        <div className="bg-[#168A4A]/10 border border-[#168A4A]/20 rounded-[8px] p-4 flex flex-col gap-1 mb-2">
          <span className="font-technical text-[10px] font-bold text-[#168A4A] tracking-wider uppercase">PAYMENT RECEIVED</span>
          <span className="font-montserrat font-bold text-[#15171A]">Amount: {formatUSDC(snapshot.winningAmount)}</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-technical text-sm text-[#15171A]">
        <div className="flex flex-col gap-2 p-4 bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px]">
          <span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Recipient</span>
          <span className="font-bold text-base text-[#15171A]">{snapshot.selectedWinner}</span>
          <span className="text-xs text-[#60646C] mt-2">Source: RouteGuard freight escrow</span>
        </div>
        <div className="flex flex-col gap-2 p-4 bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px]">
          <span className="text-[10px] text-[#8A8F98] uppercase tracking-wider font-bold">Final Escrow State</span>
          <span className="font-bold text-base">{snapshot.settlementState}</span>
          <span className="text-xs text-[#60646C] mt-2">Remaining locked: 0 USDC</span>
        </div>
      </div>
      {snapshot.lifecycleState === 'POD_ACCEPTED' && role === 'SHIPPER' && (
        <button onClick={() => onAction('releaseFreight')} className="h-11 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#0028CC] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0031FF]">
          RELEASE FREIGHT PAYMENT
        </button>
      )}
      {snapshot.lifecycleState === 'COMPLETED' && currentStep >= 8 && (
        <div className="mt-2 pt-4 border-t border-[#DDE1E6] font-technical text-xs uppercase tracking-wider font-bold text-[#8A8F98] flex flex-col items-center justify-center gap-1">
          <div className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]" /> {isLocal ? 'LOCAL TEST ENGINE COMPLETE' : 'LIFECYCLE COMPLETE'}</div>
          <div>{snapshot.connectionStatus}</div>
          <div>{snapshot.writeCount} NETWORK WRITES</div>
        </div>
      )}
    </div>
  );

  const steps = [
    renderStep1,
    renderStep2,
    renderStep3,
    renderStep4,
    renderStep5,
    renderStep6,
    renderStep7,
    renderStep8
  ];

  const actualRenderIndex = Math.min(Math.max(selectedStep - 1, 0), 7);

  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      {steps[actualRenderIndex]!()}
    </div>
  );
};
