import { useMemo } from 'react';
import { Train } from '@shared/types';
import { Direction } from '@/types/schedule';
import { getTrainMinutesForComparison } from '@/lib/schedule-helpers';
import { getMinutesUntilTrain } from '@/lib/overnight-utils';

interface UseNextTrainProps {
  scheduleData: any;
  dayType: string;
  direction: Direction;
  estimatedTimes: Map<string, any>;
  currentMinutes: number;
}

export function useNextTrain({ 
  scheduleData, 
  dayType, 
  direction, 
  estimatedTimes, 
  currentMinutes 
}: UseNextTrainProps): Train | null {
  
  return useMemo(() => {
    const currentSchedule = scheduleData[dayType];
    if (!currentSchedule) return null;
    const trains = direction === 'inbound' ? currentSchedule.inbound : currentSchedule.outbound;
    
    // DEBUG: Log current state
    const currentTimeStr = `${Math.floor(currentMinutes/60)}:${String(currentMinutes%60).padStart(2, '0')}`;
    console.debug(`[computedNextTrain] Current time: ${currentTimeStr} (${currentMinutes} min), dayType: ${dayType}, direction: ${direction}, trains: ${trains.length}`);
    
    if (trains.length === 0) {
      return null;
    }
    
    // Find all upcoming trains with their minutes-until-departure
    const upcomingTrains = trains.map((train: Train) => {
      const estimate = estimatedTimes.get(train.id);
      let trainMinutes: number;
      
      // If there's an estimated departure, use it
      if (estimate?.predicted_departure) {
        const match = estimate.predicted_departure.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match) {
          let hours = parseInt(match[1], 10);
          const mins = parseInt(match[2], 10);
          const period = match[3].toUpperCase();
          
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          
          trainMinutes = hours * 60 + mins;
        } else {
          trainMinutes = getTrainMinutesForComparison(train.departureTime, currentMinutes);
        }
      } else {
        trainMinutes = getTrainMinutesForComparison(train.departureTime, currentMinutes);
      }
      
      // Use centralized overnight utility for consistent handling
      const minutesUntil = getMinutesUntilTrain(trainMinutes, currentMinutes);
      
      return { 
        train, 
        minutesUntil: minutesUntil !== null ? minutesUntil : Infinity 
      };
    });
    
    // Sort by minutes until departure and pick the closest upcoming train
    upcomingTrains.sort((a: any, b: any) => a.minutesUntil - b.minutesUntil);
    
    // Find first train with valid (non-Infinity) minutes until
    // Exclude SENTINEL_END which is a placeholder, not a real train
    const next = upcomingTrains.find((t: any) => 
      t.train.id !== 'SENTINEL_END' && 
      t.minutesUntil !== Infinity && 
      t.minutesUntil > 0
    );
    
    return next?.train || trains[0] || null;
  }, [dayType, direction, scheduleData, estimatedTimes, currentMinutes]);
}
