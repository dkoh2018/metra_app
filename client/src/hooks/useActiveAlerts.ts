import { useMemo } from 'react';
import { ApiAlerts } from '@/types/schedule';
import { getCurrentMinutesInChicago } from '@/lib/time';
import { TIME_PATTERN_REGEX } from '@/lib/schedule-helpers';

export function useActiveAlerts(alerts: ApiAlerts[], dismissedAlerts: Set<string>) {
  return useMemo(() => {
    const currentMinutes = getCurrentMinutesInChicago();
    const currentHours = Math.floor(currentMinutes / 60);
    
    return alerts
      .filter(alert => !dismissedAlerts.has(alert.id))
      .filter((alert) => {
        const activePeriods = alert.alert?.activePeriod || [];
        if (activePeriods.length > 0) {
          const now = new Date();
          const allPeriodsExpired = activePeriods.every(period => {
            if (period.end) {
              const endTime = new Date(parseInt(period.end) * 1000);
              return endTime.getTime() < now.getTime() - (10 * 60 * 1000);
            }
            return false;
          });
          if (allPeriodsExpired) {
            return false;
          }
        }
        
        const headerText = alert.alert?.headerText?.translation?.[0]?.text || '';
        const descriptionText = alert.alert?.descriptionText?.translation?.[0]?.text || '';
        const fullText = (headerText + ' ' + descriptionText).toLowerCase();
        
        const timePattern = new RegExp(TIME_PATTERN_REGEX.source, TIME_PATTERN_REGEX.flags);
        
        let hasPastTime = false;
        let match;
        const foundTimes: number[] = [];
        
        while ((match = timePattern.exec(fullText)) !== null) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const period = (match[3] || '').toUpperCase().replace(/\./g, '');
          
          if (period.includes('PM') && hours !== 12) {
            hours += 12;
          } else if (period.includes('AM') && hours === 12) {
            hours = 0;
          }
          
          const alertTimeMinutes = hours * 60 + minutes;
          foundTimes.push(alertTimeMinutes);
        }
        
        if (foundTimes.length > 0) {
          const allPast = foundTimes.every(alertTimeMinutes => {
            const alertHours = Math.floor(alertTimeMinutes / 60);
            
            if (currentHours >= 22 && alertHours < 6) {
              return false;
            }
            
            return alertTimeMinutes < currentMinutes - 10;
          });
          
          if (allPast) {
            hasPastTime = true;
          }
        }
        
        return !hasPastTime;
      });
  }, [alerts, dismissedAlerts]);
}
