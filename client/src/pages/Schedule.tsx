import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { Train } from '@shared/types';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { getCurrentMinutesInChicago } from '@/lib/time';
import { calculateDuration } from '@/lib/time-utils';
import { getMetraScheduleUrl } from '@shared/metra-urls';

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
import { useWeather } from '@/hooks/useWeather';
import { useNextTrain } from '@/hooks/useNextTrain';

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

  // Weather Hook (for debugging)
  const { getWeatherForLocation } = useWeather();

  // Derived State
  const selectedStation = Object.values(STATIONS).find(s => s.gtfsId === selectedGtfsId) || defaultStation;

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
  // Use extracted hook for next train calculation
  const computedNextTrain = useNextTrain({
    scheduleData,
    dayType,
    direction,
    estimatedTimes,
    currentMinutes
  });
  
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
    const trains = direction === 'inbound' 
      ? scheduleData[dayType].inbound 
      : scheduleData[dayType].outbound;
      
    console.log(`[DEBUG] 🚆 Rendering Schedule: ${dayType}, Direction: ${direction}, Count: ${trains?.length || 0}`);
    return trains;
  }, [direction, dayType, scheduleData]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-white">
      <main className="container py-6 md:py-8 max-w-5xl mx-auto px-2 sm:px-4">
        {/* Modern Alerts Display */}
        <ScheduleAlerts 
          alerts={activeAlerts} 
          onDismiss={(id: string) => setDismissedAlerts(prev => new Set(prev).add(id))} 
        />

        {/* Station-specific Theme Banner */}
        {selectedStation.theme?.bannerMessage && (
          <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm font-medium flex items-center justify-center text-center shadow-sm">
            {selectedStation.theme.bannerMessage}
          </div>
        )}

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
