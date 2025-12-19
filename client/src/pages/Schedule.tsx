import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { Train } from '@/lib/scheduleData';
import { ArrowRight, Clock, RefreshCw, AlertTriangle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCurrentMinutesInChicago } from '@/lib/time';

// Refactored Imports
import { DayType, Direction, CrowdingLevel, ApiTrain, ApiSchedule, ApiAlerts } from '@/types/schedule';
import { parseTimeToMinutes, formatPredictedTimeDisplay, calculateDuration, getChicagoMinutesFromTimeString, isPredictedTimeReasonable } from '@/lib/time-utils';
import { transformTrain, getTrainMinutesForComparison, TRIP_ID_REGEX, TIME_PATTERN_REGEX, CROWDING_DOT_STYLES, CROWDING_LABELS } from '@/lib/schedule-helpers';
import { ScheduleTable } from '@/components/schedule/ScheduleTable';
import { ScheduleAlerts } from '@/components/schedule/ScheduleAlerts';
import { ScheduleHeader } from '@/components/schedule/ScheduleHeader';
import { useScheduleData } from '@/hooks/useScheduleData';



// Lazy load the map component since it's heavy
const TrainMap = lazy(() => import('@/components/TrainMap'));

import { STATIONS, Station } from '@/lib/stations';
import { WeatherWidget } from '@/components/WeatherWidget';

// Legacy styles kept until verified unused or moved
const CROWDING_BADGE_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-100 text-emerald-600 font-semibold",
  some: "bg-amber-200 text-amber-800",
  moderate: "bg-orange-100 text-orange-700",
  high: "bg-red-100 text-rose-600 font-semibold"
};



export default function Schedule() {
  const [direction, setDirection] = useState<Direction>('inbound');
  const [nextTrain, setNextTrain] = useState<Train | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [showDelayDebug, setShowDelayDebug] = useState(false);

  // Phase 2: Multi-Station State
  // Get default station: first highlighted station, or fallback to first station with gtfsId
  const getDefaultStation = (): Station => {
    const highlighted = Object.values(STATIONS).find(s => s.isHighlight && s.gtfsId);
    if (highlighted) return highlighted;
    const firstWithGtfsId = Object.values(STATIONS).find(s => s.gtfsId);
    return firstWithGtfsId || Object.values(STATIONS)[0];
  };
  
  const defaultStation = getDefaultStation();
  const [selectedGtfsId, setSelectedGtfsId] = useState<string>(defaultStation.gtfsId!);
  const selectedStation = Object.values(STATIONS).find(s => s.gtfsId === selectedGtfsId) || defaultStation;
  
  console.log('[Schedule] Render State:', { 
    selectedGtfsId, 
    line: selectedStation.line, 
    terminal: selectedStation.terminal 
  });

  const {
      currentTime,
      currentMinutes,
      dayType,
      scheduleData,
      scheduleLoading,
      scheduleError,
      tripIdMap,
      alerts,
      delays,
      predictedTimes,
      crowdingData,
      estimatedTimes,
      lastUpdate,
      refreshError,
      isRefreshing,
      refreshAll: handleRefresh,
      manualRefresh
  } = useScheduleData(selectedGtfsId, selectedStation, direction);

  // Find next train based on current view mode
  // Uses estimated departure time when available to prevent skipping delayed trains
  // Handles overnight trains correctly (24:XX format and 00:XX when viewing late at night)
  const computedNextTrain = useMemo(() => {
    const currentMinutes = getCurrentMinutesInChicago();
    const currentSchedule = scheduleData[dayType];
    if (!currentSchedule) return null;
    const trains = direction === 'inbound' ? currentSchedule.inbound : currentSchedule.outbound;
    
    // DEBUG: Log current state
    const currentTimeStr = `${Math.floor(currentMinutes/60)}:${String(currentMinutes%60).padStart(2, '0')}`;
    console.debug(`[computedNextTrain] Current time: ${currentTimeStr} (${currentMinutes} min), dayType: ${dayType}, direction: ${direction}, trains: ${trains.length}`);
    if (trains.length > 0) {
      console.debug(`[computedNextTrain] First 5 trains:`, trains.slice(0, 5).map(t => `${t.departureTime} (${t.id})`));
    }
    
    if (trains.length === 0) {
      return null;
    }
    

    
    const next = trains.find(train => {
      // Check if this train has an estimated departure time
      const estimate = estimatedTimes.get(train.id);
      let departureTimeStr = train.departureTime;
      
      // If there's an estimated departure, parse it to 24h format
      if (estimate?.predicted_departure) {
        // Parse "8:13 PM" format to minutes
        const match = estimate.predicted_departure.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (match) {
          let hours = parseInt(match[1], 10);
          const mins = parseInt(match[2], 10);
          const period = match[3].toUpperCase();
          
          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;
          
          const estimatedMinutes = hours * 60 + mins;
          
          // Handle overnight for estimated times too (if estimated time is early morning when viewing late at night)
          const LATE_NIGHT_THRESHOLD = 18 * 60;
          const EARLY_MORNING_CUTOFF = 4 * 60;
          let adjustedEstimatedMinutes = estimatedMinutes;
          
          if (currentMinutes >= LATE_NIGHT_THRESHOLD && estimatedMinutes < EARLY_MORNING_CUTOFF) {
            adjustedEstimatedMinutes += 24 * 60;
          }
          
          return adjustedEstimatedMinutes > currentMinutes;
        }
      }
      
      // Use helper function to handle overnight trains correctly
      const trainMinutes = getTrainMinutesForComparison(departureTimeStr, currentMinutes);
      return trainMinutes > currentMinutes;
    });
    
    return next || trains[0] || null;
  }, [dayType, direction, scheduleData, estimatedTimes]);
  
  useEffect(() => {
    if (nextTrain?.id !== computedNextTrain?.id) {
      setNextTrain(computedNextTrain);
    }
  }, [computedNextTrain, nextTrain?.id]);

  // Format time for display - handles GTFS overnight times (24:XX, 25:XX = next day AM hours)
  const formatTime = useCallback((timeStr: string) => {
    let [hours, minutes] = timeStr.split(':').map(Number);
    
    // GTFS uses 24:XX, 25:XX etc for overnight trains (past midnight)
    // Normalize to 0-23 range
    hours = hours % 24;
    
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  }, []);



  // Memoize filtered and active alerts
  const activeAlerts = useMemo(() => {
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

  // Memoize current trains list
  const currentTrains = useMemo(() => {
    if (!scheduleData[dayType]) return [];
    return direction === 'inbound' 
      ? scheduleData[dayType].inbound 
      : scheduleData[dayType].outbound;
  }, [direction, dayType, scheduleData]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-white">
      <main className="container py-6 md:py-8 max-w-5xl mx-auto px-2 sm:px-4">
        {/* Modern Alerts Display */}
        <ScheduleAlerts 
          alerts={activeAlerts} 
          onDismiss={(id: string) => setDismissedAlerts(prev => new Set(prev).add(id))} 
        />

        {/* Schedule Loading/Error State */}
        {scheduleLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-zinc-400 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Loading schedule...</span>
          </div>
        )}
        {scheduleError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs mb-3">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{scheduleError}</span>
          </div>
        )}

        {/* Header Bar - Consistent with Dashboard */}
        <ScheduleHeader 
          direction={direction}
          setDirection={setDirection}
          selectedGtfsId={selectedGtfsId}
          setSelectedGtfsId={setSelectedGtfsId}
          lastUpdate={lastUpdate}
        />

        {refreshError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-600 text-xs">
            {refreshError}
          </div>
        )}

        {/* Next Train Status - Single Card */}
        {nextTrain && (() => {
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
          
          const hasGPSTracking = tripId && delays.has(tripId);
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
                  <WeatherWidget 
                    location={direction === 'inbound' ? selectedStation.name : 'Chicago'} 
                  />
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
                <div className="flex items-center gap-4 mt-2 pt-2 border-t border-zinc-100 text-sm text-zinc-600">
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
                  <a 
                    href={(() => {
                      const now = new Date();
                      const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
                      const timestamp = Math.floor(thirtyMinAgo.getTime() / 1000);
                      const origin = direction === 'inbound' ? selectedGtfsId : (selectedStation.terminal || 'OTC');
                      const dest = direction === 'inbound' ? (selectedStation.terminal || 'OTC') : selectedGtfsId;
                      const line = selectedStation.line || 'UP-NW';
                      return `https://www.metra.com/schedules?line=${line}&orig=${origin}&dest=${dest}&time=${timestamp}&allstops=0&redirect=${Math.floor(now.getTime() / 1000)}`;
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
        })()}

        {/* Full Schedule - Single Direction */}
        <div>
          <ScheduleTable 
            trains={currentTrains} 
            formatTime={formatTime}
            nextTrainId={nextTrain?.id}
            tripIdMap={tripIdMap}
            delays={delays}
            predictedTimes={predictedTimes}
            crowdingData={crowdingData}
            estimatedTimes={estimatedTimes}

            currentMinutes={currentMinutes}
            direction={direction}
          />
        </div>

        {/* Train Map */}
        <div className="mt-6">
          <Suspense fallback={
            <div className="rounded-xl border border-zinc-200 shadow-sm overflow-hidden bg-white h-[280px] flex items-center justify-center">
              <div className="text-zinc-400 text-sm flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading map...
              </div>
            </div>
          }>
            <TrainMap />
          </Suspense>
        </div>
      </main>
    </div>
  );
}


