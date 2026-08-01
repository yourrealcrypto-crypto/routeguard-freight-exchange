import React, { useState, useEffect } from 'react';
import { getRouteGuardEvidence } from './data/routeguardEvidence';
import { HomePage } from './pages/HomePage';
import { ProofPage } from './pages/ProofPage';
import { ControlPage } from './pages/ControlPage';
import { JudgePage } from './pages/JudgePage';
import { PodReviewPage } from './pages/PodReviewPage';

export function App() {
  const [currentPath, setCurrentPath] = useState<string>(() => {
    return window.location.pathname || '/';
  });

  const evidence = getRouteGuardEvidence();

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname || '/');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleNavigate = (path: string) => {
    if (path !== window.location.pathname) {
      window.history.pushState({}, '', path);
    }
    setCurrentPath(path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderPage = () => {
    const cleanPath = currentPath.toLowerCase().replace(/\/$/, '') || '/';

    switch (cleanPath) {
      case '/':
        return <HomePage evidence={evidence} onNavigate={handleNavigate} />;
      case '/proof':
        return <ProofPage evidence={evidence} onNavigate={handleNavigate} />;
      case '/control':
        return <ControlPage evidence={evidence} onNavigate={handleNavigate} />;
      case '/judge':
        return <JudgePage evidence={evidence} onNavigate={handleNavigate} />;
      case '/pod-review':
        return <PodReviewPage evidence={evidence} onNavigate={handleNavigate} />;
      case '/operations-demo':
        return <ControlPage evidence={evidence} onNavigate={handleNavigate} />;
      default:
        return <HomePage evidence={evidence} onNavigate={handleNavigate} />;
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] antialiased">
      {renderPage()}
    </div>
  );
}

export default App;
