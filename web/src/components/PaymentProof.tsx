import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { CopyableIdentifier } from './CopyableIdentifier';
import { ExternalExplorerLink } from './ExternalExplorerLink';
import { CreditCard, CheckCircle2, Shield } from 'lucide-react';

interface PaymentProofProps {
  evidence: RouteGuardEvidence;
  variant?: 'light' | 'dark';
}

export const PaymentProof: React.FC<PaymentProofProps> = ({ evidence, variant = 'light' }) => {
  const { payment, token, parties, hashes } = evidence;
  const isDark = variant === 'dark';

  return (
    <div
      className={`rounded-[12px] p-6 md:p-8 flex flex-col gap-6 border transition-shadow ${
        isDark
          ? 'bg-[#11151D] text-white border-[#2E3132] border-l-4 border-l-[#8259EF]'
          : 'bg-white text-[#15171A] border-[#DDE1E6] shadow-sm'
      }`}
    >
      {/* Header */}
      <div className="flex justify-between items-start border-b pb-4 border-[#DDE1E6] dark:border-[#2E3132]">
        <div className="flex items-center gap-3">
          <div
            className={`p-2.5 rounded-[8px] ${
              isDark ? 'bg-[#181C24] text-[#8259EF]' : 'bg-[#F1F3F5] text-[#0031FF]'
            }`}
          >
            <CreditCard className="w-5 h-5" />
          </div>
          <div>
            <span className="font-montserrat font-semibold text-[11px] text-[#8A8F98] uppercase tracking-wider block">
              x402 Protocol Layer
            </span>
            <h3
              className={`font-montserrat font-bold text-xl ${
                isDark ? 'text-white' : 'text-[#15171A]'
              }`}
            >
              Payment Proof
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-1.5 bg-[#168A4A]/10 border border-[#168A4A]/30 text-[#168A4A] px-3 py-1 rounded-full text-xs font-montserrat font-semibold">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>{payment.status || 'SETTLED'}</span>
        </div>
      </div>

      {/* Grid of Attributes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 font-technical text-xs">
        {/* Transaction ID */}
        <div className="col-span-1 md:col-span-2 flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[#8A8F98] uppercase tracking-wider text-[11px] font-semibold">
              Payment Transaction ID
            </span>
            <ExternalExplorerLink
              type="tx"
              id={hashes.paymentTxId}
              label="Inspect on HashScan"
              variant={isDark ? 'dark' : 'light'}
            />
          </div>
          <CopyableIdentifier value={hashes.paymentTxId} />
        </div>

        {/* Payer Account */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[#8A8F98] uppercase tracking-wider text-[11px] font-semibold">
              Payer Account ID
            </span>
            <ExternalExplorerLink
              type="account"
              id={parties.payerAccountId}
              variant={isDark ? 'dark' : 'light'}
            />
          </div>
          <CopyableIdentifier value={parties.payerAccountId} />
        </div>

        {/* Receiver Account */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <span className="text-[#8A8F98] uppercase tracking-wider text-[11px] font-semibold">
              Receiver Account ID
            </span>
            <ExternalExplorerLink
              type="account"
              id={parties.receiverAccountId}
              variant={isDark ? 'dark' : 'light'}
            />
          </div>
          <CopyableIdentifier value={parties.receiverAccountId} />
        </div>

        {/* Amount */}
        <div className="flex flex-col gap-1 bg-[#F1F3F5] dark:bg-[#181C24] p-3 rounded border border-[#DDE1E6] dark:border-[#2E3132]">
          <span className="text-[#8A8F98] uppercase tracking-wider text-[11px] font-semibold">
            Settlement Amount
          </span>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="font-montserrat font-bold text-lg text-[#15171A] dark:text-white">
              {payment.amountFormatted || '0.01 USDC'}
            </span>
            <span className="text-[#8A8F98] text-xs">
              ({payment.amountAtomic || '10000 atomic USDC'})
            </span>
          </div>
        </div>

        {/* Token Info */}
        <div className="flex flex-col gap-1 bg-[#F1F3F5] dark:bg-[#181C24] p-3 rounded border border-[#DDE1E6] dark:border-[#2E3132]">
          <div className="flex justify-between items-center">
            <span className="text-[#8A8F98] uppercase tracking-wider text-[11px] font-semibold">
              Asset Token
            </span>
            <ExternalExplorerLink
              type="token"
              id={token.tokenId}
              variant={isDark ? 'dark' : 'light'}
            />
          </div>
          <div className="font-technical text-xs text-[#15171A] dark:text-[#DFE2EE] font-medium mt-1">
            {token.symbol || 'USDC'} (Token ID: {token.tokenId}) · Network: {token.network}
          </div>
        </div>
      </div>

      {/* HTTP Flow Protocol Bar */}
      <div className="pt-4 border-t border-[#DDE1E6] dark:border-[#2E3132] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
        <span className="font-montserrat text-[#60646C] dark:text-[#8A8F98]">
          Canonical HTTP Proof Flow:
        </span>
        <div className="font-technical font-semibold px-3 py-1 bg-[#F1F3F5] dark:bg-[#181C24] border border-[#DDE1E6] dark:border-[#2E3132] rounded text-[#15171A] dark:text-[#DFE2EE]">
          {payment.httpFlow || '402 → signed retry → 200'}
        </div>
      </div>
    </div>
  );
};
