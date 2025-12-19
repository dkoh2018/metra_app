import { ArrowRight, Clock, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Train } from '@/lib/scheduleData';
import { Station } from '@/lib/stations';
import { Direction, CrowdingLevel } from '@/types/schedule';
import { calculateDuration, parseTimeToMinutes, formatPredictedTimeDisplay, isPredictedTimeReasonable } from '@/lib/time-utils';
import { getCurrentMinutesInChicago } from '@/lib/time';
import { WeatherWidget } from '@/components/WeatherWidget';
import { CROWDING_LABELS } from '@/lib/schedule-helpers';
import { getMetraScheduleUrl } from '@shared/metra-urls';
import { useCallback } from 'react';

// Legacy styles
const CROWDING_BADGE_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-100 text-emerald-600 font-semibold",
  some: "bg-amber-200 text-amber-800",
  moderate: "bg-orange-100 text-orange-700",
  high: "bg-red-100 text-rose-600 font-semibold"
};

interface NextTrainCardProps {
  direction: Direction;
  selectedStation: Station;
  nextTrain: Train;
  tripIdMap: Map<string, string>;
  delays: Map<string, number>;
  predictedTimes: Map<string, { scheduled?: string; predicted?: string; stop_id: string }>;
  estimatedTimes: Map<string, {
    scheduled_departure: string | null;
    predicted_departure: string | null;
    scheduled_arrival: string | null;
    predicted_arrival: string | null;
  }>;
  crowdingData: Map<string, CrowdingLevel>;
  selectedGtfsId: string;
}

export function NextTrainCard({
  direction,
  selectedStation,
  nextTrain,
  tripIdMap,
  delays,
  predictedTimes,
  estimatedTimes,
  crowdingData,
  selectedGtfsId
}: NextTrainCardProps) {
  const tripId = tripIdMap.get(nextTrain.id);
  const realtimeDelay = tripId ? delays.get(tripId) : null;
  const predictedDepartureData = tripId ? predictedTimes.get(`${tripId}_departure`) : null;
  const predictedArrivalData = tripId ? predictedTimes.get(`${tripId}_arrival`) : null;
  
  // Get scraped estimated times (from Metra website)
  const scrapedEstimate = estimatedTimes.get(nextTrain.id);
  
  const usePredictedDeparture =
    predictedDepartureData?.predicted &&
    isPredictedTimeReasonable(
      predictedDepartureData.predicted,
      predictedDepartureData.scheduled,
      nextTrain.departureTime
    );

  const usePredictedArrival =
    predictedArrivalData?.predicted &&
    isPredictedTimeReasonable(
      predictedArrivalData.predicted,
      predictedArrivalData.scheduled,
      nextTrain.arrivalTime
    );

  let delayMinutes: number | null = null;
  if (
    usePredictedDeparture &&
    predictedDepartureData?.scheduled &&
    predictedDepartureData?.predicted
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
  
  const duration = calculateDuration(nextTrain.departureTime, nextTrain.arrivalTime);
  
  const getMinutesUntilDeparture = (departureTime: string): number | null => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    const depTotalMinutes = depHours * 60 + depMinutes;
    const currentMinutes = getCurrentMinutesInChicago();
    
    let adjustedDepMinutes = depTotalMinutes;
    if (depTotalMinutes < currentMinutes) {
      adjustedDepMinutes += 24 * 60;
    }
    
    const minutesUntil = adjustedDepMinutes - currentMinutes;
    return minutesUntil >= 0 && minutesUntil < 24 * 60 ? minutesUntil : null;
  };

  // Format time for display - handles GTFS overnight times
  const formatTime = useCallback((timeStr: string) => {
    let [hours, minutes] = timeStr.split(':').map(Number);
    
    hours = hours % 24;
    
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  }, []);
  
  const departureTimeForCountdown = (() => {
    // Priority 1: Use scraped estimated departure time
    if (scrapedEstimate?.predicted_departure) {
      const match = scrapedEstimate.predicted_departure.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match) {
        let hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        const period = match[3].toUpperCase();
        
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      }
    }
    
    // Priority 2: Use real-time API prediction
    if (usePredictedDeparture && predictedDepartureData?.predicted) {
      const predDate = new Date(predictedDepartureData.predicted);
      const hours = predDate.getHours();
      const minutes = predDate.getMinutes();
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
    
    // Default: use scheduled time
    return nextTrain.departureTime;
  })();
  const minutesUntil = getMinutesUntilDeparture(departureTimeForCountdown);
  
  const formatPredictedTimeForCard = (timeStr: string) => {
    return formatPredictedTimeDisplay(timeStr) || formatTime(timeStr);
  };
  
  const predictedDeparture = usePredictedDeparture && predictedDepartureData?.predicted
    ? formatPredictedTimeForCard(predictedDepartureData.predicted)
    : null;
  const scheduledDeparture = predictedDepartureData?.scheduled
    ? formatPredictedTimeForCard(predictedDepartureData.scheduled)
    : null;
  const predictedArrival = usePredictedArrival && predictedArrivalData?.predicted
    ? formatPredictedTimeForCard(predictedArrivalData.predicted)
    : null;
  const scheduledArrival = predictedArrivalData?.scheduled
    ? formatPredictedTimeForCard(predictedArrivalData.scheduled)
    : null;
  
  const crowdingLevel = tripId 
    ? (crowdingData.get(tripId) || crowdingData.get(nextTrain.id))
    : crowdingData.get(nextTrain.id);

  return (
    <div className={cn(
      "rounded-xl border shadow-sm mb-6 overflow-hidden bg-white border-zinc-200",
      direction === 'outbound' ? "border-l-4 border-l-amber-500" : "border-l-4 border-l-blue-500"
    )}>
      {/* Compact Header Row */}
      <div className={cn(
        "flex items-center justify-between px-4 py-2 border-b border-zinc-200",
        direction === 'outbound' ? "bg-amber-50/50" : "bg-blue-50/50"
      )}>
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-600">
          <span className={direction === 'outbound' ? "text-amber-700 font-bold" : "text-blue-700 font-bold"}>
            {direction === 'inbound' ? 'Inbound' : 'Outbound'}
          </span>
          <ArrowRight className="w-3 h-3" />
          <span className="text-base sm:text-lg font-bold text-zinc-500 uppercase tracking-[0.15em]">{direction === 'inbound' ? 'Chicago' : selectedStation.name}</span>
        </div>
        <div className="flex items-center gap-1.5">

          {crowdingLevel && (
            <span className={cn(
              "px-2 py-0.5 rounded text-xs font-semibold uppercase",
              CROWDING_BADGE_STYLES[crowdingLevel],
            )}>
              {crowdingLevel === 'moderate' ? 'Mod' : CROWDING_LABELS[crowdingLevel]}
            </span>
          )}
          {nextTrain.isExpress && (
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
              Express
            </span>
          )}
          <span className="text-xs font-mono text-zinc-500">
            #{nextTrain.id}
          </span>
        </div>
      </div>
      
      {/* Main Content - Compact Layout */}
      <div className="px-3 py-2.5 sm:px-4 sm:py-3">
        {/* Time Row - Primary Info - Always single row */}
        <div className="flex flex-row items-center justify-between gap-2 mb-2">
          {/* Left: Departure Time */}
          <div className="flex items-baseline gap-2">
            <div className={cn(
              "text-2xl sm:text-3xl md:text-4xl font-bold tabular-nums tracking-tight text-zinc-900",
              delayMinutes && delayMinutes > 0 ? "text-red-600" : "",
              scrapedEstimate?.predicted_departure && scrapedEstimate.predicted_departure > (scrapedEstimate.scheduled_departure || "") ? "text-rose-600 font-semibold" : "",
              scrapedEstimate?.predicted_departure && scrapedEstimate.predicted_departure < (scrapedEstimate.scheduled_departure || "") ? "text-emerald-600 font-semibold" : ""
            )}>
              {(() => {
                // Priority 1: Use scraped estimated departure if available
                if (scrapedEstimate?.predicted_departure) {
                  const sched = scrapedEstimate.scheduled_departure || formatTime(nextTrain.departureTime);
                  const pred = scrapedEstimate.predicted_departure;
                  
                  // Parse times to calculate difference
                  const schedMins = parseTimeToMinutes(sched);
                  const predMins = parseTimeToMinutes(pred);
                  const diffMins = predMins - schedMins;
                  
                  if (diffMins !== 0) {
                    const isDelayed = diffMins > 0;
                    return (
                      <>
                        <span className="line-through text-zinc-400 text-base sm:text-xl mr-1 sm:mr-2">{sched}</span>
                        <span className={isDelayed ? "text-rose-600 font-semibold" : "text-emerald-600 font-semibold"}>
                          {pred}{' '}
                          <span className="text-sm sm:text-lg">({isDelayed ? '+' : ''}{diffMins}min)</span>
                        </span>
                      </>
                    );
                  }
                }
                // Priority 2: Use real-time API prediction
                if (predictedDeparture && scheduledDeparture && scheduledDeparture !== predictedDeparture) {
                  return (
                    <>
                      <span className="line-through text-zinc-400 text-base sm:text-xl mr-1 sm:mr-2">{scheduledDeparture}</span>
                      <span className="text-red-600">{predictedDeparture}</span>
                    </>
                  );
                }
                // Default: show formatted departure time
                return predictedDeparture || formatTime(nextTrain.departureTime);
              })()}
            </div>
            <div className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 sm:px-2.5 sm:py-1 text-[8px] sm:text-[10px] font-bold uppercase tracking-wider rounded-full border shadow-sm",
              direction === 'outbound' 
                ? "bg-amber-50 text-amber-700 border-amber-200" 
                : "bg-blue-50 text-blue-700 border-blue-200"
            )}>
              <span className="relative flex h-1.5 w-1.5 sm:h-2 sm:w-2">
                <span className={cn(
                  "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                  direction === 'outbound' ? "bg-amber-500" : "bg-blue-500"
                )}></span>
                <span className={cn(
                  "relative inline-flex rounded-full h-1.5 w-1.5 sm:h-2 sm:w-2",
                  direction === 'outbound' ? "bg-amber-500" : "bg-blue-500"
                )}></span>
              </span>
              <span className="hidden sm:inline">Next Train</span>
              <span className="sm:hidden">Next</span>
            </div>
          </div>
          
          {/* Right: Countdown */}
          {minutesUntil !== null && (
            <div className="text-right flex-shrink-0">
              <div className={cn(
                "text-xl sm:text-2xl md:text-3xl font-bold tabular-nums",
                direction === 'outbound' ? "text-amber-600" : "text-primary"
              )}>
                {(() => {
                   if (minutesUntil < 60) {
                     return <>{minutesUntil}<span className="text-sm sm:text-lg ml-0.5">m</span></>;
                   }
                   const h = Math.floor(minutesUntil / 60);
                   const m = minutesUntil % 60;
                   return (
                     <>
                       {h}<span className="text-sm sm:text-lg ml-0.5 mr-1">h</span>
                       {m}<span className="text-sm sm:text-lg ml-0.5">m</span>
                     </>
                   );
                })()}
              </div>
              <div className="text-[8px] sm:text-[10px] uppercase tracking-wide text-zinc-500">
                until departure
              </div>
            </div>
          )}
        </div>
        
        {/* Secondary Info Row */}
        <div className="flex items-center gap-2 sm:gap-4 mt-2 pt-2 border-t border-zinc-100 text-xs sm:text-sm text-zinc-900 whitespace-nowrap overflow-hidden">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span>Arrives</span>
            {(() => {
              // Check scraped estimated arrival first
              if (scrapedEstimate?.predicted_arrival && scrapedEstimate?.scheduled_arrival) {
                const sched = scrapedEstimate.scheduled_arrival;
                const pred = scrapedEstimate.predicted_arrival;
                
                // Parse times to calculate difference
                const schedMins = parseTimeToMinutes(sched);
                const predMins = parseTimeToMinutes(pred);
                const diffMins = predMins - schedMins;
                
                if (diffMins !== 0) {
                  const isLate = diffMins > 0;
                  return (
                    <span className={cn("font-semibold", isLate ? "text-rose-600" : "text-emerald-600")}>
                      {pred}{' '}
                      <span className="text-xs">({isLate ? '+' : ''}{diffMins}min)</span>
                    </span>
                  );
                }
              }
              
              // Fallback to real-time API prediction
              if (predictedArrival && scheduledArrival && scheduledArrival !== predictedArrival) {
                return (
                  <span className="font-semibold text-rose-600">
                    {predictedArrival}
                  </span>
                );
              }
              
              return <span className="font-semibold">{predictedArrival || formatTime(nextTrain.arrivalTime)}</span>;
            })()}
          </div>
          <span className="text-zinc-400">•</span>
          {(() => {
            // Calculate duration from estimated times if available
            if (scrapedEstimate?.predicted_departure && scrapedEstimate?.predicted_arrival) {
              const depMins = parseTimeToMinutes(scrapedEstimate.predicted_departure);
              const arrMins = parseTimeToMinutes(scrapedEstimate.predicted_arrival);
              let estimatedDuration = arrMins - depMins;
              
              // Handle overnight trains (e.g. 11 PM to 12 AM)
              if (estimatedDuration < 0) {
                estimatedDuration += 24 * 60;
              }
              
              if (estimatedDuration > 0) {
                return <span>{estimatedDuration} min trip</span>;
              }
            }
            
            // Default: use scheduled duration
            return <span>{duration} min trip</span>;
          })()}
          <span className="text-zinc-400">•</span>
          <WeatherWidget 
            location={direction === 'inbound' ? 'Chicago' : selectedStation.name} 
          />
          <a 
            href={(() => {
              const now = new Date();
              const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
              const origin = direction === 'inbound' ? selectedGtfsId : (selectedStation.terminal || 'OTC');
              const dest = direction === 'inbound' ? (selectedStation.terminal || 'OTC') : selectedGtfsId;
              const line = selectedStation.line || 'UP-NW';
              
              return getMetraScheduleUrl({
                origin,
                destination: dest,
                line,
                date: thirtyMinAgo
              });
            })()}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline text-xs font-medium ml-auto"
          >
            <ExternalLink className="w-3 h-3" />
            <span>Tracker</span>
          </a>
        </div>
      </div>
    </div>
  );
}
