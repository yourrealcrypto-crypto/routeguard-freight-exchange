import React from 'react';
import { CheckCircle2, ExternalLink, FileLock2, ShieldCheck } from 'lucide-react';
import { RouteGuardFooter } from '../components/RouteGuardFooter';
import { RouteGuardHeader } from '../components/RouteGuardHeader';
import type { RouteGuardEvidence } from '../data/routeguardEvidence';

interface Props { evidence: RouteGuardEvidence; onNavigate: (path: string) => void; }
export const PodReviewPage: React.FC<Props> = ({ evidence, onNavigate }) => {
  const pod = evidence.podReviewEvidence;
  return <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-[#15171A]">
    <RouteGuardHeader currentPath="/pod-review" onNavigate={onNavigate} />
    <main className="flex-1 w-full max-w-[1180px] mx-auto px-5 md:px-12 py-10 md:py-16">
      <section className="max-w-3xl mb-10">
        <div className="inline-flex items-center gap-2 rounded-full bg-[#8259EF]/10 px-3 py-1 font-technical text-[11px] font-bold tracking-wider text-[#6341C7]"><FileLock2 className="w-4 h-4" /> POD ASSURANCE REVIEW</div>
        <h1 className="mt-5 font-montserrat text-4xl md:text-5xl font-bold leading-tight">Delivery evidence stays private. Integrity becomes public.</h1>
        <p className="mt-4 font-montserrat text-base text-[#60646C] leading-relaxed">Synthetic POD documents were encrypted locally, signed by the carrier, reviewed with a deterministic non-binding adviser, accepted by the shipper, and anchored as an ordered HCS sequence. No plaintext was submitted to Hedera.</p>
      </section>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-[12px] border border-[#C1C7D0] bg-white p-6 shadow-sm">
          <h2 className="font-montserrat text-xl font-bold flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-[#168A4A]" /> Cryptographic checks</h2>
          <dl className="mt-5 space-y-4 font-technical text-xs">
            {[['Manifest hash', pod.manifestHash], ['Ciphertext hash', pod.ciphertextHash], ['Carrier signature', pod.carrierSignatureStatus], ['Shipper signature', pod.shipperSignatureStatus], ['Adviser', pod.adviser]].map(([label, value]) => <div key={label} className="border-b border-[#DDE1E6] pb-3"><dt className="uppercase tracking-wider text-[#8A8F98]">{label}</dt><dd className="mt-1 break-all font-bold text-[#15171A]">{value}</dd></div>)}
          </dl>
        </section>
        <section className="rounded-[12px] border border-[#C1C7D0] bg-[#11151D] p-6 text-white shadow-sm">
          <h2 className="font-montserrat text-xl font-bold">Consensus chronology</h2>
          <ol className="mt-5 space-y-3">{evidence.messages.map((message) => <li key={message.sequenceNumber} className="flex gap-3 rounded-[8px] border border-[#2E3132] bg-[#181C24] p-3"><CheckCircle2 className="w-5 h-5 shrink-0 text-[#168A4A]" /><div><div className="font-technical text-xs font-bold">{message.sequenceNumber}. {message.messageType}</div><div className="mt-1 font-montserrat text-xs text-[#8A8F98]">{message.freightMeaning}</div></div></li>)}</ol>
          <a href={`https://hashscan.io/testnet/topic/${pod.hcsTopic}`} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 font-technical text-xs font-bold text-[#88A4FF] hover:text-white">OPEN TOPIC {pod.hcsTopic} <ExternalLink className="w-4 h-4" /></a>
        </section>
      </div>
    </main>
    <RouteGuardFooter onNavigate={onNavigate} />
  </div>;
};
