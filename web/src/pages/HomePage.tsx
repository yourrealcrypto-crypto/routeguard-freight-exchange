import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { RouteGuardHeader } from '../components/RouteGuardHeader';
import { RouteGuardFooter } from '../components/RouteGuardFooter';
import { HomepageWorkflow } from '../components/HomepageWorkflow';
import { HederaAttribution } from '../components/brand/HederaAttribution';
import { ShieldCheck, ArrowRight, CheckCircle2, ChevronRight, Info, ArrowDown, ArrowDownRight, ArrowDownLeft } from 'lucide-react';

interface HomePageProps {
  evidence: RouteGuardEvidence;
  onNavigate: (path: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ evidence, onNavigate }) => {
  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-[#15171A]">
      <RouteGuardHeader currentPath="/" onNavigate={onNavigate} />

      <main className="flex-1 w-full">
        {/* Hero Section */}
        <section className="w-full py-16 md:py-24">
          <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 grid grid-cols-1 lg:grid-cols-12 gap-16 md:gap-24 items-start">
            {/* Left Content */}
            <div className="lg:col-span-6 flex flex-col gap-8">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-[#F1F3F5] rounded-full border border-[#DDE1E6] w-max">
                <span className="w-2.5 h-2.5 rounded-full bg-[#168A4A]" />
                <span className="font-montserrat font-bold text-xs text-[#15171A] uppercase tracking-wider">
                  Settlement-Backed Capacity Confirmation
                </span>
              </div>

              <h1 className="font-montserrat font-bold text-3xl sm:text-5xl md:text-6xl text-[#15171A] leading-[1.08] tracking-tight">
                Autonomous freight auctions with payment-backed delivery assurance
              </h1>

              <p className="font-montserrat text-base md:text-xl text-[#60646C] leading-relaxed max-w-2xl">
                RouteGuard coordinates freight access, carrier offers, escrowed freight funds, encrypted proof of delivery and settlement through Hedera.
              </p>

              {/* Hedera Subordinate Strip */}
              <div className="flex flex-col gap-4 mt-2 border-l-2 border-[#DDE1E6] pl-5">
                <div className="flex items-center gap-3">
                  <HederaAttribution variant="section" />
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-xs font-technical text-[#60646C]">
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]" /> HTS Escrow</span>
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]" /> HCS Evidence</span>
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]" /> Smart Contracts</span>
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#168A4A]" /> Mirror Verification</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 mt-4">
                <button
                  onClick={() => onNavigate('/proof')}
                  className="h-14 px-8 bg-[#000000] text-white rounded-[10px] font-montserrat font-bold text-xs uppercase tracking-widest hover:bg-[#222222] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] flex items-center justify-center gap-2 shadow-md cursor-pointer"
                >
                  <span>VIEW LIVE PROOF</span>
                  <ArrowRight className="w-4 h-4 text-[#2D84EB]" />
                </button>
                <button onClick={() => onNavigate('/control')} className="h-14 px-8 bg-white text-[#15171A] border border-[#C1C7D0] rounded-[10px] font-montserrat font-bold text-xs uppercase tracking-widest hover:border-[#15171A] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] flex items-center justify-center gap-2">
                  OPERATE THE DEMO
                </button>
              </div>
            </div>

            {/* Right Graphic: Shipper Summary Panel */}
            <div className="lg:col-span-6 flex justify-center w-full">
              <div className="w-full max-w-md bg-[#FFFFFF] rounded-[12px] border border-[#DDE1E6] shadow-xl overflow-hidden flex flex-col">

                {/* Header */}
                <div className="bg-[#F1F3F5] border-b border-[#DDE1E6] p-4 flex flex-col gap-3">
                  <div className="flex justify-between items-center">
                    <span className="font-montserrat font-bold text-sm text-[#15171A]">SHIPPER VIEW</span>
                    <div
                      className="px-2.5 py-1 bg-[#8259EF]/10 border border-[#8259EF]/30 rounded text-[10px] font-technical text-[#8259EF] uppercase tracking-wider font-bold flex items-center gap-1.5 cursor-help"
                      title="Simulated freight scenario using verified Hedera testnet execution."
                    >
                      <span>DEMO MODE · LIVE HEDERA TESTNET</span>
                      <Info className="w-3 h-3" />
                    </div>
                  </div>
                  <div className="flex justify-between items-center bg-[#168A4A]/10 border border-[#168A4A]/20 p-2.5 rounded-[6px]">
                    <span className="font-technical font-semibold text-xs text-[#168A4A]">TENDER COMPLETED</span>
                    <CheckCircle2 className="w-4 h-4 text-[#168A4A]" />
                  </div>
                </div>

                {/* Body Fields */}
                <div className="p-5 flex flex-col gap-4 font-technical text-xs">
                  <div className="grid grid-cols-2 gap-y-4 gap-x-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Route:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.routeOrigin} &rarr; {evidence.auction.routeDestination}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Equipment:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.equipmentType}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Weight:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.weight || '18,000 kg'}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Transport mode:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.transportMode || 'Intermodal'}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Pickup window:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.pickupWindow || '03–04 Aug 2026'}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Delivery deadline:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.auction.deliveryDeadline || '08 Aug 2026'}</span>
                    </div>
                  </div>

                  <hr className="border-[#DDE1E6]" />

                  <div className="grid grid-cols-2 gap-y-4 gap-x-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Maximum budget:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.economics.maximumFreightPrincipal.display}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Winning offer:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.economics.winningFreightSettlement.display}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Returned to shipper:</span>
                      <span className="text-[#168A4A] font-semibold">{evidence.economics.excessRefund.display}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Winning carrier:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.winner.selectedCarrier}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">POD:</span>
                      <span className="text-[#15171A] font-semibold">ACCEPTED</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8A8F98]">Settlement:</span>
                      <span className="text-[#15171A] font-semibold">{evidence.releaseEvidence.finalContractState}</span>
                    </div>
                  </div>

                  <hr className="border-[#DDE1E6]" />

                  <div className="flex flex-col text-[#60646C]">
                    <span className="text-[#8A8F98]">Adviser:</span>
                    <span>Deterministic · Non-binding</span>
                  </div>

                  {/* Native Expander */}
                  <details className="group border border-[#DDE1E6] rounded-[8px] bg-[#F7F8FA] overflow-hidden mt-2">
                    <summary className="p-3 cursor-pointer font-montserrat font-semibold text-xs text-[#0031FF] flex items-center gap-2 hover:bg-[#F1F3F5] transition-colors outline-none select-none">
                      <ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" />
                      View Hedera proof
                    </summary>
                    <div className="p-4 border-t border-[#DDE1E6] bg-white flex flex-col gap-3 font-technical text-[10px] text-[#60646C]">
                      <div className="flex justify-between">
                        <span>Escrow contract:</span>
                        <span className="font-semibold text-[#15171A]">{evidence.releaseEvidence.escrowContract}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>HCS topic:</span>
                        <span className="font-semibold text-[#15171A]">{evidence.releaseEvidence.hcsTopic}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Release TX:</span>
                        <span className="font-semibold text-[#15171A] truncate max-w-[150px]">{evidence.releaseEvidence.releaseTransaction}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>HCS sequences 1–5:</span>
                        <span className="font-semibold text-[#168A4A]">CONFIRMED</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Mirror verification:</span>
                        <span className="font-semibold text-[#168A4A]">VALID</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Final state:</span>
                        <span className="font-semibold text-[#15171A]">{evidence.releaseEvidence.finalContractState}</span>
                      </div>
                    </div>
                  </details>
                </div>

                {/* Footer CTA */}
                <div className="p-4 border-t border-[#DDE1E6] bg-[#F1F3F5]">
                  <button
                    onClick={() => onNavigate('/control')}
                    className="w-full h-12 bg-[#0031FF] text-white rounded-[8px] font-montserrat font-bold text-xs uppercase tracking-widest hover:bg-[#0026CC] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] flex items-center justify-center gap-2 shadow-sm"
                  >
                    <span>OPEN SHIPPER DEMO</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>

              </div>
            </div>
          </div>
        </section>

        {/* Workflow Section */}
        <HomepageWorkflow onExploreClick={() => onNavigate('/control')} />

        {/* Freight Funds Section */}
        <section className="w-full bg-[#F7F8FA] py-16 md:py-24 border-t border-[#DDE1E6]">
          <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-12 md:gap-16">

            <div className="flex flex-col md:flex-row gap-8 items-start">
              <div className="flex flex-col gap-4 max-w-2xl flex-1">
                <h2 className="font-montserrat font-bold text-2xl md:text-4xl text-[#15171A]">
                  How the freight funds moved
                </h2>
                <p className="font-montserrat text-base md:text-lg text-[#60646C]">
                  RouteGuard separates machine-access payments from the freight payment. The shipper first secures the maximum budget. After the lowest valid qualified offer wins, only the winning amount remains locked, the unused balance returns to the shipper, and the carrier is paid after the shipper accepts proof of delivery.
                </p>
              </div>

              <div className="flex-1 w-full max-w-md bg-white border border-[#DDE1E6] rounded-[8px] p-5 shadow-sm">
                <h3 className="font-technical font-bold text-xs text-[#8A8F98] uppercase tracking-wider mb-2">
                  WHY THE AMOUNTS ARE SMALL
                </h3>
                <p className="font-montserrat text-sm text-[#60646C] leading-relaxed">
                  The completed demonstration uses controlled testnet amounts to prove the full custody, allocation, refund and release process. They demonstrate the payment mechanics and do not represent a commercial freight price.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">

              {/* TWO MONEY LAYERS - MACHINE ACCESS */}
              <div className="lg:col-span-4 flex flex-col gap-6 bg-white border border-[#DDE1E6] p-6 md:p-8 rounded-[12px] shadow-sm">
                <div className="flex flex-col gap-1 border-b border-[#DDE1E6] pb-4">
                  <h3 className="font-montserrat font-bold text-lg text-[#15171A]">
                    Machine access rail
                  </h3>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="font-technical font-bold text-3xl text-[#8259EF]">
                    0.001 USDC
                  </span>
                  <span className="font-montserrat font-semibold text-sm text-[#60646C]">
                    per protected action
                  </span>
                </div>

                <div className="flex flex-col gap-2 font-technical text-sm text-[#15171A]">
                  <span className="text-[#8A8F98] uppercase tracking-wider font-bold text-[10px]">USED WHEN:</span>
                  <ul className="list-disc list-inside space-y-1">
                    <li>the shipper activates the tender;</li>
                    <li>a carrier submits a protected offer.</li>
                  </ul>
                </div>

                <p className="font-montserrat text-sm text-[#60646C] leading-relaxed mt-auto pt-4 border-t border-[#DDE1E6]">
                  These small x402 payments confirm machine intent and protect access to freight actions. They are separate from the freight budget and are not paid to the winning carrier as freight compensation.
                </p>
              </div>

              {/* TWO MONEY LAYERS - FREIGHT PAYMENT & 5 FLOWS */}
              <div className="lg:col-span-8 flex flex-col gap-0 bg-white border border-[#DDE1E6] rounded-[12px] shadow-sm overflow-hidden">
                <div className="p-6 md:p-8 bg-[#15171A] text-white flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                  <div className="flex flex-col gap-2">
                    <h3 className="font-montserrat font-bold text-xl">Freight payment</h3>
                    <p className="font-montserrat text-sm text-[#8A8F98] max-w-md">
                      This is the freight principal held by the RouteGuard escrow process. It is economically separate from x402 access payments and Hedera network fees.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 font-technical text-sm whitespace-nowrap bg-[#181C24] p-4 rounded-[8px] border border-[#2E3132]">
                    <div className="flex justify-between gap-6"><span className="text-[#8A8F98]">Maximum demo budget:</span> <span className="font-bold">1.00 USDC</span></div>
                    <div className="flex justify-between gap-6"><span className="text-[#8A8F98]">Winning carrier amount:</span> <span className="font-bold text-[#168A4A]">0.75 USDC</span></div>
                    <div className="flex justify-between gap-6"><span className="text-[#8A8F98]">Excess returned:</span> <span className="font-bold">0.25 USDC</span></div>
                  </div>
                </div>

                <div className="p-6 md:p-12 flex flex-col gap-0 relative">

                  {/* Vertical connecting line */}
                  <div className="absolute left-[39px] md:left-[63px] top-[60px] bottom-[60px] w-0.5 bg-[#DDE1E6] z-0"></div>

                  {/* FLOW 1 */}
                  <div className="flex gap-6 md:gap-8 relative z-10 pb-12">
                    <div className="w-8 h-8 rounded-full bg-[#15171A] text-white flex items-center justify-center font-technical font-bold text-sm shrink-0 mt-1 ring-4 ring-white">1</div>
                    <div className="flex flex-col gap-2 w-full">
                      <span className="font-technical font-bold text-[10px] text-[#0031FF] uppercase tracking-wider">SHIPPER</span>
                      <h4 className="font-montserrat font-bold text-lg text-[#15171A]">Maximum freight budget secured</h4>
                      <div className="font-technical font-bold text-3xl text-[#15171A] my-1">1.00 USDC</div>
                      <p className="font-montserrat text-sm text-[#60646C]">The shipper funds the maximum demo freight budget before the tender opens, so qualified carriers know the payment capacity is secured.</p>
                      <span className="font-technical font-semibold text-xs text-[#8A8F98] uppercase tracking-wider mt-2 bg-[#F7F8FA] px-3 py-1.5 rounded-full w-max border border-[#DDE1E6]">Hedera layer: HTS USDC · Smart-contract custody</span>
                    </div>
                  </div>

                  {/* FLOW 2 */}
                  <div className="flex gap-6 md:gap-8 relative z-10 pb-12">
                    <div className="w-8 h-8 rounded-full bg-[#15171A] text-white flex items-center justify-center font-technical font-bold text-sm shrink-0 mt-1 ring-4 ring-white">2</div>
                    <div className="flex flex-col gap-2 w-full">
                      <span className="font-technical font-bold text-[10px] text-[#0031FF] uppercase tracking-wider">CARRIERS + ROUTEGUARD RULES</span>
                      <h4 className="font-montserrat font-bold text-lg text-[#15171A]">Lowest valid qualified offer wins</h4>
                      <div className="flex items-center gap-3 my-1">
                        <span className="font-technical font-bold text-3xl text-[#15171A]">0.75 USDC</span>
                        <span className="font-technical font-bold text-sm text-[#168A4A] bg-[#168A4A]/10 px-3 py-1 rounded-full">carrier-alpha</span>
                      </div>
                      <p className="font-montserrat text-sm text-[#60646C]">RouteGuard applies the qualification and pricing rules fixed by the shipper before bidding. A lower offer does not win when the carrier fails a required rule.</p>
                      <span className="font-technical font-semibold text-xs text-[#8A8F98] uppercase tracking-wider mt-2 bg-[#F7F8FA] px-3 py-1.5 rounded-full w-max border border-[#DDE1E6]">Hedera layer: x402-gated access · Deterministic selection</span>
                    </div>
                  </div>

                  {/* FLOW 3 */}
                  <div className="flex gap-6 md:gap-8 relative z-10 pb-12">
                    <div className="w-8 h-8 rounded-full bg-[#15171A] text-white flex items-center justify-center font-technical font-bold text-sm shrink-0 mt-1 ring-4 ring-white">3</div>
                    <div className="flex flex-col gap-2 w-full">
                      <span className="font-technical font-bold text-[10px] text-[#0031FF] uppercase tracking-wider">ESCROW</span>
                      <h4 className="font-montserrat font-bold text-lg text-[#15171A]">Winning amount locked until accepted POD</h4>
                      <div className="font-technical font-bold text-3xl text-[#15171A] my-1">0.75 USDC</div>
                      <p className="font-montserrat text-sm text-[#60646C]">The winning freight amount remains secured for the selected carrier while delivery evidence is still pending.</p>
                      <span className="font-technical font-semibold text-xs text-[#8A8F98] uppercase tracking-wider mt-2 bg-[#F7F8FA] px-3 py-1.5 rounded-full w-max border border-[#DDE1E6]">Hedera layer: Smart-contract HTS allocation</span>
                    </div>
                  </div>

                  {/* FLOW 4 */}
                  <div className="flex gap-6 md:gap-8 relative z-10 pb-12">
                    <div className="w-8 h-8 rounded-full bg-[#15171A] text-white flex items-center justify-center font-technical font-bold text-sm shrink-0 mt-1 ring-4 ring-white">4</div>
                    <div className="flex flex-col gap-2 w-full">
                      <span className="font-technical font-bold text-[10px] text-[#0031FF] uppercase tracking-wider">SHIPPER</span>
                      <h4 className="font-montserrat font-bold text-lg text-[#15171A]">Unused budget returned after winner selection</h4>
                      <div className="font-technical font-bold text-3xl text-[#15171A] my-1">0.25 USDC</div>
                      <p className="font-montserrat text-sm text-[#60646C]">After the winner is selected and 0.75 USDC is allocated, the unused 0.25 USDC returns to the shipper. Returned after winner selection and allocation.</p>
                      <span className="font-technical font-semibold text-xs text-[#8A8F98] uppercase tracking-wider mt-2 bg-[#F7F8FA] px-3 py-1.5 rounded-full w-max border border-[#DDE1E6]">Hedera layer: HTS excess refund · Mirror verification</span>
                    </div>
                  </div>

                  {/* FLOW 5 */}
                  <div className="flex gap-6 md:gap-8 relative z-10">
                    <div className="w-8 h-8 rounded-full bg-[#168A4A] text-white flex items-center justify-center font-technical font-bold text-sm shrink-0 mt-1 ring-4 ring-white">5</div>
                    <div className="flex flex-col gap-2 w-full">
                      <span className="font-technical font-bold text-[10px] text-[#0031FF] uppercase tracking-wider">CARRIER &rarr; SHIPPER &rarr; ESCROW</span>
                      <h4 className="font-montserrat font-bold text-lg text-[#15171A]">Accepted delivery evidence releases payment</h4>

                      <div className="flex flex-col gap-3 my-3 bg-[#F7F8FA] border border-[#DDE1E6] rounded-[8px] p-4">
                        <div className="flex justify-between items-center text-sm font-montserrat">
                          <span className="text-[#60646C] font-semibold">Encrypted POD submitted</span>
                          <span className="text-[#15171A] font-bold">Shipper decision: ACCEPTED</span>
                        </div>
                        <div className="h-px bg-[#DDE1E6] w-full"></div>
                        <div className="flex flex-wrap justify-between items-end gap-4">
                          <div className="flex flex-col gap-1">
                            <span className="font-technical text-[10px] text-[#8A8F98] uppercase font-bold tracking-wider">FINAL AMOUNT TO</span>
                            <span className="font-technical font-bold text-sm text-[#168A4A] bg-[#168A4A]/10 px-2 py-0.5 rounded">carrier-alpha</span>
                          </div>
                          <div className="font-technical font-bold text-3xl text-[#168A4A]">0.75 USDC</div>
                        </div>
                      </div>

                      <p className="font-montserrat text-sm text-[#60646C]">The carrier submits signed and encrypted proof of delivery. After the shipper accepts it, escrow releases the winning freight amount to the carrier.</p>

                      <div className="flex flex-wrap gap-4 font-technical text-xs mt-2 text-[#15171A] font-semibold">
                        <span className="bg-white border border-[#DDE1E6] px-3 py-1.5 rounded-full text-[#168A4A]">Escrow: RELEASED</span>
                        <span className="bg-white border border-[#DDE1E6] px-3 py-1.5 rounded-full">Remaining locked: 0 USDC</span>
                        <span className="bg-white border border-[#DDE1E6] px-3 py-1.5 rounded-full text-[#15171A]">Tender: COMPLETED</span>
                      </div>

                      <span className="font-technical font-semibold text-xs text-[#8A8F98] uppercase tracking-wider mt-3 bg-[#F7F8FA] px-3 py-1.5 rounded-full w-max border border-[#DDE1E6]">Hedera layer: HCS delivery evidence · Signed acceptance · HTS settlement · Mirror verification</span>
                    </div>
                  </div>

                </div>
              </div>

            </div>

            {/* Network Fee Reference */}
            <div className="flex flex-col gap-3 pt-8 border-t border-[#DDE1E6] text-xs font-technical">
              <span className="font-montserrat font-semibold text-[#15171A] text-sm uppercase tracking-widest">
                Hedera network fee reference
              </span>
              <p className="font-montserrat text-sm text-[#60646C] max-w-2xl">
                These network fees are separate from the x402 access payment and the freight principal.
              </p>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8 text-[#15171A] font-bold mt-2">
                <span className="bg-white border border-[#DDE1E6] px-4 py-2 rounded-[8px] shadow-sm">HBAR transfer fee: <span className="text-[#168A4A]">$0.0001</span></span>
                <span className="bg-white border border-[#DDE1E6] px-4 py-2 rounded-[8px] shadow-sm">HTS / stablecoin transfer fee: <span className="text-[#168A4A]">$0.001</span></span>
              </div>
            </div>

          </div>
        </section>

        {/* Proof Preview Section */}
        <section className="w-full bg-[#11151D] border-t border-[#2E3132] text-white py-16 md:py-24">
          <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 flex flex-col gap-16 md:gap-24">

            <div className="flex flex-col gap-4 max-w-3xl">
              <h2 className="font-montserrat font-bold text-2xl md:text-4xl">
                Independently verifiable freight execution
              </h2>
              <p className="font-montserrat text-[#8A8F98] text-base md:text-lg">
                Inspect the public payments, escrow state, HCS chronology and final carrier release behind the completed demo shipment.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

              {/* Card 1 */}
              <div className="bg-[#181C24] border border-[#2E3132] p-6 md:p-8 rounded-[12px] flex flex-col gap-6">
                <div className="flex justify-between items-start">
                  <h3 className="font-montserrat font-bold text-lg text-white">Access proven</h3>
                  <span className="px-2 py-1 bg-[#168A4A]/10 border border-[#168A4A]/30 rounded text-[10px] font-technical text-[#168A4A] uppercase tracking-wider font-bold">
                    LIVE PROVEN
                  </span>
                </div>
                <div className="flex flex-col gap-1 border-b border-[#2E3132] pb-4">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Summary:</span>
                  <span className="font-technical text-[#DFE2EE]">Two x402 access payments</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Details:</span>
                  <ul className="font-technical text-sm text-[#DFE2EE] list-disc list-inside space-y-1">
                    <li>Tender activation</li>
                    <li>Carrier offer submission</li>
                  </ul>
                </div>
              </div>

              {/* Card 2 */}
              <div className="bg-[#181C24] border border-[#2E3132] p-6 md:p-8 rounded-[12px] flex flex-col gap-6">
                <div className="flex justify-between items-start">
                  <h3 className="font-montserrat font-bold text-lg text-white">Escrow proven</h3>
                  <span className="px-2 py-1 bg-[#168A4A]/10 border border-[#168A4A]/30 rounded text-[10px] font-technical text-[#168A4A] uppercase tracking-wider font-bold">
                    LIVE PROVEN
                  </span>
                </div>
                <div className="flex flex-col gap-1 border-b border-[#2E3132] pb-4">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Summary:</span>
                  <span className="font-technical text-[#DFE2EE]">{evidence.economics.maximumFreightPrincipal.display} funded</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Details:</span>
                  <ul className="font-technical text-sm text-[#DFE2EE] list-disc list-inside space-y-1">
                    <li>{evidence.economics.winningFreightSettlement.display} allocated</li>
                    <li>{evidence.economics.excessRefund.display} returned</li>
                  </ul>
                </div>
              </div>

              {/* Card 3 */}
              <div className="bg-[#181C24] border border-[#2E3132] p-6 md:p-8 rounded-[12px] flex flex-col gap-6">
                <div className="flex justify-between items-start">
                  <h3 className="font-montserrat font-bold text-lg text-white">Delivery settlement proven</h3>
                  <span className="px-2 py-1 bg-[#168A4A]/10 border border-[#168A4A]/30 rounded text-[10px] font-technical text-[#168A4A] uppercase tracking-wider font-bold">
                    LIVE PROVEN
                  </span>
                </div>
                <div className="flex flex-col gap-1 border-b border-[#2E3132] pb-4">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Summary:</span>
                  <span className="font-technical text-[#DFE2EE]">Encrypted POD and signed acceptance</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-montserrat font-semibold text-sm text-[#8A8F98]">Details:</span>
                  <ul className="font-technical text-sm text-[#DFE2EE] list-disc list-inside space-y-1">
                    <li>HCS sequences 1–5</li>
                    <li>{evidence.releaseEvidence.releasedAmount} released</li>
                  </ul>
                </div>
              </div>

            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mt-4">
              <button
                onClick={() => onNavigate('/proof')}
                className="h-14 px-8 bg-[#0031FF] text-white rounded-[10px] font-montserrat font-bold text-xs uppercase tracking-widest hover:bg-[#0026CC] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] shadow-lg flex items-center gap-2 cursor-pointer w-full sm:w-auto justify-center"
              >
                <span>OPEN FULL PROOF CENTER</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                onClick={() => onNavigate('/control')}
                className="h-14 px-8 bg-transparent border border-[#2E3132] text-white rounded-[10px] font-montserrat font-bold text-xs uppercase tracking-widest hover:bg-[#181C24] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0031FF] flex items-center gap-2 cursor-pointer w-full sm:w-auto justify-center"
              >
                <span>OPEN OPERATIONS DEMO</span>
              </button>
            </div>

          </div>
        </section>
      </main>

      <RouteGuardFooter onNavigate={onNavigate} />
    </div>
  );
};
