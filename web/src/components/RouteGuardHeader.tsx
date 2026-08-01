import React, { useState } from 'react';
import { RouteGuardBrand } from './brand/RouteGuardBrand';
import { HederaAttribution } from './brand/HederaAttribution';
import { Menu, X, ShieldCheck, LayoutDashboard, Compass, FileLock2 } from 'lucide-react';
import { HEDERA_BRAND_ASSETS } from '../config/brandAssets';

interface RouteGuardHeaderProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  dark?: boolean;
}

export const RouteGuardHeader: React.FC<RouteGuardHeaderProps> = ({
  currentPath,
  onNavigate,
  dark = false,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { label: 'PRODUCT', path: '/', icon: Compass },
    { label: 'OPERATIONS DEMO', path: '/control', icon: LayoutDashboard },
    { label: 'LIVE PROOF', path: '/proof', icon: ShieldCheck },
    { label: 'POD REVIEW', path: '/pod-review', icon: FileLock2 },
  ];

  const handleNavClick = (path: string) => {
    onNavigate(path);
    setMobileMenuOpen(false);
  };

  return (
    <>
      <header
        className={`w-full sticky top-0 z-50 transition-colors border-b ${
          dark
            ? 'bg-[#11151D] text-white border-[#2E3132] shadow-sm'
            : 'bg-[#FFFFFF] text-[#15171A] border-[#DDE1E6] shadow-sm'
        }`}
      >
        <div className="w-full max-w-[1440px] mx-auto px-5 md:px-12 h-24 flex items-center justify-between">

          {/* Header Cluster (Left-Aligned) */}
          <div className="flex items-center">
            {/* Brand Logo */}
            <button
              onClick={() => handleNavClick('/')}
              className="text-left focus:outline-none focus:ring-2 focus:ring-[#0031FF] rounded p-2 -ml-2 flex items-center"
              aria-label="RouteGuard Freight Exchange Home"
            >
              <RouteGuardBrand variant={dark ? 'compact-dark' : 'compact-light'} />
            </button>

            {/* Desktop Navigation */}
            <nav className="hidden lg:flex items-center gap-2 ml-10">
              {navItems.map((item) => {
                const isActive = currentPath === item.path;
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    onClick={() => handleNavClick(item.path)}
                    className={`flex items-center gap-2.5 font-montserrat font-semibold text-xs tracking-wider transition-all px-4 py-3 rounded-lg ${
                      isActive
                        ? 'bg-[#0031FF]/5 text-[#0031FF] ring-1 ring-[#0031FF]/20'
                        : dark
                        ? 'text-[#8A8F98] hover:text-white hover:bg-[#2E3132]'
                        : 'text-[#60646C] hover:text-[#15171A] hover:bg-[#F7F8FA]'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? 'text-[#0031FF]' : ''}`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right Cluster (Attribution + Mobile Toggle) */}
          <div className="flex items-center gap-4">

            {/* Hedera Attribution (Desktop/Tablet) */}
            <div className="hidden sm:flex ml-2">
              <HederaAttribution variant="header" dark={dark} />
            </div>

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-3 -mr-3 rounded text-[#60646C] hover:text-[#15171A] dark:hover:text-white focus:outline-none focus:ring-2 focus:ring-[#0031FF]"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Menu Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden bg-[#FFFFFF] dark:bg-[#11151D] border-b border-[#DDE1E6] dark:border-[#2E3132] px-5 py-6 flex flex-col gap-2 shadow-xl">
            {navItems.map((item) => {
              const isActive = currentPath === item.path;
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  onClick={() => handleNavClick(item.path)}
                  className={`flex items-center gap-3 font-montserrat font-semibold text-sm tracking-wider px-4 py-4 rounded-lg ${
                    isActive
                      ? 'bg-[#0031FF]/5 dark:bg-[#0031FF]/10 text-[#0031FF] ring-1 ring-[#0031FF]/20'
                      : dark
                      ? 'text-[#8A8F98] hover:bg-[#2E3132] hover:text-white'
                      : 'text-[#60646C] hover:bg-[#F1F3F5] hover:text-[#15171A]'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {item.label}
                </button>
              );
            })}

            {/* Hedera Attribution (Mobile) */}
            <div className="mt-4 pt-4 border-t border-[#DDE1E6] dark:border-[#2E3132]">
              <HederaAttribution variant="header" dark={dark} />
            </div>
          </div>
        )}
      </header>
    </>
  );
};
