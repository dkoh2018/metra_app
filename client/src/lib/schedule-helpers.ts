
import { ApiTrain, CrowdingLevel } from '../types/schedule';
import { parseTimeToMinutes } from './time-utils';
import { Train } from './scheduleData';

// Cache compiled regex patterns for better performance
// Supports UP-NW (UNW) and MD-W (MW) IDs
export const TRIP_ID_REGEX = /(?:UNW|MW)(\d+)/;
export const TIME_PATTERN_REGEX = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/gi;
export const MINUTES_PATTERN_REGEX = /(\d+)\s*min/;

export const CROWDING_DOT_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-600",
  some: "bg-amber-500",
  moderate: "bg-orange-500",
  high: "bg-red-700"
};

export const CROWDING_LABELS: Record<CrowdingLevel, string> = {
  low: "Low",
  some: "Some",
  moderate: "Moderate",
  high: "High"
};

// Transform API train to frontend Train format
export function transformTrain(apiTrain: ApiTrain, tripIdMap: Map<string, string>): Train {
  // Extract train number from trip_id (e.g. "UP-NW_UNW608_V1_A" -> "608")
  // Or "MD-W_MW2200_V2_A" -> "2200"
  let trainId = "Unknown";
  
  // Try regex match first
  const match = apiTrain.trip_id.match(TRIP_ID_REGEX);
  if (match && match[1]) {
    trainId = match[1];
  } else {
    // Fallback: split by _ and try to find the part with digits
    const parts = apiTrain.trip_id.split('_');
    const numberPart = parts.find(p => /\d+/.test(p) && (p.includes('UNW') || p.includes('MW')));
    if (numberPart) {
      trainId = numberPart.replace('UNW', '').replace('MW', '');
    }
  }

  // Populate map for reverse lookup (Train # -> Trip ID)
  if (trainId !== "Unknown") {
    tripIdMap.set(trainId, apiTrain.trip_id);
  }

  return {
    id: trainId,
    departureTime: apiTrain.departure_time,
    arrivalTime: apiTrain.arrival_time,
    isExpress: !!apiTrain.is_express,
    // Add original trip_id for debugging/matching
    _tripId: apiTrain.trip_id 
  };
}

// Helper to convert departure time to minutes for comparison (handles overnight trains)
export function getTrainMinutesForComparison(departureTimeStr: string, currentMinutesValue: number): number {
  if (!departureTimeStr) return 9999;
  
  let validTimeStr = departureTimeStr;
  
  // Handle strings like "25:15:00" (GTFS overnight format)
  // But also handle "1:15 AM" which might be overnight if it's currently 11 PM
  // Or "1:15 AM" which is morning if it's currently 8 AM
  
  // Standard parser
  let mins = parseTimeToMinutes(validTimeStr);
  
  // Handle GTFS > 24h times immediately
  const parts = validTimeStr.split(':');
  if (parseInt(parts[0]) >= 24) {
    return mins; // parseTimeToMinutes handles it or returns > 1440
  }
  
  // If the train is early morning (e.g. 00:30) and we are late night (e.g. 23:30),
  // treat the train as "tomorrow" (add 24h) so it appears at the bottom
  // Threshold: if train is < 4am and current is > 8pm
  if (mins < 4 * 60 && currentMinutesValue > 20 * 60) {
    mins += 24 * 60;
  }
  
  return mins;
}
