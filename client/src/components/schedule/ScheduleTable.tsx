
import { memo, useRef, useEffect, useMemo } from 'react';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Train } from '@/lib/scheduleData';
import { Direction, CrowdingLevel } from '@/types/schedule';
import { parseTimeToMinutes, formatPredictedTimeDisplay, calculateDuration, isPredictedTimeReasonable } from '@/lib/time-utils';
import { CROWDING_DOT_STYLES } from '@/lib/schedule-helpers';
import { hasTrainDeparted, getMinutesUntilTrain } from '@/lib/overnight-utils';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const ScheduleTable = memo(function ScheduleTable({ 
  trains, 
  formatTime, 
  nextTrainId,
  tripIdMap,
  delays,
  predictedTimes,
  crowdingData,
  estimatedTimes,
  currentMinutes,
  direction,
}: { 
  trains: Train[], 
  formatTime: (t: string) => string,
  nextTrainId?: string,
  tripIdMap: Map<string, string>,
  delays: Map<string, number>,
  predictedTimes: Map<string, { scheduled?: string; predicted?: string; stop_id: string }>,
  crowdingData: Map<string, CrowdingLevel>,
  estimatedTimes: Map<string, {
    scheduled_departure: string | null;
    predicted_departure: string | null;
    scheduled_arrival: string | null;
    predicted_arrival: string | null;
  }>,
  currentMinutes: number,
  direction: Direction,
}) {
  const nextTrainRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToNext = useRef(false);
  
  // Sync horizontal scroll between header and content
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const headerContainer = headerScrollRef.current;
    
    if (!scrollContainer || !headerContainer) return;
    
    let isScrolling = false;
    
    const handleContentScroll = () => {
      if (!isScrolling) {
        isScrolling = true;
        headerContainer.scrollLeft = scrollContainer.scrollLeft;
        requestAnimationFrame(() => {
          isScrolling = false;
        });
      }
    };
    
    const handleHeaderScroll = () => {
      if (!isScrolling) {
        isScrolling = true;
        scrollContainer.scrollLeft = headerContainer.scrollLeft;
        requestAnimationFrame(() => {
          isScrolling = false;
        });
      }
    };
    
    scrollContainer.addEventListener('scroll', handleContentScroll, { passive: true });
    headerContainer.addEventListener('scroll', handleHeaderScroll, { passive: true });
    
    return () => {
      scrollContainer.removeEventListener('scroll', handleContentScroll);
      headerContainer.removeEventListener('scroll', handleHeaderScroll);
    };
  }, []);
  
  // Auto-scroll to next train on initial load
  useEffect(() => {
    if (nextTrainRef.current && scrollContainerRef.current && trains.length > 0 && nextTrainId) {
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (nextTrainRef.current && scrollContainerRef.current) {
            const container = scrollContainerRef.current;
            const nextTrainElement = nextTrainRef.current;

            const containerRect = container.getBoundingClientRect();
            const nextTrainRect = nextTrainElement.getBoundingClientRect();

            const scrollPosition = nextTrainRect.top - containerRect.top + container.scrollTop;
            
            container.scrollTo({
              top: Math.max(0, scrollPosition - 8),
              behavior: hasScrolledToNext.current ? 'smooth' : 'auto'
            });
            
            hasScrolledToNext.current = true;
          }
        });
      });
      
      return () => cancelAnimationFrame(rafId);
    } else if (!hasScrolledToNext.current && trains.length > 0) {
      hasScrolledToNext.current = false;
    }
  }, [nextTrainId, trains.length]);

  const formatPredictedTime = (timeStr: string): string | null => {
    return formatPredictedTimeDisplay(timeStr);
  };

  // Use centralized overnight utilities for consistent time handling
  const hasDeparted = (departureTime: string, currentMinutesValue: number): boolean => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    const trainMinutes = depHours * 60 + depMinutes;
    return hasTrainDeparted(trainMinutes, currentMinutesValue);
  };

  const getMinutesUntilDeparture = (departureTime: string, currentMinutesValue: number): number | null => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    const trainMinutes = depHours * 60 + depMinutes;
    return getMinutesUntilTrain(trainMinutes, currentMinutesValue);
  };

  // Memoize hasDeparted calculations for all trains to avoid recalculating on every render
  const departedMap = useMemo(() => {
    const map = new Map<string, boolean>();
    trains.forEach(train => {
      map.set(train.id, hasDeparted(train.departureTime, currentMinutes));
    });
    return map;
  }, [trains, currentMinutes]);

  // Memoize getMinutesUntilDeparture calculations for all trains
  // This accounts for estimated departure times (scraped or predicted)
  const minutesUntilMap = useMemo(() => {
    const map = new Map<string, number | null>();
    trains.forEach(train => {
      const tripId = tripIdMap.get(train.id);
      const predictedDepartureData = tripId ? predictedTimes.get(`${tripId}_departure`) : null;
      const scrapedEstimate = estimatedTimes.get(train.id);
      
      // Determine the countdown time (same logic as getCountdownTime in render)
      let countdownTime = train.departureTime;
      
      // Priority 1: Use scraped estimated departure if available
      if (scrapedEstimate?.predicted_departure) {
        const match = scrapedEstimate.predicted_departure.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1], 10);
          const m = parseInt(match[2], 10);
          if (match[3].toUpperCase() === 'PM' && h !== 12) h += 12;
          if (match[3].toUpperCase() === 'AM' && h === 12) h = 0;
          countdownTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        }
      } 
      // Priority 2: Use real-time API prediction if available and reasonable
      else if (predictedDepartureData?.predicted && 
               isPredictedTimeReasonable(
                 predictedDepartureData.predicted,
                 predictedDepartureData.scheduled,
                 train.departureTime
               )) {
        const predDate = new Date(predictedDepartureData.predicted);
        countdownTime = `${predDate.getHours().toString().padStart(2, '0')}:${predDate.getMinutes().toString().padStart(2, '0')}`;
      }
      // Default: use scheduled departure time
      
      map.set(train.id, getMinutesUntilDeparture(countdownTime, currentMinutes));
    });
    return map;
  }, [trains, currentMinutes, tripIdMap, predictedTimes, estimatedTimes]);

  return (
    <div className="rounded-xl border border-zinc-200 shadow-sm overflow-hidden bg-white">
      {/* Table Header - Independent flex row */}
      <div 
        ref={headerScrollRef}
        className="overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] bg-zinc-50 border-b border-zinc-200"
      >
        <div className="flex items-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500 py-2.5 px-4 min-w-fit">
          <div className="w-20 shrink-0">Depart</div>
          <div className="w-20 shrink-0">Arrive</div>
          <div className="w-14 shrink-0">Dur.</div>
          <div className="w-16 shrink-0">Status</div>
          <div className="flex-1 text-right pr-1">Train</div>
        </div>
      </div>
      {/* Table Body */}
      <div 
        ref={scrollContainerRef}
        className="divide-y divide-zinc-100 h-[280px] overflow-y-auto overflow-x-auto [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgb(212_212_212)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {trains.filter(t => t.id !== 'SENTINEL_END').map((train, index) => {
          const isNext = train.id === nextTrainId;

          const tripId = tripIdMap.get(train.id);
          const realtimeDelay = tripId ? delays.get(tripId) : null;
          const predictedDepartureData = tripId ? predictedTimes.get(`${tripId}_departure`) : null;
          const predictedArrivalData = tripId ? predictedTimes.get(`${tripId}_arrival`) : null;
          const departed = departedMap.get(train.id) ?? false;
          
          // Get scraped estimated times (from Metra website)
          const scrapedEstimate = estimatedTimes.get(train.id);
          
          // Calculate effective departure/arrival times for duration (prioritize estimates)
          let effectiveDeparture = train.departureTime;
          let effectiveArrival = train.arrivalTime;
          
          if (scrapedEstimate?.predicted_departure) {
             effectiveDeparture = scrapedEstimate.predicted_departure;
          } else if (predictedDepartureData?.predicted) {
             effectiveDeparture = formatPredictedTime(predictedDepartureData.predicted) || effectiveDeparture;
          }
          
          if (scrapedEstimate?.predicted_arrival) {
             effectiveArrival = scrapedEstimate.predicted_arrival;
          } else if (predictedArrivalData?.predicted) {
             effectiveArrival = formatPredictedTime(predictedArrivalData.predicted) || effectiveArrival;
          }
          
          const duration = calculateDuration(effectiveDeparture, effectiveArrival);
          
          const usePredictedDeparture =
            predictedDepartureData?.predicted &&
            isPredictedTimeReasonable(
              predictedDepartureData.predicted,
              predictedDepartureData.scheduled,
              train.departureTime
            );

          const usePredictedArrival =
            predictedArrivalData?.predicted &&
            isPredictedTimeReasonable(
              predictedArrivalData.predicted,
              predictedArrivalData.scheduled,
              train.arrivalTime
            );

          const predictedDeparture = usePredictedDeparture && predictedDepartureData?.predicted
            ? formatPredictedTime(predictedDepartureData.predicted)
            : null;
          const scheduledDeparture = predictedDepartureData?.scheduled
            ? formatPredictedTime(predictedDepartureData.scheduled)
            : null;
          const predictedArrival = usePredictedArrival && predictedArrivalData?.predicted
            ? formatPredictedTime(predictedArrivalData.predicted)
            : null;
          const scheduledArrival = predictedArrivalData?.scheduled
            ? formatPredictedTime(predictedArrivalData.scheduled)
            : null;

          let delayMinutes: number | null = null;
          if (
            usePredictedDeparture &&
            predictedDepartureData?.predicted &&
            predictedDepartureData?.scheduled
          ) {
            const scheduled = new Date(predictedDepartureData.scheduled);
            const predicted = new Date(predictedDepartureData.predicted);
            const diffMs = predicted.getTime() - scheduled.getTime();
            const diffMinutes = Math.round(diffMs / (1000 * 60));
            if (diffMinutes > 0) {
              delayMinutes = diffMinutes;
            }
          }
          if (delayMinutes === null && realtimeDelay) {
            delayMinutes = Math.round(realtimeDelay / 60);
          }
          
          return (
            <div
              key={train.id}
              ref={isNext ? nextTrainRef : null}
              className={cn(
                "flex items-center py-2.5 px-4 transition-colors",
                // Priority: 1) Next train (current styling), 2) Departed (grayed), 3) Express (light blue)
                isNext 
                  ? "bg-primary/5 border-l-2 border-primary" 
                  : departed 
                    ? "opacity-50"
                    : train.isExpress 
                      ? "bg-blue-50/70"
                      : ""
              )}
            >
              {/* Depart Column - show estimated time if available */}
              <div className={cn(
                "w-20 shrink-0 font-semibold tabular-nums text-sm",
                isNext ? "text-primary" : "text-zinc-900",
                departed && !isNext && "text-zinc-400"
              )}>
                {(() => {
                  // Use scraped estimated departure if available
                  if (scrapedEstimate?.predicted_departure && scrapedEstimate?.scheduled_departure) {
                    const pred = scrapedEstimate.predicted_departure;
                    const schedMins = parseTimeToMinutes(scrapedEstimate.scheduled_departure);
                    const predMins = parseTimeToMinutes(pred);
                    const diffMins = predMins - schedMins;
                    
                    if (diffMins > 0) {
                      return <span className="text-rose-600 font-semibold">{pred}</span>;
                    } else if (diffMins < 0) {
                      return <span className="text-emerald-600 font-semibold">{pred}</span>;
                    }
                    // Same time - show in default color
                    return pred;
                  }
                  // Fallback to real-time API prediction
                  if (isNext && predictedDeparture && scheduledDeparture && scheduledDeparture !== predictedDeparture) {
                    return <span className="text-rose-600">{predictedDeparture}</span>;
                  }
                  return formatTime(train.departureTime);
                })()}
              </div>
              
              {/* Arrive Column - show estimated time if available */}
              <div className={cn(
                "w-20 shrink-0 tabular-nums text-sm",
                isNext ? "text-zinc-700" : "text-zinc-700",
                departed && !isNext && "text-zinc-400"
              )}>
                {(() => {
                  // Use scraped estimated arrival if available
                  if (scrapedEstimate?.predicted_arrival && scrapedEstimate?.scheduled_arrival) {
                    const pred = scrapedEstimate.predicted_arrival;
                    const schedMins = parseTimeToMinutes(scrapedEstimate.scheduled_arrival);
                    const predMins = parseTimeToMinutes(pred);
                    const diffMins = predMins - schedMins;
                    
                    if (diffMins > 0) {
                      return <span className="text-rose-600 font-semibold">{pred}</span>;
                    } else if (diffMins < 0) {
                      return <span className="text-emerald-600 font-semibold">{pred}</span>;
                    }
                    // Same time - show in default color
                    return pred;
                  }
                  // Fallback to real-time API prediction
                  if (isNext && predictedArrival && scheduledArrival && scheduledArrival !== predictedArrival) {
                    return <span className="text-rose-600">{predictedArrival}</span>;
                  }
                  return formatTime(train.arrivalTime);
                })()}
              </div>
              
              {/* Duration Column - calculate from estimated times if available */}
              <div className={cn(
                "w-14 shrink-0 text-xs text-zinc-600",
                departed && !isNext && "text-zinc-400"
              )}>
                {(() => {
                  return <span>{duration}m</span>;
                })()}
              </div>
              
              {/* Status Column - minutes until estimated departure */}
              <div className={cn(
                "w-16 shrink-0 text-xs font-medium",
                isNext ? "text-primary" : "text-zinc-500",
                departed && !isNext && "text-zinc-400"
              )}>
                {departed && !isNext ? (
                  <span className="text-zinc-400">Gone</span>
                ) : (() => {
                  // Use scraped estimated departure or fall back to scheduled
                  // Use pre-calculated minutes until departure from memoized map
                  const minutesUntil = minutesUntilMap.get(train.id) ?? null;
                  
                  if (minutesUntil !== null && minutesUntil >= 0) {
                    const hours = Math.floor(minutesUntil / 60);
                    const mins = minutesUntil % 60;
                    const timeText = hours > 0 
                      ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}` 
                      : `${mins}m`;

                    return (
                      <span className={isNext ? "text-primary font-semibold" : "text-zinc-500"}>
                        {timeText}
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>
              
              {/* Train # Column with crowding dot */}
              <div className={cn(
                "flex-1 flex items-center justify-end gap-1.5 text-xs font-mono pr-1",
                isNext ? "text-zinc-700" : "text-zinc-600",
                departed && !isNext && "text-zinc-400"
              )}>
                {/* Crowding indicator dot */}
                {(() => {
                  const crowdingLevel = tripId
                    ? (crowdingData.get(tripId) || crowdingData.get(train.id))
                    : crowdingData.get(train.id);

                  return crowdingLevel ? (
                    <span className={cn(
                      "w-2 h-2 rounded-full shrink-0",
                      CROWDING_DOT_STYLES[crowdingLevel],
                    )} title={
                      crowdingLevel === 'some'
                        ? 'Some crowding'
                        : crowdingLevel === 'moderate'
                        ? 'Moderate crowding'
                        : crowdingLevel === 'high'
                        ? 'High crowding'
                        : 'Low crowding'
                    } />
                  ) : null;
                })()}
                {train.id}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
