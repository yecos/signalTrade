'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, BarChart3, Brain, Activity, Settings,
  ChevronLeft, ChevronRight, Wifi, WifiOff, Menu, X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QueryProvider } from '@/components/dashboard/query-provider';
import { DashboardPage } from '@/components/dashboard/dashboard-page';
import { TradingPage } from '@/components/dashboard/trading-page';
import { StrategiesPage } from '@/components/dashboard/strategies-page';
import { SignalsPage } from '@/components/dashboard/signals-page';
import { SettingsPage } from '@/components/dashboard/settings-page';
import { useWorkerStatus } from '@/lib/hooks/use-api';

// ─── Navigation Items ──────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'trading', label: 'Trading', icon: BarChart3 },
  { id: 'strategies', label: 'Estrategias', icon: Brain },
  { id: 'signals', label: 'Señales', icon: Activity },
  { id: 'settings', label: 'Configuración', icon: Settings },
];

// ─── Page Content Router ───────────────────────────────────────────────────

function PageContent({ activePage }: { activePage: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={activePage}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2 }}
      >
        {activePage === 'dashboard' && <DashboardPage />}
        {activePage === 'trading' && <TradingPage />}
        {activePage === 'strategies' && <StrategiesPage />}
        {activePage === 'signals' && <SignalsPage />}
        {activePage === 'settings' && <SettingsPage />}
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Worker Status Header ──────────────────────────────────────────────────

function WorkerStatusHeader() {
  const { data: worker } = useWorkerStatus();
  return (
    <div className="flex items-center gap-2">
      <span className={`size-2.5 rounded-full ${worker?.workerConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-400'}`} />
      <span className="text-xs text-muted-foreground">
        {worker?.workerConnected ? 'Conectado' : 'Desconectado'}
      </span>
      {worker?.autoExecution?.enabled && (
        <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 border text-[9px] px-1 py-0 gap-0.5">
          <Zap className="size-2.5" />
          AUTO
        </Badge>
      )}
    </div>
  );
}

// ─── Main App Shell ────────────────────────────────────────────────────────

function AppShell() {
  const [activePage, setActivePage] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar — Desktop */}
      <aside className={`hidden md:flex flex-col border-r border-border/50 bg-card transition-all duration-200 ${sidebarCollapsed ? 'w-16' : 'w-56'}`}>
        {/* Logo */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-border/50">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2">
              <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
                <Zap className="size-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-sm tracking-tight">SignalTrader Pro</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 ml-auto"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
          </Button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-2 px-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActivePage(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <item.icon className="size-4 shrink-0" />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Bottom section */}
        {!sidebarCollapsed && (
          <div className="p-3 border-t border-border/50">
            <WorkerStatusHeader />
          </div>
        )}
      </aside>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="w-64 h-full bg-card border-r border-border p-4">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
                  <Zap className="size-4 text-primary-foreground" />
                </div>
                <span className="font-semibold text-sm">SignalTrader Pro</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setMobileMenuOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <nav className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActivePage(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="mt-6 pt-4 border-t border-border/50">
              <WorkerStatusHeader />
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0">
        {/* Top Bar */}
        <header className="h-14 border-b border-border/50 flex items-center justify-between px-4 bg-card/50 backdrop-blur-sm sticky top-0 z-40">
          <div className="flex items-center gap-3">
            {/* Mobile menu toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden size-8"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu className="size-4" />
            </Button>
            <h1 className="text-sm font-semibold">
              {NAV_ITEMS.find(n => n.id === activePage)?.label || 'Dashboard'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <WorkerStatusHeader />
          </div>
        </header>

        {/* Page Content */}
        <div className="p-4 sm:p-6 max-w-7xl mx-auto">
          <PageContent activePage={activePage} />
        </div>
      </main>
    </div>
  );
}

// ─── Root Page Component ───────────────────────────────────────────────────

export default function Page() {
  return (
    <QueryProvider>
      <AppShell />
    </QueryProvider>
  );
}
