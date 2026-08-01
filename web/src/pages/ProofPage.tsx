import React, { useState } from 'react';
import { getHashScanUrl, PROOF_SURFACES, RouteGuardEvidence } from '../data/routeguardEvidence';
import { RouteGuardHeader } from '../components/RouteGuardHeader';
import { RouteGuardFooter } from '../components/RouteGuardFooter';
import { ConsensusSequence } from '../components/ConsensusSequence';
import { CopyableIdentifier } from '../components/CopyableIdentifier';
import { ExternalExplorerLink } from '../components/ExternalExplorerLink';
import { Key, Lock, FileCheck, Banknote, ShieldCheck, ArrowRight, Activity, ChevronDown, CheckCircle2 } from 'lucide-react';

interface ProofPageProps {
  evidence: RouteGuardEvidence;
  onNavigate: (path: string) => void;
}

export const ProofPage: React.FC<ProofPageProps> = ({ evidence, onNavigate }) => {
  const { accessEvidence, escrowEvidence, podReviewEvidence, releaseEvidence, auction, payment } = evidence;

  const [activeTab, setActiveTab] = useState<number>(0);

  const TABS = [
    {
      id: 'x402-access',
      title: 'x402 Access',
      summary: 'Tender activation and carrier-offer access succeeded after protected x402 payments.',
      keyResult: '0.001 USDC per protected action',
      icon: Key,
    },
    {
      id: 'freight-escrow',
      title: 'Freight Escrow',
      summary: 'Maximum budget funded, winning amount allocated and excess returned.',
      keyResult: 'Final state — RELEASED',
      icon: Lock,
    },
    {
      id: 'pod-review',
      title: 'POD and Shipper Review',
      summary: 'Delivery evidence encrypted, signed and ordered before shipper acceptance.',
      keyResult: 'POD state — ACCEPTED',
      icon: FileCheck,
    },
    {
      id: 'freight-release',
      title: 'Freight Release',
      summary: 'Winning carrier payment released after accepted proof of delivery.',
      keyResult: '0.75 USDC released',
      icon: Banknote,
    }
  ];

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let newIndex = index;
    if (e.key === 'ArrowRight') {
      newIndex = (index + 1) % TABS.length;
    } else if (e.key === 'ArrowLeft') {
      newIndex = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === 'Home') {
      newIndex = 0;
    } else if (e.key === 'End') {
      newIndex = TABS.length - 1;
    }

    if (newIndex !== index) {
      setActiveTab(newIndex);
      const tabElement = document.getElementById(`tab-${TABS[newIndex].id}`);
      tabElement?.focus();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-[#15171A]">
      <RouteGuardHeader currentPath="/proof" onNavigate={onNavigate} />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-8 pb-10 md:pb-16">

        {/* COMPACT HERO SECTION */}
        <section className="flex flex-col items-center text-center gap-4 max-w-4xl mx-auto pt-10 pb-8 md:pt-14 md:pb-12">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 bg-[#168A4A]/10 border border-[#168A4A]/20 rounded-full">
              <span className="w-2.5 h-2.5 rounded-full bg-[#168A4A]" />
              <span className="font-technical text-xs font-semibold text-[#168A4A] uppercase tracking-wider">
                DEMO MODE · LIVE HEDERA TESTNET
              </span>
            </div>
            <div className="inline-flex items-center px-3.5 py-1 bg-[#F1F3F5] border border-[#DDE1E6] rounded-full">
              <span className="font-technical text-xs font-semibold text-[#8A8F98] uppercase tracking-wider">
                BUILT ON HEDERA
              </span>
            </div>
          </div>

          <h1 className="font-montserrat font-bold text-3xl md:text-5xl text-[#15171A] leading-tight max-w-3xl">
            The complete freight lifecycle, independently verifiable
          </h1>
        </section>

        {/* CENTERED INTRODUCTION */}
        <div className="flex flex-col items-center text-center gap-2 max-w-2xl mx-auto mb-2">
          <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Explore the proof</h2>
          <p className="font-montserrat text-sm text-[#60646C]">Select a freight outcome to inspect the verified Hedera execution behind it.</p>
        </div>

        {/* SINGLE PROOF VIEW CONTAINER */}
        <div className="flex flex-col gap-6">
          {/* FOUR INTERACTIVE PROOF CARDS */}
          <div
            role="tablist"
            aria-label="Freight lanes"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {TABS.map((tab, index) => {
              const isActive = activeTab === index;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`panel-${tab.id}`}
                  id={`tab-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTab(index)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                  className={`relative text-left p-6 rounded-[12px] border transition-colors flex flex-col h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0031FF] ${
                    isActive
                      ? 'bg-[#F7F8FA] border-[#DDE1E6] shadow-sm'
                      : 'bg-white border-[#DDE1E6] hover:border-[#8A8F98]'
                  }`}
                >
                  {isActive && <div className="absolute top-0 left-0 right-0 h-1 bg-[#0031FF] rounded-t-[12px]" />}

                  <div className="flex justify-between items-start w-full mb-4">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors shrink-0 ${isActive ? 'bg-[#0031FF] text-white' : 'bg-[#E5EDFF] text-[#0031FF]'}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="px-2 py-1 bg-[#168A4A]/10 text-[#168A4A] rounded text-[10px] font-technical uppercase font-bold shrink-0 ml-2">LIVE PROVEN</span>
                  </div>

                  <h3 className={`font-montserrat font-bold text-lg mb-2 transition-colors ${isActive ? 'text-[#0031FF]' : 'text-[#15171A]'}`}>{tab.title}</h3>

                  <div className="min-h-[3rem] mb-5">
                    <p className="font-montserrat text-xs text-[#60646C] leading-relaxed">{tab.summary}</p>
                  </div>

                  <div className={`mt-auto w-full pt-4 border-t ${isActive ? 'border-[#DDE1E6]' : 'border-[#DDE1E6]/50'}`}>
                    <span className="font-montserrat font-bold text-[#15171A] text-xs block">{tab.keyResult}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* SINGLE DETAIL PANEL */}
          <div
            role="tabpanel"
            id={`panel-${TABS[activeTab].id}`}
            aria-labelledby={`tab-${TABS[activeTab].id}`}
            tabIndex={0}
            className="bg-white rounded-[12px] p-6 md:p-10 border border-[#DDE1E6] shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0031FF]"
          >
            {activeTab === 0 && (
              <div className="flex flex-col gap-8 animate-in fade-in duration-300">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-[#DDE1E6] pb-6">
                  <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Paid access before freight actions</h2>
                  <div className="flex flex-col items-start md:items-end gap-1 bg-[#F7F8FA] px-4 py-3 rounded-[8px] border border-[#DDE1E6] w-full md:w-auto">
                    <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Hedera Mechanism</span>
                    <span className="font-montserrat font-bold text-sm text-[#15171A]">x402 exact payment on Hedera</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between border-b border-[#F1F3F5] pb-3">
                      <span className="font-montserrat text-sm text-[#60646C]">Tender activation:</span>
                      <span className="font-technical text-xs font-bold text-[#168A4A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4"/> LIVE PROVEN</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-[#F1F3F5] pb-3">
                      <span className="font-montserrat text-sm text-[#60646C]">Carrier-offer access:</span>
                      <span className="font-technical text-xs font-bold text-[#168A4A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4"/> LIVE PROVEN</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-[#F1F3F5] pb-3">
                      <span className="font-montserrat text-sm text-[#60646C]">Amount per protected action:</span>
                      <div className="text-right">
                        <div className="font-montserrat font-bold text-sm text-[#15171A]">{accessEvidence.amountDisplay}</div>
                        <div className="font-technical text-xs text-[#8A8F98]">{accessEvidence.amountAtomic} atomic USDC</div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 mt-2">
                      <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">Access treasury</span>
                      <CopyableIdentifier value={accessEvidence.accessTreasury} />
                    </div>
                    <div className="flex flex-col gap-1 mt-2">
                      <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">Token</span>
                      <CopyableIdentifier value={accessEvidence.tokenId} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2 bg-[#F7F8FA] p-5 rounded-[8px] border border-[#DDE1E6]">
                      <span className="font-technical text-xs font-bold tracking-wider text-[#8A8F98] uppercase">Why it matters</span>
                      <p className="font-montserrat text-sm text-[#15171A] leading-relaxed">Spam-resistant paid machine access is economically separate from the freight principal.</p>
                    </div>
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">Tender activation tx</span>
                          <ExternalExplorerLink type="tx" id={accessEvidence.tenderActivationTx} />
                        </div>
                        <CopyableIdentifier value={accessEvidence.tenderActivationTx} />
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">Carrier-offer tx</span>
                          <ExternalExplorerLink type="tx" id={accessEvidence.carrierOfferTx} />
                        </div>
                        <CopyableIdentifier value={accessEvidence.carrierOfferTx} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 1 && (
              <div className="flex flex-col gap-8 animate-in fade-in duration-300">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-[#DDE1E6] pb-6">
                  <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Freight budget secured before carrier selection</h2>
                  <div className="flex flex-col items-start md:items-end gap-1 bg-[#F7F8FA] px-4 py-3 rounded-[8px] border border-[#DDE1E6] w-full md:w-auto">
                    <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Hedera Mechanism</span>
                    <span className="font-montserrat font-bold text-sm text-[#15171A] md:text-right">HTS USDC · Smart contract<br/>Mirror verification</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-8">
                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-1">
                      <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98] mb-1">Escrow contract</span>
                      <CopyableIdentifier value={escrowEvidence.contractId} />
                    </div>

                    <div className="grid grid-cols-2 gap-4 border-b border-[#F1F3F5] pb-5">
                      <div className="flex flex-col gap-1">
                        <span className="font-montserrat text-xs text-[#60646C]">Maximum budget funded:</span>
                        <span className="font-montserrat font-bold text-base text-[#15171A]">{escrowEvidence.maxBudgetDisplay}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="font-montserrat text-xs text-[#60646C]">Winning amount allocated:</span>
                        <span className="font-montserrat font-bold text-base text-[#15171A]">{escrowEvidence.winningAmountDisplay}</span>
                      </div>
                      <div className="flex flex-col gap-1 mt-2">
                        <span className="font-montserrat text-xs text-[#60646C]">Excess returned:</span>
                        <span className="font-montserrat font-bold text-base text-[#15171A]">{escrowEvidence.excessReturnedDisplay}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 bg-[#F7F8FA] p-4 rounded-[8px] border border-[#DDE1E6]">
                      <div className="flex flex-col gap-1">
                        <span className="font-technical text-[10px] uppercase text-[#8A8F98] font-semibold">Initial state</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{escrowEvidence.stateAfterAllocation}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="font-technical text-[10px] uppercase text-[#8A8F98] font-semibold">Final state</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{escrowEvidence.finalState}</span>
                      </div>
                      <div className="flex flex-col gap-1 col-span-2 pt-2 border-t border-[#DDE1E6]">
                        <span className="font-technical text-[10px] uppercase text-[#8A8F98] font-semibold">Remaining locked after release</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{escrowEvidence.remainingLocked} USDC</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2 bg-[#F7F8FA] p-5 rounded-[8px] border border-[#DDE1E6]">
                      <span className="font-technical text-xs font-bold tracking-wider text-[#8A8F98] uppercase">Why it matters</span>
                      <p className="font-montserrat text-sm text-[#15171A] leading-relaxed">The shipper does not rely on an off-chain promise that funds exist.</p>
                    </div>

                    <div className="flex flex-col items-center bg-[#F7F8FA] p-6 rounded-[8px] border border-[#DDE1E6] gap-5">
                      <span className="font-technical text-[10px] tracking-wider text-[#8A8F98] uppercase font-bold w-full text-left">Money Flow</span>
                      <div className="flex items-center gap-2 font-montserrat font-bold text-[#15171A] bg-white px-5 py-2.5 border border-[#DDE1E6] rounded-[6px] shadow-sm">
                        {escrowEvidence.maxBudgetDisplay} funded
                      </div>
                      <ArrowRight className="w-5 h-5 text-[#8A8F98] rotate-90" />
                      <div className="flex flex-col md:flex-row items-center gap-3 w-full">
                        <div className="flex-1 w-full flex flex-col items-center gap-1 font-montserrat font-bold text-sm text-[#168A4A] bg-[#168A4A]/5 px-4 py-2.5 border border-[#168A4A]/30 rounded-[6px] text-center shadow-sm">
                          <span>{escrowEvidence.winningAmountDisplay}</span>
                          <span className="text-[10px] text-[#60646C] font-normal leading-tight">allocated</span>
                        </div>
                        <span className="font-bold text-[#8A8F98] md:my-0 my-1">+</span>
                        <div className="flex-1 w-full flex flex-col items-center gap-1 font-montserrat font-bold text-sm text-[#0031FF] bg-[#0031FF]/5 px-4 py-2.5 border border-[#0031FF]/30 rounded-[6px] text-center shadow-sm">
                          <span>{escrowEvidence.excessReturnedDisplay}</span>
                          <span className="text-[10px] text-[#60646C] font-normal leading-tight">returned</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 2 && (
              <div className="flex flex-col gap-10 animate-in fade-in duration-300">
                {/* PART A: POD AND SHIPPER-REVIEW EVIDENCE */}
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-[#DDE1E6] pb-6">
                    <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Delivery evidence encrypted, signed and ordered</h2>
                    <div className="flex flex-col items-start md:items-end gap-1 bg-[#F7F8FA] px-4 py-3 rounded-[8px] border border-[#DDE1E6] w-full md:w-auto">
                      <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Hedera Mechanism</span>
                      <span className="font-montserrat font-bold text-sm text-[#15171A] md:text-right">HCS ordering · Signatures<br/>Mirror verification</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                    <div className="flex flex-col gap-6">
                      <div className="flex items-center justify-between border-b border-[#F1F3F5] pb-4">
                        <span className="font-montserrat text-sm text-[#60646C]">POD state:</span>
                        <span className="font-technical text-sm font-bold text-[#168A4A]">{podReviewEvidence.state}</span>
                      </div>

                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">HCS topic</span>
                          <ExternalExplorerLink type="topic" id={podReviewEvidence.hcsTopic} />
                        </div>
                        <CopyableIdentifier value={podReviewEvidence.hcsTopic} />
                      </div>

                      <div className="flex flex-col gap-2 font-technical text-sm text-[#15171A]">
                        <div className="flex justify-between items-center bg-[#F7F8FA] p-2.5 border border-[#DDE1E6] rounded-[6px]">
                          <span className="text-[#60646C] text-xs">Sequence 1</span>
                          <span className="font-bold">POD_SUBMITTED</span>
                        </div>
                        <div className="flex justify-between items-center bg-[#F7F8FA] p-2.5 border border-[#DDE1E6] rounded-[6px]">
                          <span className="text-[#60646C] text-xs">Sequence 2</span>
                          <span className="font-bold">POD_ADVISORY_ANCHORED</span>
                        </div>
                        <div className="flex justify-between items-center bg-[#F7F8FA] p-2.5 border border-[#DDE1E6] rounded-[6px]">
                          <span className="text-[#60646C] text-xs">Sequence 3</span>
                          <span className="font-bold">POD_REVIEW_ACTION — ACCEPT</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1 border-t border-[#F1F3F5] pt-4 mt-2">
                        <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Adviser</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{podReviewEvidence.adviser}</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-6">
                      <div className="flex flex-col gap-2 bg-[#F7F8FA] p-5 rounded-[8px] border border-[#DDE1E6]">
                        <span className="font-technical text-xs font-bold tracking-wider text-[#8A8F98] uppercase">Why it matters</span>
                        <p className="font-montserrat text-sm text-[#15171A] leading-relaxed">The payment-release decision follows a signed and publicly ordered review outcome. No sensitive encryption material is public.</p>
                      </div>

                      <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                          <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98] mb-1">Package/Manifest Hash</span>
                          <CopyableIdentifier value={podReviewEvidence.manifestHash} truncate />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98] mb-1">Ciphertext/Integrity Hash</span>
                          <CopyableIdentifier value={podReviewEvidence.ciphertextHash} truncate />
                        </div>

                        <div className="flex justify-between items-center pt-2 border-t border-[#F1F3F5]">
                          <span className="font-montserrat text-sm text-[#60646C]">Carrier-signature verification:</span>
                          <span className="font-technical text-xs font-bold text-[#168A4A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4"/> {podReviewEvidence.carrierSignatureStatus}</span>
                        </div>
                        <div className="flex justify-between items-center pt-2">
                          <span className="font-montserrat text-sm text-[#60646C]">Shipper-signature verification:</span>
                          <span className="font-technical text-xs font-bold text-[#168A4A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4"/> {podReviewEvidence.shipperSignatureStatus}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* PART B: PROOF OF DELIVERY ON HEDERA */}
                <div className="mt-2">
                  <ConsensusSequence evidence={evidence} />
                </div>

                {/* PART C: OUTCOME AFTER SHIPPER ACCEPTANCE */}
                <div className="bg-[#F7F8FA] border border-[#DDE1E6] rounded-[10px] p-6 md:p-8">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                    <h3 className="font-montserrat font-bold text-lg text-[#15171A]">Outcome after shipper acceptance</h3>
                    <span className="font-technical text-xs text-[#8A8F98] font-semibold uppercase tracking-wider">HCS sequences 3–5 verified</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-6 font-technical">
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98] text-[10px] uppercase font-bold tracking-wider">POD</span>
                      <span className="text-[#15171A] text-sm font-bold">{podReviewEvidence.state}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98] text-[10px] uppercase font-bold tracking-wider">Escrow</span>
                      <span className="text-[#15171A] text-sm font-bold">{escrowEvidence.finalState}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98] text-[10px] uppercase font-bold tracking-wider">Carrier paid</span>
                      <span className="text-[#168A4A] text-sm font-bold">{releaseEvidence.releasedAmount}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98] text-[10px] uppercase font-bold tracking-wider">Tender</span>
                      <span className="text-[#15171A] text-sm font-bold">{auction.status}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 3 && (
              <div className="flex flex-col gap-8 animate-in fade-in duration-300">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-[#DDE1E6] pb-6">
                  <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">Carrier payment released after accepted POD</h2>
                  <div className="flex flex-col items-start md:items-end gap-1 bg-[#F7F8FA] px-4 py-3 rounded-[8px] border border-[#DDE1E6] w-full md:w-auto">
                    <span className="font-technical text-[10px] font-bold tracking-wider text-[#8A8F98] uppercase">Hedera Mechanism</span>
                    <span className="font-montserrat font-bold text-sm text-[#15171A] md:text-right">HTS settlement · Smart contract<br/>HCS completion</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-1 bg-[#168A4A]/5 p-5 rounded-[8px] border border-[#168A4A]/20">
                      <span className="font-technical text-[10px] text-[#168A4A] font-bold tracking-wider uppercase">Released amount</span>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="font-montserrat font-bold text-2xl text-[#15171A]">{releaseEvidence.releasedAmount}</span>
                        <span className="font-technical text-xs text-[#60646C]">{releaseEvidence.releasedAtomicAmount} atomic USDC</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center border-b border-[#F1F3F5] pb-3">
                      <span className="font-montserrat text-sm text-[#60646C]">Carrier balance increase:</span>
                      <span className="font-technical text-sm font-bold text-[#168A4A]">{releaseEvidence.carrierBalanceIncrease}</span>
                    </div>

                    <div className="flex flex-col gap-1 mt-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98]">Release transaction</span>
                        <ExternalExplorerLink type="tx" id={releaseEvidence.releaseTransaction} />
                      </div>
                      <CopyableIdentifier value={releaseEvidence.releaseTransaction} />
                    </div>

                    <div className="flex flex-col gap-1 mt-2">
                      <span className="font-montserrat text-xs font-semibold uppercase text-[#8A8F98] mb-1">Escrow contract</span>
                      <CopyableIdentifier value={releaseEvidence.escrowContract} />
                    </div>

                    <div className="flex justify-between items-center bg-[#F7F8FA] p-4 rounded-[8px] border border-[#DDE1E6] mt-2">
                      <div className="flex flex-col gap-1">
                        <span className="font-technical text-[10px] uppercase text-[#8A8F98] font-semibold">Final state</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{releaseEvidence.finalContractState}</span>
                      </div>
                      <div className="flex flex-col gap-1 text-right">
                        <span className="font-technical text-[10px] uppercase text-[#8A8F98] font-semibold">Remaining locked</span>
                        <span className="font-technical text-sm font-bold text-[#15171A]">{releaseEvidence.remainingLockedAmount} USDC</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2 bg-[#F7F8FA] p-5 rounded-[8px] border border-[#DDE1E6]">
                      <span className="font-technical text-xs font-bold tracking-wider text-[#8A8F98] uppercase">Why it matters</span>
                      <p className="font-montserrat text-sm text-[#15171A] leading-relaxed">The freight principal moved only after the accepted proof-of-delivery outcome.</p>
                    </div>

                    <div className="flex flex-col gap-3 font-technical text-sm text-[#15171A]">
                      <span className="font-technical text-[10px] text-[#8A8F98] uppercase font-bold tracking-wider">HCS Chronology Completion</span>
                      <div className="flex justify-between items-center bg-[#F7F8FA] p-2.5 border border-[#DDE1E6] rounded-[6px]">
                        <span className="text-[#60646C] text-xs">Sequence 4</span>
                        <span className="font-bold">ESCROW_RELEASED</span>
                      </div>
                      <div className="flex justify-between items-center bg-[#F7F8FA] p-2.5 border border-[#DDE1E6] rounded-[6px]">
                        <span className="text-[#60646C] text-xs">Sequence 5</span>
                        <span className="font-bold">TENDER_COMPLETED</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <section className="rounded-[12px] border border-[#C1C7D0] bg-[#11151D] p-6 md:p-8 text-white">
          <div className="max-w-2xl mb-6"><h2 className="font-montserrat text-2xl font-bold">Public proof registry</h2><p className="mt-2 font-montserrat text-sm text-[#8A8F98]">These identifiers keep the protocol-level HTTP 402 proof, final reservation auction, and v2 freight lifecycle distinct.</p></div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 font-technical text-xs">
            {[
              ['Canonical HTTP 402', PROOF_SURFACES.canonicalHttp402.transactionId, PROOF_SURFACES.canonicalHttp402.url],
              ['Final reservation payment', PROOF_SURFACES.finalReservation.transactionId, PROOF_SURFACES.finalReservation.url],
              ['Final auction topic', PROOF_SURFACES.finalAuction.topicId, PROOF_SURFACES.finalAuction.url],
              ['Final topic creation', PROOF_SURFACES.finalAuction.topicCreateTransactionId, PROOF_SURFACES.finalAuction.createUrl],
              ['V2 tender activation', PROOF_SURFACES.v2.tenderActivationTransactionId, getHashScanUrl('tx', PROOF_SURFACES.v2.tenderActivationTransactionId)],
              ['V2 carrier access', PROOF_SURFACES.v2.carrierBidTransactionId, getHashScanUrl('tx', PROOF_SURFACES.v2.carrierBidTransactionId)],
              ['V2 freight escrow', PROOF_SURFACES.v2.escrowContractId, `https://hashscan.io/testnet/contract/${PROOF_SURFACES.v2.escrowContractId}`],
              ['V2 POD topic', PROOF_SURFACES.v2.podTopicId, getHashScanUrl('topic', PROOF_SURFACES.v2.podTopicId)],
              ['V2 freight release', PROOF_SURFACES.v2.freightReleaseTransactionId, getHashScanUrl('tx', PROOF_SURFACES.v2.freightReleaseTransactionId)],
            ].map(([label, value, href]) => <a key={label} href={href} target="_blank" rel="noreferrer" className="rounded-[8px] border border-[#2E3132] bg-[#181C24] p-4 hover:border-[#0031FF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#88A4FF]"><span className="block uppercase tracking-wider text-[#8A8F98]">{label}</span><span className="mt-2 block break-all font-bold text-[#DFE2EE]">{value}</span></a>)}
          </div>
        </section>

        {/* HISTORICAL V1 EVIDENCE (COLLAPSED) */}
        <section className="mb-4">
          <details className="group border border-[#DDE1E6] rounded-[12px] bg-white overflow-hidden">
            <summary className="flex items-center justify-between p-4 md:p-6 cursor-pointer hover:bg-[#F7F8FA] transition-colors list-none font-montserrat font-bold text-[#15171A] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0031FF]">
              <div className="flex items-center gap-4">
                <span className="text-base">Historical v1 reservation proof</span>
                <span className="px-2 py-1 bg-[#F1F3F5] text-[#60646C] rounded text-[10px] font-technical uppercase font-bold tracking-wider">ARCHIVED DEMONSTRATION</span>
              </div>
              <ChevronDown className="w-5 h-5 text-[#8A8F98] group-open:-rotate-180 transition-transform" />
            </summary>
            <div className="p-4 md:p-6 border-t border-[#DDE1E6] bg-[#F7F8FA]">
              <p className="font-montserrat text-sm text-[#60646C] mb-4">
                Earlier RouteGuard proof demonstrating a direct reservation payment before the v2 escrow, POD and release lifecycle was completed.
              </p>
              <div className="flex flex-col gap-2 font-technical text-xs text-[#15171A]">
                <div className="flex justify-between border-b border-[#DDE1E6] pb-2">
                  <span className="text-[#8A8F98] uppercase">Amount</span>
                  <span className="font-bold">{payment.amountFormatted} ({payment.amountAtomic})</span>
                </div>
                <div className="flex justify-between border-b border-[#DDE1E6] pb-2">
                  <span className="text-[#8A8F98] uppercase">Transaction</span>
                  <span className="font-bold">{evidence.hashes.paymentTxId}</span>
                </div>
                <div className="flex justify-between border-b border-[#DDE1E6] pb-2">
                  <span className="text-[#8A8F98] uppercase">Status</span>
                  <span className="font-bold">{payment.status}</span>
                </div>
              </div>
            </div>
          </details>
        </section>

      </main>

      <RouteGuardFooter onNavigate={onNavigate} />
    </div>
  );
};
