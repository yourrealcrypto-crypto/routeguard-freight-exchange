import React from 'react';
import { SkipBack, RotateCcw, ChevronRight, FileCheck } from 'lucide-react';

interface Props {
  currentStep: number;
  hasStartedReplay: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRestart: () => void;
}

export const ReplayControls: React.FC<Props> = ({
  currentStep,
  hasStartedReplay,
  onPrevious,
  onNext,
  onRestart
}) => {
  const isComplete = currentStep >= 8;

  const scrollToReport = () => {
    document.getElementById('proof-report-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  const getNextLabel = () => {
    if (!hasStartedReplay) return "START DEMO REPLAY";
    switch (currentStep) {
      case 1: return "NEXT: SECURE FREIGHT BUDGET";
      case 2: return "NEXT: ACTIVATE TENDER";
      case 3: return "NEXT: SHOW CARRIER OFFER";
      case 4: return "NEXT: SELECT QUALIFIED WINNER";
      case 5: return "NEXT: SUBMIT ENCRYPTED POD";
      case 6: return "NEXT: REVIEW POD";
      case 7: return "NEXT: RELEASE CARRIER PAYMENT";
      default: return "VIEW COMPLETED PROOF REPORT";
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full max-w-2xl mx-auto mb-4">
      {/* Primary Navigation Button */}
      {isComplete && hasStartedReplay ? (
        <button
          onClick={scrollToReport}
          className="w-full flex items-center justify-center gap-2 h-14 bg-[#15171A] text-white rounded-[8px] font-montserrat font-bold text-sm uppercase tracking-wider hover:bg-[#2E3132] transition-colors shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0031FF]"
        >
          <FileCheck className="w-5 h-5" /> {getNextLabel()}
        </button>
      ) : (
        <button
          onClick={onNext}
          className="w-full flex items-center justify-center gap-2 h-14 bg-[#168A4A] text-white rounded-[8px] font-montserrat font-bold text-sm uppercase tracking-wider hover:bg-[#12723D] transition-colors shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#168A4A]"
        >
          {getNextLabel()} <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* Secondary Controls Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-4 bg-white border border-[#C1C7D0] rounded-[8px] px-4 py-2 shadow-md w-full justify-between">
        <button
          onClick={onPrevious}
          disabled={!hasStartedReplay}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[#60646C] hover:bg-[#F1F3F5] hover:text-[#15171A] rounded-[6px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none font-technical font-bold text-[10px] uppercase tracking-wider"
          aria-label="BACK"
        >
          <SkipBack className="w-4 h-4" /> BACK
        </button>

        <button
          onClick={onRestart}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[#60646C] hover:bg-[#F1F3F5] hover:text-[#15171A] rounded-[6px] transition-colors focus:outline-none font-technical font-bold text-[10px] uppercase tracking-wider"
          aria-label="RESTART REPLAY"
        >
          <RotateCcw className="w-3.5 h-3.5" /> RESTART REPLAY
        </button>
      </div>
    </div>
  );
};
