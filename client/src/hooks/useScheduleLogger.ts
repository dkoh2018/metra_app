import { useEffect } from 'react';
import { Train, Station } from '@shared/types';
import { Direction } from '@/types/schedule';
import { calculateDuration } from '@/lib/time-utils';
import { getMetraScheduleUrl } from '@shared/metra-urls';
import { useWeather } from '@/hooks/useWeather';

interface UseScheduleLoggerProps {
  nextTrain: Train | null;
  currentTrains: Train[];
  crowdingData: Map<string, any>;
  delays: Map<string, number>;
  estimatedTimes: Map<string, any>;
  tripIdMap: Map<string, string>;
  selectedStation: Station;
  direction: Direction;
  selectedGtfsId: string;
  dayType: string;
}

export function useScheduleLogger({
  nextTrain,
  currentTrains,
  crowdingData,
  delays,
  estimatedTimes,
  tripIdMap,
  selectedStation,
  direction,
  selectedGtfsId,
  dayType
}: UseScheduleLoggerProps) {
  
  // Weather hook for debug
  const { getWeatherForLocation } = useWeather();

  useEffect(() => {
    // 1. Log Next Train Info (Detailed)
    if (nextTrain) {
      const tripId = tripIdMap.get(nextTrain.id);
      const crowding = tripId ? (crowdingData.get(tripId) || crowdingData.get(nextTrain.id)) : crowdingData.get(nextTrain.id);
      const delay = tripId ? (delays.get(tripId) || 0) : 0;
      const duration = calculateDuration(nextTrain.departureTime, nextTrain.arrivalTime);
      
      // Generate Tracker URL (same logic as NextTrainCard)
      const now = new Date();
      const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
      const origin = direction === 'inbound' ? selectedGtfsId : (selectedStation.terminal || 'OTC');
      const dest = direction === 'inbound' ? (selectedStation.terminal || 'OTC') : selectedGtfsId;
      const line = selectedStation.line || 'UP-NW';
      
      const trackerUrl = getMetraScheduleUrl({
        origin,
        destination: dest,
        line,
        date: thirtyMinAgo
      });
      
      // Get weather for debug
      const locationName = direction === 'inbound' ? 'Chicago' : selectedStation.name;
      const weather = getWeatherForLocation(locationName);

      console.log(`\n🚆 [NEXT TRAIN DEBUG] Current Next Train: #${nextTrain.id}`);
      console.log(`   Depart: ${nextTrain.departureTime} (Scheduled)`);
      console.log(`   Arrive: ${nextTrain.arrivalTime} (Scheduled)`);
      console.log(`   Duration: ${duration}m`);
      console.log(`   Crowding: ${crowding ? `🟠 ${crowding}` : '⚪ none/unknown'}`);
      console.log(`   Delay: ${delay > 0 ? `⚠️ ${Math.round(delay/60)} min` : '✅ on time'}`);
      console.log(`   Weather (${locationName}): ${weather ? `${Math.round(weather.temp_f)}°F` : 'Loading/Unavailable'}`);
      console.log(`   Trip ID: ${tripId || 'N/A'}`);
      console.log(`   Tracker URL: ${trackerUrl}`);
      console.log(`   Is Express: ${nextTrain.isExpress}`);
      console.log(``);
    }

    // 2. Log Full Schedule Table
    if (currentTrains.length > 0) {
      console.log(`📋 [TRAIN SCHEDULE DEBUG] Schedule for ${selectedStation.name} ${direction} (First 10):`);
      
      currentTrains.slice(0, 10).forEach((train) => {
        // Use _tripId if available (from transformTrain), otherwise check map
        const storedTripId = (train as any)._tripId; 
        const mappedTripId = tripIdMap.get(train.id);
        const activeTripId = storedTripId || mappedTripId;

        const crowding = activeTripId ? (crowdingData.get(activeTripId) || crowdingData.get(train.id)) : crowdingData.get(train.id);
        const estimated = estimatedTimes.get(train.id); // keyed by train ID usually
        const delay = activeTripId ? (delays.get(activeTripId) || 0) : 0;
        const duration = calculateDuration(train.departureTime, train.arrivalTime);
        
        console.log(`   Train ${train.id}:`);
        console.log(`     Depart: ${train.departureTime}${estimated?.predicted_departure ? ` → ${estimated.predicted_departure} (DELAYED)` : ''}`);
        console.log(`     Arrive: ${train.arrivalTime}${estimated?.predicted_arrival ? ` → ${estimated.predicted_arrival} (DELAYED)` : ''}`);
        console.log(`     Duration: ${duration}m`);
        console.log(`     Crowding: ${crowding ? `🟠 ${crowding}` : '⚪ none'}`);
        console.log(`     Delay: ${delay > 0 ? `⚠️ ${Math.round(delay/60)} min` : '✅ on time'}`);
        console.log(`     Trip ID: ${activeTripId || 'N/A'}`);
        console.log(``);
      });
      console.log(`   Legend: 🟠 = has crowding data | ⚪ = no crowding | ⚠️ = delayed | ✅ = on time\n`);
    } else {
        console.log(`⚠️ [TRAIN SCHEDULE DEBUG] No trains found for ${dayType} ${direction}`);
    }
  }, [currentTrains, nextTrain, crowdingData, estimatedTimes, delays, selectedStation, direction, tripIdMap, selectedGtfsId]);
}
