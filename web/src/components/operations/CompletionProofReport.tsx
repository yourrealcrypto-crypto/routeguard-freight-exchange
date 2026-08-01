import React, { useState, useEffect } from 'react';
import { DemoSessionSnapshot } from '../../data/demoSessionTypes';
import { RouteGuardEvidence } from '../../data/routeguardEvidence';
import { buildDemoProofReport, getProofResultState } from '../../data/demoProofReport';
import { Download, Printer, CheckCircle2, AlertTriangle, ShieldCheck, ChevronDown, ChevronUp, Loader2, Clock } from 'lucide-react';
import { CopyableIdentifier } from '../CopyableIdentifier';
import { ExternalExplorerLink } from '../ExternalExplorerLink';

interface Props {
  snapshot: DemoSessionSnapshot;
  evidence: RouteGuardEvidence;
  replayIsPlaying?: boolean;
  hasStartedReplay?: boolean;
}

export const CompletionProofReport: React.FC<Props> = ({ snapshot, evidence, replayIsPlaying = false, hasStartedReplay = true }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const report = buildDemoProofReport(snapshot, snapshot.role, evidence);
  const isLive = report.reportStatus === 'verified-live-proof';
  const isShipper = report.perspective === 'SHIPPER';
  const nonLiveEvidenceLabel = snapshot.mode === 'local-simulation' ? 'LOCAL SIMULATION · NOT SUBMITTED' : snapshot.liveEnabled ? 'SERVER CONTROLLED' : 'TESTNET DISABLED';

  const isComplete = snapshot.lifecycleState === 'COMPLETED';

  useEffect(() => {
    if (isComplete) {
      setIsExpanded(true);
    }
  }, [isComplete]);

  const formatUSDC = (val?: number) => val !== undefined ? `${val.toFixed(2)} USDC` : '—';

  const handleDownload = () => {
    const jsonString = JSON.stringify(report, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const prefix = isLive ? 'verified' : 'preview';
    link.download = `routeguard-${prefix}-report-${snapshot.role.toLowerCase()}-${snapshot.sessionId}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  const title = isLive ? 'Completed freight proof report' : 'Interactive demo proof report';
  const subtitle = isLive
    ? 'What each party achieved and the associated public Hedera testnet evidence.'
    : 'The current logistics and payment result, with the evidence fields that the RouteGuard testnet backend will populate.';

  if (!isExpanded && !isComplete) {
    return (
      <div className="w-full flex justify-center mt-4 print:hidden">
        <button
          onClick={() => setIsExpanded(true)}
          className="h-10 px-6 bg-white border border-[#DDE1E6] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F7F8FA] transition-colors"
        >
          VIEW FINAL REPORT
        </button>
      </div>
    );
  }

  const renderResultStateIcon = (state: string) => {
    if (state === 'completed') return <CheckCircle2 className="w-4 h-4 text-[#168A4A] mt-0.5 shrink-0" />;
    if (state === 'current') return <Loader2 className="w-4 h-4 text-[#0031FF] mt-0.5 shrink-0 animate-spin" />;
    return <Clock className="w-4 h-4 text-[#8A8F98] mt-0.5 shrink-0" />;
  };

  return (
    <div id="proof-report-section" className="w-full bg-white border border-[#C1C7D0] rounded-[12px] shadow-md flex flex-col mt-2 print:mt-0 print:border-none print:shadow-none transition-all overflow-hidden">

      {/* HEADER */}
      <div className="p-6 border-b border-[#DDE1E6] flex flex-col gap-4">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-montserrat font-bold text-xl text-[#15171A]">{title}</h2>
            <p className="font-montserrat text-sm text-[#60646C]">{subtitle}</p>
          </div>
          <div className="flex gap-2 print:hidden shrink-0">
            <button onClick={handleDownload} className="h-10 px-4 bg-white border border-[#DDE1E6] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F7F8FA] transition-colors flex items-center gap-2">
              <Download className="w-4 h-4" /> {isLive ? 'DOWNLOAD VERIFIED REPORT' : 'DOWNLOAD PREVIEW REPORT'}
            </button>
            <button onClick={handlePrint} className="h-10 px-4 bg-white border border-[#DDE1E6] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase tracking-wider hover:bg-[#F7F8FA] transition-colors flex items-center gap-2">
              <Printer className="w-4 h-4" /> {isLive ? 'PRINT / SAVE AS PDF' : 'PRINT PREVIEW'}
            </button>
            <button onClick={() => setIsExpanded(!isExpanded)} className="h-10 px-3 bg-[#F1F3F5] text-[#15171A] rounded-[8px] hover:bg-[#E2E4E9] transition-colors">
              {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* STATUS BAR */}
        <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-[#F1F3F5]">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider ${isShipper ? 'bg-[#0031FF]/10 text-[#0031FF]' : 'bg-[#0F766E]/10 text-[#0F766E]'}`}>
              REPORT PERSPECTIVE: {snapshot.role}
            </span>
          </div>
          {isLive ? (
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider bg-[#168A4A]/10 text-[#168A4A]">REPORT STATUS: VERIFIED LIVE PROOF</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider bg-[#8259EF]/10 text-[#8259EF]">REPORT STATUS: {snapshot.mode === 'local-simulation' ? 'LOCAL SIMULATION' : 'CONTROLLED SESSION'}</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider bg-[#15171A]/5 text-[#60646C]">EXECUTION: {report.verification.execution}</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-technical uppercase font-bold tracking-wider bg-[#15171A]/5 text-[#60646C]">NETWORK WRITES: {snapshot.writeCount}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#E02626]/10 rounded text-[10px] font-technical uppercase font-bold text-[#E02626] tracking-wider">
                <AlertTriangle className="w-3 h-3" /> NOT A VERIFIED HEDERA REPORT
              </div>
            </>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="flex flex-col">

          {/* ROLE-SPECIFIC FINAL SUMMARY */}
          <div className="p-6 bg-[#F7F8FA] border-b border-[#DDE1E6]">
            <h3 className="font-montserrat font-bold text-sm uppercase text-[#15171A] mb-4">Primary results</h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-sm text-[#15171A]">
              {isShipper ? (
                <>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('shipment-defined', snapshot, replayIsPlaying, hasStartedReplay))}
                    Shipment requirements fixed
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('budget-secured', snapshot, replayIsPlaying, hasStartedReplay))}
                    Maximum budget secured
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('winner-selected', snapshot, replayIsPlaying, hasStartedReplay))}
                    Qualified winner selected
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('excess-returned', snapshot, replayIsPlaying, hasStartedReplay))}
                    0.25 USDC returned
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('pod-accepted', snapshot, replayIsPlaying, hasStartedReplay))}
                    POD accepted
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('carrier-paid', snapshot, replayIsPlaying, hasStartedReplay))}
                    0.75 USDC released
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('tender-completed', snapshot, replayIsPlaying, hasStartedReplay))}
                    Tender completed
                  </li>
                </>
              ) : (
                <>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('shipment-defined', snapshot, replayIsPlaying, hasStartedReplay))}
                    Tender requirements received
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('budget-secured', snapshot, replayIsPlaying, hasStartedReplay))}
                    Carrier qualified
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('winner-selected', snapshot, replayIsPlaying, hasStartedReplay))}
                    0.75 USDC offer submitted
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('excess-returned', snapshot, replayIsPlaying, hasStartedReplay))}
                    Offer selected
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('pod-accepted', snapshot, replayIsPlaying, hasStartedReplay))}
                    POD submitted
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('carrier-paid', snapshot, replayIsPlaying, hasStartedReplay))}
                    Shipper accepted
                  </li>
                  <li className="flex items-start gap-2">
                    {renderResultStateIcon(getProofResultState('tender-completed', snapshot, replayIsPlaying, hasStartedReplay))}
                    0.75 USDC received
                  </li>
                </>
              )}
            </ul>
          </div>

          {/* OFFER EVALUATION RESULTS */}
          {snapshot.currentStep >= 5 && (
            <div className="p-6 border-b border-[#DDE1E6]">
              <h3 className="font-montserrat font-bold text-sm uppercase text-[#15171A] mb-4">Offer Evaluation</h3>
              <div className="flex flex-col gap-3 font-technical text-sm">
                {snapshot.carrierOffers.map((o, i) => {
                  const isWinner = o.selectionResult === 'winner';
                  const isRejected = o.selectionResult === 'rejected';

                  return (
                    <div key={i} className={`flex justify-between items-center p-3 rounded-[8px] ${isWinner ? 'bg-[#168A4A]/5 border border-[#168A4A]/20' : 'bg-[#F7F8FA] border border-[#DDE1E6]'}`}>
                      <div className="flex flex-col">
                        <span className={`font-bold ${isWinner ? 'text-[#15171A]' : 'text-[#60646C]'}`}>{o.carrierId}</span>
                        <span className={`text-[10px] uppercase font-bold tracking-wider ${isWinner ? 'text-[#168A4A]' : isRejected ? 'text-[#E02626]' : 'text-[#60646C]'}`}>{o.reason}</span>
                      </div>
                      <div className="flex flex-col items-end text-right">
                        <span className="font-bold text-[#168A4A]">{formatUSDC(o.amountUsdc)}</span>
                        {o.evidenceClassification === 'simulated-comparison-offer' && <span className="text-[10px] text-[#8259EF] font-bold tracking-wider mt-0.5">SUBMITTED IN TEST ENGINE</span>}
                        {o.evidenceClassification === 'synthetic-comparison-offer' && <span className="text-[10px] text-[#0031FF] font-bold tracking-wider mt-0.5">SYNTHETIC COMPARISON DATA</span>}
                        {o.evidenceClassification === 'live-proven-winning-offer' && <span className="text-[10px] text-[#168A4A] font-bold tracking-wider mt-0.5">VERIFIED TESTNET EVENT</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 8 STEP ROWS */}
          <div className="flex flex-col divide-y divide-[#DDE1E6]">

            {/* STEP 1 */}
            <StepRow
              stepNumber={1}
              title="DEFINE SHIPMENT"
              actor="Shipper"
              isLive={isLive}
            >
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">Shipment requirements fixed before bidding.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Route</span><span className="font-bold">{report.shipment.route}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Mode & Equip</span><span className="font-bold">{report.shipment.transportMode} · {report.shipment.equipment}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Weight</span><span className="font-bold">{report.shipment.weight}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Timing</span><span className="font-bold">{report.shipment.pickupWindow} — {report.shipment.deliveryDeadline}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Rules</span><span className="font-bold">{report.tender.rules.length} predefined rules</span></div>
                </div>
                <TechEvidence mechanism="No network write at this step." isLive={isLive} />
              </div>
            </StepRow>

            {/* STEP 2 */}
            <StepRow stepNumber={2} title="FUND ESCROW" actor="Shipper" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The shipper secured the maximum freight budget before opening the tender.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Shipper funded</span><span className="font-bold">{report.financial.shipperFunded}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Destination</span><span className="font-bold">{report.financial.destination}</span></div>
                </div>
                <TechEvidence
                  mechanism="HTS USDC · Smart-contract custody"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Escrow contract ID', value: report.hederaEvidence.escrowContractId, isMono: true },
                    { label: 'Token ID', value: report.hederaEvidence.tokenId, isMono: true }
                  ]}
                  explorerLinks={evidence.parties?.payerAccountId ? [{ type: 'account', id: evidence.parties.payerAccountId }] : undefined}
                />
              </div>
            </StepRow>

            {/* STEP 3 */}
            <StepRow stepNumber={3} title="ACTIVATE TENDER" actor="Shipper" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The completed tender became available to qualified carriers.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">x402 access fee</span><span className="font-bold">0.001 USDC</span></div>
                </div>
                <TechEvidence
                  mechanism="x402 exact payment on Hedera"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Tender activation tx', value: report.hederaEvidence.x402ActivationTx, isMono: true },
                    { label: 'Access treasury', value: isLive ? '0.0.9215954' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                  explorerLinks={[{ type: 'tx', id: report.hederaEvidence.x402ActivationTx }]}
                />
              </div>
            </StepRow>

            {/* STEP 4 */}
            <StepRow stepNumber={4} title="SUBMIT CARRIER OFFER" actor="Carrier" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The carrier submitted a durable offer for the fixed shipment requirements.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Carrier</span><span className="font-bold">{isLive ? 'carrier-alpha' : 'carrier-sim'}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Offer</span><span className="font-bold">{formatUSDC(report.offers.find(o => o.carrierId === (isLive ? 'carrier-alpha' : 'carrier-sim'))?.amountUsdc)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Qualification</span><span className="font-bold text-[#168A4A]">PASSED</span></div>
                </div>
                <TechEvidence
                  mechanism="x402-gated carrier-offer access"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Carrier-offer access tx', value: report.hederaEvidence.x402OfferTx, isMono: true },
                    { label: 'Access fee', value: isLive ? '0.001 USDC' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                  explorerLinks={[{ type: 'tx', id: report.hederaEvidence.x402OfferTx }]}
                />
              </div>
            </StepRow>

            {/* STEP 5 */}
            <StepRow stepNumber={5} title="SELECT WINNER AND ALLOCATE" actor="Shipper & Rules Engine" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The lowest valid qualified offer won according to the shipper’s predefined rules.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Winning carrier</span><span className="font-bold">{report.winner?.carrierId || (isLive ? 'carrier-alpha' : 'carrier-sim')}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Winning amount</span><span className="font-bold">{formatUSDC(report.winner?.winningAmount)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Amount locked</span><span className="font-bold">{formatUSDC(report.winner?.winningAmount)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Excess returned</span><span className="font-bold">{formatUSDC(report.winner?.excessRefund)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Refund recipient</span><span className="font-bold">Shipper</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Refund timing</span><span className="font-bold">After winner selection and winning-amount allocation</span></div>
                </div>
                <TechEvidence
                  mechanism="Smart-contract allocation and HTS refund"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Contract ID', value: report.hederaEvidence.escrowContractId, isMono: true },
                    { label: 'Allocation state', value: isLive ? 'ALLOCATED' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                />
              </div>
            </StepRow>

            {/* STEP 6 */}
            <StepRow stepNumber={6} title="UPLOAD POD" actor="Carrier" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The carrier submitted signed and encrypted proof-of-delivery evidence.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">POD package</span><span className="font-bold text-[#168A4A]">SUBMITTED</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Carrier signature</span><span className="font-bold text-[#168A4A]">VERIFIED</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Encryption</span><span className="font-bold text-[#168A4A]">COMPLETED</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Adviser</span><span className="font-bold">DETERMINISTIC · NON-BINDING</span></div>
                </div>
                <TechEvidence
                  mechanism="HCS integrity evidence"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Public-safe package hash', value: isLive ? evidence.podReviewEvidence.manifestHash : nonLiveEvidenceLabel, isMono: true },
                    { label: 'Public-safe ciphertext hash', value: isLive ? evidence.podReviewEvidence.ciphertextHash : nonLiveEvidenceLabel, isMono: true },
                    { label: 'HCS Topic', value: report.hederaEvidence.hcsTopicId, isMono: true },
                    { label: 'HCS sequence', value: isLive ? 'POD_SUBMITTED, POD_ADVISORY_ANCHORED' : nonLiveEvidenceLabel, isMono: true },
                    { label: 'Consensus timestamp', value: isLive ? evidence.timestamps.settlementConsensus || 'NOT AVAILABLE' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                  explorerLinks={[{ type: 'topic', id: report.hederaEvidence.hcsTopicId }]}
                />
              </div>
            </StepRow>

            {/* STEP 7 */}
            <StepRow stepNumber={7} title="REVIEW POD" actor="Shipper" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The shipper accepted the submitted POD and authorized freight settlement.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">POD decision</span><span className="font-bold text-[#168A4A]">ACCEPTED</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Shipper signature</span><span className="font-bold text-[#168A4A]">VERIFIED</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Settlement authorization</span><span className="font-bold text-[#168A4A]">APPROVED</span></div>
                </div>
                <TechEvidence
                  mechanism="Signed review decision ordered through HCS"
                  isLive={isLive}
                  identifiers={[
                    { label: 'HCS Action', value: isLive ? 'POD_REVIEW_ACTION — ACCEPT' : nonLiveEvidenceLabel, isMono: true },
                    { label: 'HCS Sequence 3', value: isLive ? 'VERIFIED' : nonLiveEvidenceLabel, isMono: true },
                    { label: 'Consensus timestamp', value: isLive ? evidence.timestamps.settlementConsensus || 'NOT AVAILABLE' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                  explorerLinks={[{ type: 'topic', id: report.hederaEvidence.hcsTopicId }]}
                />
              </div>
            </StepRow>

            {/* STEP 8 */}
            <StepRow stepNumber={8} title="RELEASE AND COMPLETE" actor="Escrow system & Carrier" isLive={isLive}>
              <div className="flex flex-col gap-2">
                <p className="font-montserrat text-sm text-[#15171A]">The winning carrier received the freight payment and the tender completed.</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 font-technical text-xs mt-2">
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Recipient</span><span className="font-bold">{isLive ? 'carrier-alpha' : 'carrier-sim'}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Amount received</span><span className="font-bold text-[#168A4A]">{formatUSDC(report.settlement.amount)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Source</span><span className="font-bold">RouteGuard freight escrow</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Final escrow state</span><span className="font-bold text-[#168A4A]">{report.settlement.escrowState}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Remaining locked</span><span className="font-bold">{formatUSDC(report.settlement.remainingLocked)}</span></div>
                  <div className="flex flex-col gap-1"><span className="text-[#8A8F98] uppercase">Tender</span><span className="font-bold text-[#168A4A]">COMPLETED</span></div>
                </div>
                <TechEvidence
                  mechanism="HTS USDC settlement · Smart-contract release · HCS completion evidence · Mirror verification"
                  isLive={isLive}
                  identifiers={[
                    { label: 'Release transaction', value: report.hederaEvidence.releaseTx, isMono: true },
                    { label: 'Escrow contract', value: report.hederaEvidence.escrowContractId, isMono: true },
                    { label: 'HCS Sequence', value: isLive ? '4 ESCROW_RELEASED, 5 TENDER_COMPLETED' : nonLiveEvidenceLabel, isMono: true },
                    { label: 'Consensus timestamp', value: isLive ? evidence.timestamps.settlementConsensus || 'NOT AVAILABLE' : nonLiveEvidenceLabel, isMono: true }
                  ]}
                  explorerLinks={[{ type: 'tx', id: report.hederaEvidence.releaseTx }, { type: 'topic', id: report.hederaEvidence.hcsTopicId }]}
                />
              </div>
            </StepRow>

          </div>
        </div>
      )}

    </div>
  );
};

// --- SUBCOMPONENTS ---

const StepRow: React.FC<{
  stepNumber: number;
  title: string;
  actor: string;
  isLive: boolean;
  children: React.ReactNode;
}> = ({ stepNumber, title, actor, isLive, children }) => (
  <div className="flex flex-col md:flex-row p-6 gap-6 group hover:bg-[#F7F8FA]/50 transition-colors">
    <div className="w-48 shrink-0 flex flex-col gap-1">
      <div className="flex items-center gap-2 font-technical text-xs font-bold text-[#8A8F98] uppercase tracking-wider">
        <span>STEP {stepNumber}</span>
      </div>
      <h4 className="font-montserrat font-bold text-[#15171A] text-sm uppercase">{title}</h4>
      <span className="font-technical text-[10px] text-[#60646C] uppercase tracking-wider bg-[#F1F3F5] px-2 py-0.5 rounded w-max mt-1">{actor}</span>
    </div>
    <div className="flex-1">
      {children}
    </div>
  </div>
);

const TechEvidence: React.FC<{
  mechanism: string;
  isLive: boolean;
  identifiers?: { label: string; value: string; isMono?: boolean }[];
  explorerLinks?: { type: 'topic' | 'tx' | 'account' | 'token'; id: string }[];
}> = ({ mechanism, isLive, identifiers, explorerLinks }) => {
  return (
    <details className="mt-4 border border-[#DDE1E6] rounded-[8px] overflow-hidden group/tech">
      <summary className="px-4 py-2.5 bg-[#F7F8FA] cursor-pointer text-xs font-montserrat font-semibold text-[#60646C] hover:text-[#15171A] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-technical uppercase tracking-wider text-[10px] bg-[#E2E4E9] px-1.5 py-0.5 rounded text-[#15171A]">MECHANISM</span>
          {mechanism}
        </div>
        <ChevronDown className="w-4 h-4 transition-transform group-open/tech:rotate-180 text-[#8A8F98]" />
      </summary>

      {identifiers && identifiers.length > 0 && (
        <div className="p-4 bg-white border-t border-[#DDE1E6]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 font-technical text-xs text-[#15171A]">
            {identifiers.map((id, i) => (
              <div key={i} className="flex justify-between items-center gap-4">
                <span className="text-[#8A8F98] uppercase min-w-[120px]">{id.label}</span>
                {isLive && id.isMono ? (
                  <CopyableIdentifier value={id.value} />
                ) : (
                  <span className={`${id.isMono ? 'font-mono text-[11px]' : ''} ${!isLive ? 'text-[#8A8F98]' : ''} text-right break-all`}>
                    {id.value}
                  </span>
                )}
              </div>
            ))}
          </div>

          {isLive && explorerLinks && explorerLinks.length > 0 && (
            <div className="mt-4 pt-3 border-t border-[#F1F3F5] flex flex-wrap gap-3">
              {explorerLinks.map((link, i) => (
                <ExternalExplorerLink key={i} type={link.type} id={link.id} />
              ))}
            </div>
          )}
        </div>
      )}
    </details>
  );
};
