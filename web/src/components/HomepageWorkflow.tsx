import React from 'react';
import {
  ClipboardList,
  Key,
  FileUp,
  CheckCircle2,
  Lock,
  Truck,
  ShieldCheck,
  UserCheck,
  CircleDollarSign,
  ArrowRight,
  Database,
  Cpu,
  FileCode2,
  FileKey,
  Globe
} from 'lucide-react';
import { HederaAttribution } from './brand/HederaAttribution';

interface HomepageWorkflowProps {
  onExploreClick?: () => void;
}

export const HomepageWorkflow: React.FC<HomepageWorkflowProps> = ({ onExploreClick }) => {
  const stages = [
    {
      num: '01',
      title: 'Shipment defined and maximum budget secured',
      desc: 'The shipper defines the route, cargo, weight, transport mode, pickup window, delivery deadline and carrier requirements. The maximum freight budget is then secured in escrow before the tender opens.',
      layerLabel: 'Hedera layer',
      layerVal: 'HTS USDC · Smart-contract custody',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: ClipboardList
    },
    {
      num: '02',
      title: 'Tender activated through x402',
      desc: 'The completed shipment request is activated and made available to qualified carriers.',
      layerLabel: 'Hedera layer',
      layerVal: 'x402 exact access payment on Hedera',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: Key
    },
    {
      num: '03',
      title: 'Carrier offers submitted',
      desc: 'Qualified carriers review the fixed shipment requirements and submit durable offers.',
      layerLabel: 'Hedera layer',
      layerVal: 'x402-gated carrier offer submission',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: FileUp
    },
    {
      num: '04',
      title: 'Winner selected by shipper-defined rules',
      desc: 'RouteGuard applies the qualification and pricing rules defined by the shipper before bidding began.',
      layerLabel: 'Hedera layer',
      layerVal: 'Deterministic selection · Verifiable result',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: CheckCircle2
    },
    {
      num: '05',
      title: 'Winning amount locked and excess returned',
      desc: 'After the winner is selected, 0.75 USDC remains locked for the winning carrier until proof of delivery is accepted. The unused 0.25 USDC is returned to the shipper.',
      layerLabel: 'Hedera layer',
      layerVal: 'HTS allocation · Excess refund · Smart-contract custody',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: Lock
    },
    {
      num: '06',
      title: 'Transport against agreed requirements',
      desc: 'The carrier performs pickup and delivery under the route, weight, transport mode, dates and operating requirements fixed by the shipper.',
      layerLabel: 'Supporting layer',
      layerVal: 'Tender requirements fixed before carrier offers',
      status: 'DEMO FREIGHT SCENARIO',
      statusColor: 'text-[#8259EF]',
      statusBg: 'bg-[#8259EF]/10',
      statusBorder: 'border-[#8259EF]/30',
      icon: Truck
    },
    {
      num: '07',
      title: 'Encrypted POD submitted',
      desc: 'The carrier signs and encrypts the proof-of-delivery package. Its public integrity evidence is anchored through HCS.',
      layerLabel: 'Hedera layer',
      layerVal: 'Encrypted package · HCS integrity anchor',
      status: 'LIVE HEDERA PROOF',
      statusColor: 'text-[#0031FF]',
      statusBg: 'bg-[#0031FF]/10',
      statusBorder: 'border-[#0031FF]/30',
      icon: ShieldCheck
    },
    {
      num: '08',
      title: 'Shipper accepts POD',
      desc: 'The shipper checks the submitted delivery evidence and signs the acceptance decision authorizing settlement.',
      layerLabel: 'Hedera layer',
      layerVal: 'Signed acceptance · HCS consensus ordering',
      status: 'LIVE HEDERA PROOF',
      statusColor: 'text-[#0031FF]',
      statusBg: 'bg-[#0031FF]/10',
      statusBorder: 'border-[#0031FF]/30',
      icon: UserCheck
    },
    {
      num: '09',
      title: 'Carrier payment released',
      desc: 'After POD acceptance, the escrow contract releases 0.75 USDC to the winning carrier. Tender completed.',
      layerLabel: 'Hedera layer',
      layerVal: 'HTS settlement · HCS completion · Mirror verified',
      status: 'LIVE PROVEN',
      statusColor: 'text-[#168A4A]',
      statusBg: 'bg-[#168A4A]/10',
      statusBorder: 'border-[#168A4A]/30',
      icon: CircleDollarSign
    },
  ];

  return (
    <>
      {/* Freight Workflow Section */}
      <section className="w-full bg-[#FFFFFF] border-t border-[#DDE1E6] py-16 md:py-24 relative">
        <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-16 md:gap-24">

          <div className="text-left max-w-3xl flex flex-col gap-4">
            <h2 className="font-montserrat font-bold text-2xl md:text-4xl text-[#15171A]">
              From shipment request to carrier payment
            </h2>
            <p className="font-montserrat text-base md:text-lg text-[#60646C]">
              RouteGuard keeps the shipper’s requirements, carrier selection, delivery evidence and payment release connected through one verifiable freight lifecycle.
            </p>
          </div>

          {/* 9 Stages Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {stages.map((step) => {
              const IconComp = step.icon;
              return (
                <div
                  key={step.num}
                  className="p-6 rounded-[12px] bg-white border border-[#DDE1E6] shadow-sm hover:shadow-md text-[#15171A] transition-shadow flex flex-col justify-between gap-6"
                >
                  <div className="flex flex-col gap-5">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-[#0031FF]/10 flex items-center justify-center">
                          <IconComp className="w-5 h-5 text-[#0031FF]" />
                        </div>
                        <span className="font-technical font-bold text-xl text-[#8A8F98]">
                          {step.num}
                        </span>
                      </div>
                      <span className={`px-2 py-1 ${step.statusBg} border ${step.statusBorder} rounded text-[10px] font-technical ${step.statusColor} uppercase tracking-wider font-bold text-center`}>
                        {step.status}
                      </span>
                    </div>

                    <div className="flex flex-col gap-2">
                      <h3 className="font-montserrat font-bold text-lg text-[#15171A] leading-tight">
                        {step.title}
                      </h3>
                      <p className="font-montserrat text-sm leading-relaxed text-[#60646C]">
                        {step.desc}
                      </p>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-[#DDE1E6] flex flex-col gap-1 text-xs">
                    <span className="font-technical text-[#8A8F98]">{step.layerLabel}:</span>
                    <span className="font-montserrat font-semibold text-[#0031FF] flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#0031FF]" />
                      {step.layerVal}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Hedera Infrastructure Section */}
      <section className="w-full bg-[#11151D] border-t border-[#2E3132] py-16 md:py-24">
        <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-16 md:gap-24">

          <div className="flex flex-col gap-6 max-w-3xl">
            <h2 className="font-montserrat font-bold text-2xl md:text-4xl text-white">
              Hedera infrastructure beneath every critical freight event
            </h2>
            <p className="font-montserrat text-base md:text-lg text-[#8A8F98]">
              RouteGuard uses distinct Hedera services for access, freight custody, ordered evidence and public verification.
            </p>
            <div className="flex items-center gap-3 mt-2">
              <HederaAttribution variant="section" dark={true} />
            </div>
          </div>

          {/* Connected Rail Points */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative">

            <div className="hidden md:block absolute top-6 left-12 right-12 h-0.5 bg-[#2E3132] -z-10" />

            {/* Point 1 */}
            <div className="flex flex-col items-center text-center gap-3 bg-[#11151D] flex-1">
              <div className="w-12 h-12 rounded-full bg-[#181C24] border border-[#2E3132] flex items-center justify-center">
                <Database className="w-5 h-5 text-[#2D84EB]" />
              </div>
              <div className="flex flex-col gap-1 items-center">
                <span className="font-technical font-bold text-sm text-white">HTS USDC</span>
                <span className="font-montserrat text-xs text-[#8A8F98]">Freight custody</span>
              </div>
            </div>

            {/* Point 2 */}
            <div className="flex flex-col items-center text-center gap-3 bg-[#11151D] flex-1">
              <div className="w-12 h-12 rounded-full bg-[#181C24] border border-[#2E3132] flex items-center justify-center">
                <Cpu className="w-5 h-5 text-[#8259EF]" />
              </div>
              <div className="flex flex-col gap-1 items-center">
                <span className="font-technical font-bold text-sm text-white">x402</span>
                <span className="font-montserrat text-xs text-[#8A8F98]">Paid machine access</span>
              </div>
            </div>

            {/* Point 3 */}
            <div className="flex flex-col items-center text-center gap-3 bg-[#11151D] flex-1">
              <div className="w-12 h-12 rounded-full bg-[#181C24] border border-[#2E3132] flex items-center justify-center">
                <FileCode2 className="w-5 h-5 text-[#168A4A]" />
              </div>
              <div className="flex flex-col gap-1 items-center">
                <span className="font-technical font-bold text-sm text-white">Smart Contract</span>
                <span className="font-montserrat text-xs text-[#8A8F98]">Allocation and refund</span>
              </div>
            </div>

            {/* Point 4 */}
            <div className="flex flex-col items-center text-center gap-3 bg-[#11151D] flex-1">
              <div className="w-12 h-12 rounded-full bg-[#181C24] border border-[#2E3132] flex items-center justify-center">
                <FileKey className="w-5 h-5 text-[#0031FF]" />
              </div>
              <div className="flex flex-col gap-1 items-center">
                <span className="font-technical font-bold text-sm text-white">HCS</span>
                <span className="font-montserrat text-xs text-[#8A8F98]">Ordered delivery evidence</span>
              </div>
            </div>

            {/* Point 5 */}
            <div className="flex flex-col items-center text-center gap-3 bg-[#11151D] flex-1">
              <div className="w-12 h-12 rounded-full bg-[#181C24] border border-[#2E3132] flex items-center justify-center">
                <Globe className="w-5 h-5 text-[#DFE2EE]" />
              </div>
              <div className="flex flex-col gap-1 items-center">
                <span className="font-technical font-bold text-sm text-white">Mirror Node</span>
                <span className="font-montserrat text-xs text-[#8A8F98]">Public verification</span>
              </div>
            </div>

          </div>
        </div>
      </section>
    </>
  );
};
