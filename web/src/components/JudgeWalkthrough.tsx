import React, { useState } from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { ProofTimeline } from './ProofTimeline';
import { PaymentProof } from './PaymentProof';
import { ConsensusSequence } from './ConsensusSequence';
import { EvidenceDownloadButton } from './EvidenceDownloadButton';
import { ExternalExplorerLink } from './ExternalExplorerLink';
import { RouteGuardBrand } from './brand/RouteGuardBrand';
import {
  Play,
  RotateCcw,
  CheckCircle2,
  ShieldCheck,
  ArrowRight,
  Gavel,
  Clock,
  ExternalLink,
  Award,
  Layers,
} from 'lucide-react';

interface JudgeWalkthroughProps {
  evidence: RouteGuardEvidence;
  onNavigate: (path: string) => void;
}

export const JudgeWalkthrough: React.FC<JudgeWalkthroughProps> = ({ evidence, onNavigate }) => {
  const [activeStep, setActiveStep] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const steps = [
    {
      id: 1,
      title: '1. Freight Tender & Carrier Auction',
      tagline: 'Logistics Function First',
      desc: 'Shippers open tenders with precise pickup and delivery parameters. Carriers submit private bid commitments into the tender pool.',
      focusAnchor: 'Tender #4091 · SEA to CHI · 2 Carrier Commitments',
    },
    {
      id: 2,
      title: '2. Deterministic Winner Selection',
      tagline: 'Zero Arbitrary Discretion',
      desc: 'RouteGuard engine evaluates all bid commitments deterministically on price, reliability, and lead time. carrier-alpha is selected.',
      focusAnchor: 'Winner: carrier-alpha · Manifest sha256:1f0e40ccb...',
    },
    {
      id: 3,
      title: '3. x402 Payment Settlement',
      tagline: 'Commercial Rule: Settlement First',
      desc: 'No confirmed settlement means no ROUTE_RESERVED. x402 machine payment executes 0.01 USDC from shipper to carrier account.',
      focusAnchor: 'TxID: 0.0.7162784@1785173890.867086556 · Amount: 0.01 USDC',
    },
    {
      id: 4,
      title: '4. Mirror Confirmation & Route Reservation',
      tagline: '6.48s Settlement-to-Reservation',
      desc: 'Hedera mirror node confirms payment settlement. RouteGuard immediately publishes HCS Sequence 5 ROUTE_RESERVED.',
      focusAnchor: 'HCS Topic: 0.0.9794225 · Sequence 5 ROUTE_RESERVED',
    },
    {
      id: 5,
      title: '5. Independent Verification & Audit',
      tagline: 'Cryptographic Proof on Public Ledger',
      desc: 'Auditors inspect live HashScan records or export verifiable JSON evidence payload embedding transaction IDs & timestamps.',
      focusAnchor: 'Verifiable JSON Payload · HashScan Ledger Links',
    },
  ];

  const handleNext = () => {
    if (activeStep < 5) setActiveStep((prev) => prev + 1);
  };

  const handlePrev = () => {
    if (activeStep > 1) setActiveStep((prev) => prev - 1);
  };

  const handleAutoPlay = () => {
    setIsPlaying(true);
    setActiveStep(1);
    let step = 1;
    const interval = setInterval(() => {
      step += 1;
      if (step <= 5) {
        setActiveStep(step);
      } else {
        clearInterval(interval);
        setIsPlaying(false);
      }
    }, 2500);
  };

  return (
    <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 py-10 flex flex-col gap-10">
      {/* Top Banner */}
      <div className="bg-[#11151D] text-white rounded-[12px] p-6 md:p-10 border border-[#2E3132] relative overflow-hidden shadow-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div className="flex flex-col gap-3 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#181C24] border border-[#2E3132] rounded-full w-max">
            <Gavel className="w-4 h-4 text-[#0031FF]" />
            <span className="font-montserrat font-bold text-xs uppercase tracking-widest text-[#2D84EB]">
              RouteGuard Control — 2-Minute Judge Walkthrough
            </span>
          </div>
          <h1 className="font-montserrat font-bold text-2xl md:text-4xl text-white">
            Settlement before reservation, independently verifiable.
          </h1>
          <p className="font-montserrat text-sm md:text-base text-[#8A8F98]">
            Step-by-step institutional evidence walkthrough demonstrating deterministic freight selection, x402 payment, and Hedera Consensus Service timestamping.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 shrink-0">
          <button
            onClick={handleAutoPlay}
            disabled={isPlaying}
            className="h-11 px-6 bg-[#0031FF] text-white rounded-[10px] font-montserrat font-bold text-xs uppercase tracking-wider inline-flex items-center gap-2 hover:bg-[#0027D4] transition-colors disabled:opacity-50"
          >
            <Play className="w-4 h-4 fill-white" />
            <span>{isPlaying ? 'Playing Walkthrough...' : 'Auto-Play Walkthrough'}</span>
          </button>
          <EvidenceDownloadButton variant="dark" />
        </div>
      </div>

      {/* Step Indicator Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        {steps.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveStep(s.id)}
            className={`p-4 rounded-[10px] border text-left flex flex-col gap-1 transition-all ${
              activeStep === s.id
                ? 'bg-[#11151D] text-white border-[#0031FF] shadow-md ring-2 ring-[#0031FF]'
                : s.id < activeStep
                ? 'bg-white text-[#15171A] border-[#168A4A]'
                : 'bg-[#F1F3F5] text-[#60646C] border-[#DDE1E6]'
            }`}
          >
            <div className="flex justify-between items-center text-xs font-technical font-semibold">
              <span>Step 0{s.id}</span>
              {s.id < activeStep && <CheckCircle2 className="w-4 h-4 text-[#168A4A]" />}
            </div>
            <span className="font-montserrat font-bold text-xs truncate">{s.title.split('.')[1]}</span>
          </button>
        ))}
      </div>

      {/* Active Step Highlight Box */}
      <div className="bg-white rounded-[12px] border border-[#DDE1E6] p-6 md:p-8 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div className="flex flex-col gap-2 max-w-2xl">
          <div className="flex items-center gap-2 text-[#0031FF] font-montserrat font-bold text-xs uppercase tracking-wider">
            <Award className="w-4 h-4" />
            <span>{steps[activeStep - 1].tagline}</span>
          </div>
          <h2 className="font-montserrat font-bold text-2xl text-[#15171A]">
            {steps[activeStep - 1].title}
          </h2>
          <p className="font-montserrat text-base text-[#60646C]">
            {steps[activeStep - 1].desc}
          </p>
          <div className="mt-2 font-technical text-xs bg-[#F1F3F5] p-2.5 rounded border border-[#DDE1E6] text-[#15171A] font-semibold">
            Anchor: {steps[activeStep - 1].focusAnchor}
          </div>
        </div>

        <div className="flex items-center gap-3 self-end md:self-auto">
          <button
            onClick={handlePrev}
            disabled={activeStep === 1}
            className="h-10 px-4 bg-[#F1F3F5] text-[#15171A] rounded-[8px] font-montserrat font-semibold text-xs uppercase disabled:opacity-40"
          >
            Previous
          </button>
          <button
            onClick={handleNext}
            disabled={activeStep === 5}
            className="h-10 px-5 bg-[#000000] text-white rounded-[8px] font-montserrat font-semibold text-xs uppercase flex items-center gap-2 disabled:opacity-40"
          >
            <span>Next Step</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Embedded Live Evidence Component Renderings for Judge Inspection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column (8 cols): Timeline + Payment Proof */}
        <div className="lg:col-span-8 flex flex-col gap-8">
          <ProofTimeline evidence={evidence} />
          <PaymentProof evidence={evidence} variant="light" />
        </div>

        {/* Right Column (4 cols): Consensus Sequence + HashScan Links */}
        <div className="lg:col-span-4 flex flex-col gap-8">
          <ConsensusSequence evidence={evidence} variant="light" />

          {/* Quick Explorer Actions */}
          <div className="bg-white border border-[#DDE1E6] rounded-[12px] p-6 shadow-sm flex flex-col gap-4">
            <h3 className="font-montserrat font-bold text-base text-[#15171A] flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#2D84EB]" />
              <span>Public Verification Links</span>
            </h3>
            <p className="font-montserrat text-xs text-[#60646C]">
              Verify exact testnet transactions and HCS topic ordering directly on the public HashScan mirror explorer:
            </p>
            <div className="flex flex-col gap-2.5">
              <ExternalExplorerLink
                type="tx"
                id={evidence.hashes.paymentTxId}
                label="Verify Payment Transaction on HashScan"
                variant="button"
              />
              <ExternalExplorerLink
                type="topic"
                id={evidence.topic.topicId}
                label="Inspect HCS Topic 0.0.9794225"
                variant="button"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
