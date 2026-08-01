import React from 'react';
import { RouteGuardEvidence } from '../data/routeguardEvidence';
import { RouteGuardHeader } from '../components/RouteGuardHeader';
import { RouteGuardFooter } from '../components/RouteGuardFooter';
import { JudgeWalkthrough } from '../components/JudgeWalkthrough';

interface JudgePageProps {
  evidence: RouteGuardEvidence;
  onNavigate: (path: string) => void;
}

export const JudgePage: React.FC<JudgePageProps> = ({ evidence, onNavigate }) => {
  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-[#15171A]">
      <RouteGuardHeader currentPath="/judge" onNavigate={onNavigate} />

      <main className="flex-1 w-full py-6">
        <JudgeWalkthrough evidence={evidence} onNavigate={onNavigate} />
      </main>

      <RouteGuardFooter onNavigate={onNavigate} />
    </div>
  );
};
