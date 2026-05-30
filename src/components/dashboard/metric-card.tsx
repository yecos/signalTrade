'use client';

import { Card, CardContent } from '@/components/ui/card';
import { type LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: { value: number; label: string };
  variant?: 'default' | 'success' | 'danger' | 'warning' | 'info';
  subtitle?: string;
}

const variantStyles: Record<string, string> = {
  default: 'text-foreground',
  success: 'text-emerald-500',
  danger: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-sky-500',
};

const iconBgStyles: Record<string, string> = {
  default: 'bg-muted text-muted-foreground',
  success: 'bg-emerald-500/10 text-emerald-500',
  danger: 'bg-red-500/10 text-red-500',
  warning: 'bg-amber-500/10 text-amber-500',
  info: 'bg-sky-500/10 text-sky-500',
};

export function MetricCard({ title, value, icon: Icon, trend, variant = 'default', subtitle }: MetricCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="hover:shadow-md transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {title}
            </span>
            <div className={`size-8 rounded-lg flex items-center justify-center ${iconBgStyles[variant]}`}>
              <Icon className="size-4" />
            </div>
          </div>
          <div className={`text-2xl font-bold tracking-tight ${variantStyles[variant]}`}>
            {value}
          </div>
          {(trend || subtitle) && (
            <div className="mt-1 flex items-center gap-2">
              {trend && (
                <span className={`text-xs font-medium ${trend.value >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {trend.value >= 0 ? '+' : ''}{trend.value.toFixed(2)}%
                </span>
              )}
              {subtitle && (
                <span className="text-xs text-muted-foreground">{subtitle}</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
