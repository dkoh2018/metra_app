
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from "@/lib/utils";
import { ApiAlerts } from "@/types/schedule";

interface ScheduleAlertsProps {
  alerts: ApiAlerts[];
  onDismiss: (id: string) => void;
}

export function ScheduleAlerts({ alerts, onDismiss }: ScheduleAlertsProps) {
  if (alerts.length === 0) return null;

  return (
    <div className="mb-4 md:mb-6 space-y-2">
      {alerts.map((alert) => {
        const headerText = alert.alert?.headerText?.translation?.[0]?.text || 'Service Alert';
        const descriptionText = alert.alert?.descriptionText?.translation?.[0]?.text || '';
        
        const isCritical = /delay|late|cancel|disrupt|mechanical|problem/i.test(headerText + descriptionText);
        const isWarning = /schedule|change|update|notice/i.test(headerText + descriptionText);
        
        const alertType = isCritical ? 'critical' : isWarning ? 'warning' : 'info';
        
        const alertStyles = {
          critical: {
            bg: 'bg-red-50 dark:bg-red-950/20',
            border: 'border-red-500',
            icon: 'text-red-600 dark:text-red-400',
            title: 'text-red-900 dark:text-red-100',
            text: 'text-red-800 dark:text-red-200',
            iconComponent: AlertCircle
          },
          warning: {
            bg: 'bg-amber-50 dark:bg-amber-950/20',
            border: 'border-amber-500',
            icon: 'text-amber-600 dark:text-amber-400',
            title: 'text-amber-900 dark:text-amber-100',
            text: 'text-amber-800 dark:text-amber-200',
            iconComponent: AlertTriangle
          },
          info: {
            bg: 'bg-blue-50 dark:bg-blue-950/20',
            border: 'border-blue-500',
            icon: 'text-blue-600 dark:text-blue-400',
            title: 'text-blue-900 dark:text-blue-100',
            text: 'text-blue-800 dark:text-blue-200',
            iconComponent: Info
          }
        };
        
        const style = alertStyles[alertType];
        const IconComponent = style.iconComponent;
        
        return (
          <div
            key={alert.id}
            className={cn(
              "flex items-start gap-2.5 px-3 py-2.5 rounded-lg border",
              style.bg,
              style.border.replace('border-', 'border-l-2 border-')
            )}
          >
            <IconComponent className={cn("w-4 h-4 flex-shrink-0 mt-0.5", style.icon)} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h3 className={cn("font-medium text-sm leading-snug", style.title)}>
                  {headerText}
                </h3>
                <button
                  onClick={() => onDismiss(alert.id)}
                  className="flex-shrink-0 p-0.5 rounded hover:bg-black/5"
                  aria-label="Dismiss alert"
                >
                  <X className="w-3.5 h-3.5 text-zinc-400" />
                </button>
              </div>
              {descriptionText && (
                <p className={cn("text-xs leading-relaxed mt-1 opacity-80", style.text)}>
                  {descriptionText}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
