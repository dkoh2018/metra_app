import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { Train } from '@shared/types';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { getCurrentMinutesInChicago } from '@/lib/time';

// Refactored Imports
import { Direction } from '@/types/schedule';
import { getTrainMinutesForComparison } from '@/lib/schedule-helpers';
import { getMinutesUntilTrain, OVERNIGHT_CONFIG } from '@/lib/overnight-utils';
import { ScheduleTable } from '@/components/schedule/ScheduleTable';
import { ScheduleAlerts } from '@/components/schedule/ScheduleAlerts';
import { ScheduleHeader } from '@/components/schedule/ScheduleHeader';
import { NextTrainCard } from '@/components/schedule/NextTrainCard';
import { useScheduleData } from '@/hooks/useScheduleData';
import { useActiveAlerts } from '@/hooks/useActiveAlerts';

// Lazy load the map component since it's heavy
const TrainMap = lazy(() => import('@/components/TrainMap'));

import { STATIONS, Station } from '@/lib/stations';

export default function Schedule() {
  // Initialize direction from sessionStorage (persists on refresh, clears on tab close)
  const [direction, setDirection] = useState<Direction>(() => {
    const saved = sessionStorage.getItem('metra_direction');
    return (saved === 'inbound' || saved === 'outbound') ? saved : 'inbound';
  });
  const [nextTrain, setNextTrain] = useState<Train | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // Save direction to sessionStorage when it changes
  useEffect(() => {
    sessionStorage.setItem('metra_direction', direction);
  }, [direction]);

  // Phase 2: Multi-Station State
  // Get default station: first highlighted station, or fallback to first station with gtfsId
  const getDefaultStation = (): Station => {
    const highlighted = Object.values(STATIONS).find(s => s.isHighlight && s.gtfsId);
    if (highlighted) return highlighted;
    const firstWithGtfsId = Object.values(STATIONS).find(s => s.gtfsId);
    return firstWithGtfsId || Object.values(STATIONS)[0];
  };
  
  const defaultStation = getDefaultStation();
  
  // Use sessionStorage so station persists on refresh but resets on new browser session
  const [selectedGtfsId, setSelectedGtfsId] = useState<string>(() => {
    const saved = sessionStorage.getItem('selectedStation');
    if (saved && Object.values(STATIONS).some(s => s.gtfsId === saved)) {
      return saved;
    }
    return defaultStation.gtfsId!;
  });
  
  // Save station selection to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('selectedStation', selectedGtfsId);
  }, [selectedGtfsId]);
  
  const selectedStation = Object.values(STATIONS).find(s => s.gtfsId === selectedGtfsId) || defaultStation;
  
  console.log('[Schedule] Render State:', { 
    selectedGtfsId, 
    line: selectedStation.line, 
    terminal: selectedStation.terminal 
  });

  const {
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
      refreshError
  } = useScheduleData(selectedGtfsId, selectedStation, direction);

  // Use the new hook for active alerts
  const activeAlerts = useActiveAlerts(alerts, dismissedAlerts);

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
    
    // Find all upcoming trains with their minutes-until-departure
    const upcomingTrains = trains.map(train => {
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
    upcomingTrains.sort((a, b) => a.minutesUntil - b.minutesUntil);
    
    // Find first train with valid (non-Infinity) minutes until
    const next = upcomingTrains.find(t => t.minutesUntil !== Infinity && t.minutesUntil > 0);
    
    return next?.train || trains[0] || null;
  }, [dayType, direction, scheduleData, estimatedTimes, currentMinutes]);
  
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
        {nextTrain && (
          <NextTrainCard
            direction={direction}
            selectedStation={selectedStation}
            nextTrain={nextTrain}
            tripIdMap={tripIdMap}
            delays={delays}
            predictedTimes={predictedTimes}
            estimatedTimes={estimatedTimes}
            crowdingData={crowdingData}
            selectedGtfsId={selectedGtfsId}
          />
        )}

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
