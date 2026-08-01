import React from 'react';
import { RouteGuardBrand } from './brand/RouteGuardBrand';
import {
  LayoutDashboard,
  FileText,
  Truck,
  Gavel,
  CreditCard,
  CheckSquare,
  ShieldCheck,
  PlusCircle,
  Settings,
  HelpCircle,
} from 'lucide-react';

interface OperationsSidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  collapsed?: boolean;
}

export const OperationsSidebar: React.FC<OperationsSidebarProps> = ({
  activeTab,
  onTabChange,
  collapsed = false,
}) => {
  const menuItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'tender', label: 'Tender', icon: FileText },
    { id: 'offers', label: 'Carrier offers', icon: Truck },
    { id: 'decision', label: 'Decision', icon: Gavel },
    { id: 'payment', label: 'Payment', icon: CreditCard },
    { id: 'reservation', label: 'Reservation', icon: CheckSquare },
    { id: 'evidence', label: 'Evidence', icon: ShieldCheck, isHighlight: true },
  ];

  return (
    <aside
      className={`bg-[#F2F4F6] dark:bg-[#181C24] border-r border-[#DDE1E6] dark:border-[#2E3132] flex flex-col justify-between h-full transition-all ${
        collapsed ? 'w-20' : 'w-64'
      }`}
    >
      <div>
        {/* Header Branding */}
        <div className="p-6 border-b border-[#DDE1E6] dark:border-[#2E3132] flex flex-col gap-1">
          {collapsed ? (
            <RouteGuardBrand variant="symbol" />
          ) : (
            <>
              <RouteGuardBrand variant="compact-dark" />
              <span className="font-technical text-[11px] text-[#8A8F98] uppercase tracking-wider mt-1 block">
                Institutional Proof
              </span>
            </>
          )}
        </div>

        {/* Navigation List */}
        <nav className="py-4 flex flex-col gap-1">
          {menuItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center gap-3 px-6 py-3.5 text-xs font-montserrat font-semibold transition-all text-left w-full ${
                  isActive
                    ? 'bg-white dark:bg-[#11151D] text-[#15171A] dark:text-white border-l-4 border-l-[#0031FF] shadow-sm'
                    : 'text-[#60646C] dark:text-[#8A8F98] hover:bg-[#E7E8EA] dark:hover:bg-[#2E3132]'
                }`}
                title={item.label}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-[#0031FF]' : 'text-[#8A8F98]'
                  }`}
                />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Action & Footer Links */}
      <div className="p-4 border-t border-[#DDE1E6] dark:border-[#2E3132] flex flex-col gap-3">
        {!collapsed && (
          <button
            onClick={() => onTabChange('evidence')}
            className="w-full bg-[#000000] dark:bg-[#0031FF] text-white py-2.5 rounded-[10px] font-montserrat font-semibold text-xs tracking-wider uppercase hover:opacity-90 transition-opacity flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-[#0031FF]"
          >
            <PlusCircle className="w-4 h-4" />
            <span>New Route</span>
          </button>
        )}

        <div className="flex flex-col gap-1 pt-2">
          <button className="flex items-center gap-3 px-3 py-2 text-xs font-montserrat text-[#8A8F98] hover:text-[#15171A] dark:hover:text-white transition-colors">
            <Settings className="w-4 h-4" />
            {!collapsed && <span>Settings</span>}
          </button>
          <button className="flex items-center gap-3 px-3 py-2 text-xs font-montserrat text-[#8A8F98] hover:text-[#15171A] dark:hover:text-white transition-colors">
            <HelpCircle className="w-4 h-4" />
            {!collapsed && <span>Support</span>}
          </button>
        </div>
      </div>
    </aside>
  );
};
