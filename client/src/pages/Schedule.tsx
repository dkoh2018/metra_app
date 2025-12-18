import { useState, useEffect, useRef, useMemo, useCallback, memo, lazy, Suspense } from 'react';
import { Train } from '@/lib/scheduleData';
import { ArrowRight, Clock, RefreshCw, ArrowLeftRight, AlertTriangle, ExternalLink, X, Info, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getChicagoTime, getServiceDayType, getCurrentMinutesInChicago, formatChicagoTime } from '@/lib/time';


// Lazy load the map component since it's heavy
const TrainMap = lazy(() => import('@/components/TrainMap'));
import { StationSelector } from '@/components/StationSelector';
import { STATIONS, Station } from '@/lib/stations';

type DayType = 'weekday' | 'saturday' | 'sunday';
type Direction = 'inbound' | 'outbound';
type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';

// API response types
interface ApiTrain {
  trip_id: string;
  departure_time: string;
  arrival_time: string;
  is_express: boolean | number;
}

interface ApiSchedule {
  type: DayType;
  inbound: ApiTrain[];
  outbound: ApiTrain[];
}

interface ApiAlerts {
  id: string;
  alert?: {
    activePeriod?: Array<{ start?: string; end?: string }>;
    informedEntity?: Array<{ routeId?: string }>;
    headerText?: { translation?: Array<{ text?: string }> };
    descriptionText?: { translation?: Array<{ text?: string }> };
  };
}

// Cache compiled regex patterns for better performance
// Supports UP-NW (UNW) and MD-W (MW) IDs
const TRIP_ID_REGEX = /(?:UNW|MW)(\d+)/;
const TIME_PATTERN_REGEX = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/gi;
const CROWDING_BADGE_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-100 text-emerald-600 font-semibold",
  some: "bg-amber-200 text-amber-800",
  moderate: "bg-orange-100 text-orange-700",
  high: "bg-red-100 text-rose-600 font-semibold"
};
const CROWDING_DOT_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-600",
  some: "bg-amber-500",
  moderate: "bg-orange-500",
  high: "bg-red-700"
};
const CROWDING_LABELS: Record<CrowdingLevel, string> = {
  low: "Low",
  some: "Some",
  moderate: "Moderate",
  high: "High"
};

// Helper function to parse time string to minutes (handles both "8:13 PM" and "19:13" formats)
function parseTimeToMinutes(timeStr: string): number {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const meridian = match[3]?.toUpperCase();
    if (meridian === 'PM' && h !== 12) h += 12;
    if (meridian === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }
  // Fallback: simple 24h split "19:12"
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function formatPredictedTimeDisplay(timeStr?: string | null): string | null {
  if (!timeStr) return null;

  const asDate = new Date(timeStr);
  if (!isNaN(asDate.getTime())) {
    return formatChicagoTime(asDate, { hour: 'numeric', minute: '2-digit' });
  }

  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const chicagoTime = getChicagoTime();
    chicagoTime.setHours(hours, minutes, 0, 0);
    return formatChicagoTime(chicagoTime, { hour: 'numeric', minute: '2-digit' });
  }

  return null;
}

// Transform API train to frontend Train format
function transformTrain(apiTrain: ApiTrain, tripIdMap: Map<string, string>): Train {
  // Extract train number from trip_id (e.g., "UP-NW_UNW634_V3_A" -> "634")
  const match = apiTrain.trip_id.match(TRIP_ID_REGEX);
  const trainId = match ? match[1] : apiTrain.trip_id;
  
  // Store mapping of train_id -> trip_id for delay lookup
  tripIdMap.set(trainId, apiTrain.trip_id);
  
  return {
    id: trainId,
    departureTime: apiTrain.departure_time.substring(0, 5), // "HH:MM:SS" -> "HH:MM"
    arrivalTime: apiTrain.arrival_time.substring(0, 5),
    isExpress: Boolean(apiTrain.is_express)
  };
}

// Calculate trip duration in minutes
function calculateDuration(departureTime: string, arrivalTime: string): number {
  const parse = (t: string) => {
    // Handle "10:22 PM" format from scraper/formatter
    const match = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const meridian = match[3]?.toUpperCase();
      if (meridian === 'PM' && h !== 12) h += 12;
      if (meridian === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    }
    
    // Fallback: simple 24h split "19:12"
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  
  const depTotalMinutes = parse(departureTime);
  let arrTotalMinutes = parse(arrivalTime);
  
  if (isNaN(depTotalMinutes) || isNaN(arrTotalMinutes)) return 0;
  
  // Handle next-day arrival (e.g., 23:30 -> 00:15)
  if (arrTotalMinutes < depTotalMinutes) {
    arrTotalMinutes += 24 * 60;
  }

  return arrTotalMinutes - depTotalMinutes;
}

function getChicagoMinutesFromTimeString(timeStr?: string | null): number | null {
  if (!timeStr) return null;

  const maybeIsoDate = timeStr.match(/\d{4}-\d{2}-\d{2}/);
  let date: Date | null = null;

  if (maybeIsoDate) {
    const parsed = new Date(timeStr);
    date = isNaN(parsed.getTime()) ? null : parsed;
  } else {
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    const now = getChicagoTime();
    now.setHours(hours, minutes, 0, 0);
    date = now;
  }

  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);

  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

  return hour * 60 + minute;
}

function isPredictedTimeReasonable(
  predicted?: string | null,
  scheduled?: string | null,
  fallbackScheduleTime?: string
): boolean {
  if (!predicted) return false;

  const predictedMinutes = getChicagoMinutesFromTimeString(predicted);
  if (predictedMinutes === null) return false;

  const scheduledMinutes =
    getChicagoMinutesFromTimeString(fallbackScheduleTime) ??
    getChicagoMinutesFromTimeString(scheduled);

  if (scheduledMinutes === null) return true;

  let diff = Math.abs(predictedMinutes - scheduledMinutes);
  if (diff > 720) {
    diff = Math.min(diff, 1440 - diff);
  }

  return diff <= 180; // ignore obviously wrong data (>3 hours off)
}

export default function Schedule() {
  const [currentTime, setCurrentTime] = useState(getChicagoTime());
  const [dayType, setDayType] = useState<DayType>('weekday');
  const [direction, setDirection] = useState<Direction>('inbound');
  const [nextTrain, setNextTrain] = useState<Train | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [scheduleData, setScheduleData] = useState<{ [key: string]: { inbound: Train[]; outbound: Train[] } }>({
    weekday: { inbound: [], outbound: [] },
    saturday: { inbound: [], outbound: [] },
    sunday: { inbound: [], outbound: [] }
  });
  const [alerts, setAlerts] = useState<ApiAlerts[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [delays, setDelays] = useState<Map<string, number>>(new Map());
  const [predictedTimes, setPredictedTimes] = useState<Map<string, { 
    scheduled?: string; 
    predicted?: string; 
    stop_id: string;
  }>>(new Map());
  const [tripIdMap, setTripIdMap] = useState<Map<string, string>>(new Map());
  const [crowdingData, setCrowdingData] = useState<Map<string, CrowdingLevel>>(new Map());
  const [estimatedTimes, setEstimatedTimes] = useState<Map<string, {
    scheduled_departure: string | null;
    predicted_departure: string | null;
    scheduled_arrival: string | null;
    predicted_arrival: string | null;
  }>>(new Map());
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

  const fetchCrowdingRef = useRef<((forceRefresh?: boolean) => void) | null>(null);
  const lastFetchMinuteRef = useRef<number | null>(null);
  const isFetchingCrowdingRef = useRef<boolean>(false);

  // Initialize day type based on current service day
  useEffect(() => {
    const chicagoTime = getChicagoTime();
    const serviceDayType = getServiceDayType(chicagoTime);
    const currentMinutes = getCurrentMinutesInChicago();
    console.debug(`[Schedule] Initializing: Chicago time: ${chicagoTime.toLocaleString()}, serviceDayType: ${serviceDayType}, currentMinutes: ${currentMinutes} (${Math.floor(currentMinutes/60)}:${String(currentMinutes%60).padStart(2, '0')})`);
    setDayType(serviceDayType);
  }, []);

  // Update current time every 15 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = getChicagoTime();
      setCurrentTime(now);
      
      const currentServiceDay = getServiceDayType(now);
      const currentMinutes = getCurrentMinutesInChicago();
      setDayType(prev => {
        if (prev !== currentServiceDay) {
          console.debug(`[Schedule] Day type changed: ${prev} -> ${currentServiceDay} at ${Math.floor(currentMinutes/60)}:${String(currentMinutes%60).padStart(2, '0')}`);
          return currentServiceDay;
        }
        return prev;
      });
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Memoize currentMinutes to only change when the minute value changes
  // This prevents unnecessary re-renders when seconds change but minute stays the same
  // Extract hour:minute from currentTime in Chicago timezone as the dependency key
  const currentMinutesKey = useMemo(() => {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(currentTime);
  }, [currentTime]);

  const currentMinutes = useMemo(() => {
    return getCurrentMinutesInChicago();
  }, [currentMinutesKey]);

  // Fetch schedule data from GTFS API
  useEffect(() => {
    setScheduleLoading(true);
    setScheduleError(null);
    
    const terminalId = selectedStation.terminal || 'OTC';
    
    fetch(`/api/schedule?station=${selectedGtfsId}&terminal=${terminalId}`)
      .then(res => {
        if (!res.ok) {
          if (res.status === 503) {
            console.log('Database not available, using fallback schedule');
            return null;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: { weekday?: ApiSchedule; saturday?: ApiSchedule; sunday?: ApiSchedule } | null) => {
        if (data) {
          const newTripIdMap = new Map<string, string>();
          
          const transformed: { [key: string]: { inbound: Train[]; outbound: Train[] } } = {
            weekday: {
              inbound: (data.weekday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.weekday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            },
            saturday: {
              inbound: (data.saturday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.saturday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            },
            sunday: {
              inbound: (data.sunday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.sunday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            }
          };
          setScheduleData(transformed);
          setTripIdMap(newTripIdMap);
        } else {
          const fallback = require('@/lib/scheduleData').scheduleData;
          setScheduleData(fallback);
        }
        setScheduleLoading(false);
      })
      .catch(error => {
        setScheduleLoading(false);
      });
  }, [selectedGtfsId]); // Refresh when station changes

  // Fetch alerts from Metra API
  useEffect(() => {
    fetch('/api/alerts')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: ApiAlerts[]) => {
        const currentLine = selectedStation.line || 'UP-NW';
        const lineAlerts = data.filter(alert => {
          const routeIds = alert.alert?.informedEntity?.map(e => e.routeId) || [];
          return routeIds.includes(currentLine) || routeIds.length === 0;
        });
        setAlerts(lineAlerts);
      })
      .catch(error => {
        console.debug('Could not fetch alerts:', error.message);
      });
  }, [selectedStation.line]);

  // Fetch delays from API
  useEffect(() => {
    const fetchDelays = () => {
      fetch('/api/delays')
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((data: { delays: Array<{ 
          trip_id: string; 
          stop_id: string; 
          delay_seconds: number;
          scheduled_arrival?: string | null;
          scheduled_departure?: string | null;
          predicted_arrival?: string | null;
          predicted_departure?: string | null;
        }> }) => {
          const delayMap = new Map<string, number>();
          const predictedMap = new Map<string, { scheduled?: string; predicted?: string; stop_id: string }>();
          
          data.delays.forEach(delay => {
            const terminalId = selectedStation.terminal || 'OTC';
            const destinationStopId = direction === 'inbound' ? terminalId : selectedGtfsId;
            const originStopId = direction === 'inbound' ? selectedGtfsId : terminalId;
            
            if (delay.stop_id === destinationStopId) {
              const existingDelay = delayMap.get(delay.trip_id) || 0;
              delayMap.set(delay.trip_id, Math.max(existingDelay, delay.delay_seconds));
              
              if (delay.scheduled_arrival && delay.predicted_arrival) {
                predictedMap.set(`${delay.trip_id}_arrival`, {
                  scheduled: delay.scheduled_arrival,
                  predicted: delay.predicted_arrival,
                  stop_id: delay.stop_id
                });
              }
            }
            
            if (delay.stop_id === originStopId) {
              if (delay.scheduled_departure && delay.predicted_departure) {
                predictedMap.set(`${delay.trip_id}_departure`, {
                  scheduled: delay.scheduled_departure,
                  predicted: delay.predicted_departure,
                  stop_id: delay.stop_id
                });
              }
            }
          });
          
          setDelays(delayMap);
          setPredictedTimes(predictedMap);
          setLastUpdate(new Date().toISOString());
        })
        .catch(error => {
          console.debug('Could not fetch delays:', error.message);
        });
    };
    
    fetchDelays();
    
    const now = new Date();
    const msToNextSync = 30000 - (now.getTime() % 30000);
    
    let interval: NodeJS.Timeout;
    const timeout = setTimeout(() => {
      fetchDelays();
      interval = setInterval(fetchDelays, 30000);
    }, msToNextSync);
    
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [direction, selectedGtfsId]);

  // Fetch crowding data (uses DB cache via backend, persists to localStorage for instant display)
  useEffect(() => {
    // Load from localStorage first (instant display of DB values from last session)
    const reloadFromStorage = () => {
      try {
        const saved = localStorage.getItem(`crowding_${selectedGtfsId}`);
        if (saved) {
          const parsed = JSON.parse(saved) as Record<string, CrowdingLevel>;
          const loaded = new Map(Object.entries(parsed));
          setCrowdingData(loaded);
          console.debug(`[CROWDING] Loaded ${loaded.size} entries from localStorage (DB values from last session) for ${selectedStation.name}`);
        } else {
          console.debug(`[CROWDING] No localStorage data for ${selectedStation.name}, will load from DB via API`);
        }
      } catch (error) {
        console.debug('Could not load crowding data from localStorage:', error);
      }
    };

    const fetchCrowding = (forceRefresh = false) => {
      if (isFetchingCrowdingRef.current && !forceRefresh) {
        return;
      }

      isFetchingCrowdingRef.current = true;

      console.debug(
        `Crowding: fetching data${forceRefresh ? ' (forced refresh)' : ''} at ${new Date().toLocaleTimeString()}`
      );

      const forceParam = forceRefresh ? '&force=true' : '';
      const terminalId = selectedStation.terminal || 'OTC';
      const lineId = selectedStation.line || 'UP-NW';
      
      const stationToTerminal = fetch(`/api/crowding?origin=${selectedGtfsId}&destination=${terminalId}&line=${lineId}${forceParam}`)
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .catch(error => {
          console.debug(`Could not fetch crowding data (${selectedGtfsId}->${terminalId}):`, error.message);
          return null;
        });
      
      const terminalToStation = fetch(`/api/crowding?origin=${terminalId}&destination=${selectedGtfsId}&line=${lineId}${forceParam}`)
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .catch(error => {
          console.debug(`Could not fetch crowding data (${terminalId}->${selectedGtfsId}):`, error.message);
          return null;
        });
      
      Promise.all([stationToTerminal, terminalToStation])
        .then(([stationData, terminalData]) => {
          // If both failed, don't update anything to preserve stale (but visible) data
          if (!stationData && !terminalData) {
            console.debug('Both crowding requests failed, preserving partial data');
            return;
          }

          const crowdingMap = new Map<string, CrowdingLevel>();
          const estimatedMap = new Map<string, {
            scheduled_departure: string | null;
            predicted_departure: string | null;
            scheduled_arrival: string | null;
            predicted_arrival: string | null;
          }>();

          // Helper to process data if it exists
          const processData = (data: any) => {
            if (!data?.crowding) return;
            
            data.crowding.forEach((item: { 
              trip_id: string; 
              crowding: CrowdingLevel;
              scheduled_departure?: string | null;
              predicted_departure?: string | null;
              scheduled_arrival?: string | null;
              predicted_arrival?: string | null;
            }) => {
              const match = item.trip_id.match(TRIP_ID_REGEX);
              if (match) {
                const trainNumber = match[1];
                crowdingMap.set(trainNumber, item.crowding);
                crowdingMap.set(item.trip_id, item.crowding);
                
                // Store estimated times
                if (item.predicted_departure || item.predicted_arrival) {
                  estimatedMap.set(trainNumber, {
                    scheduled_departure: item.scheduled_departure || null,
                    predicted_departure: item.predicted_departure || null,
                    scheduled_arrival: item.scheduled_arrival || null,
                    predicted_arrival: item.predicted_arrival || null
                  });
                }
              }
            });
          };

          processData(stationData);
          processData(terminalData);
          
          // Smart merge strategy: preserve existing data for failed directions
          setCrowdingData(prev => {
             // If both succeeded, replace entirely with fresh data
             if (stationData && terminalData) {
               console.debug('Crowding: both directions succeeded, replacing all data');
               // Save to localStorage for instant display on next page load
               try {
                 const toSave = Object.fromEntries(crowdingMap);
                 localStorage.setItem(`crowding_${selectedGtfsId}`, JSON.stringify(toSave));
               } catch (error) {
                 console.debug('Could not save crowding data to localStorage:', error);
               }
               return crowdingMap;
             }
             
             // If partial success, merge new data with existing data
             // This prevents losing data from the direction that failed
             const merged = new Map(prev);
             
             // Add/update entries from successful direction(s)
             crowdingMap.forEach((value, key) => {
               merged.set(key, value);
             });
             
             if (!stationData) {
               console.debug('Crowding: station->terminal failed, preserving existing outbound data');
             }
             if (!terminalData) {
               console.debug('Crowding: terminal->station failed, preserving existing inbound data');
             }
             
             // Save merged data to localStorage
             try {
               const toSave = Object.fromEntries(merged);
               localStorage.setItem(`crowding_${selectedGtfsId}`, JSON.stringify(toSave));
             } catch (error) {
               console.debug('Could not save crowding data to localStorage:', error);
             }
             
             return merged;
          });
          
          setEstimatedTimes(prev => {
             // If both succeeded, replace entirely with fresh data
             if (stationData && terminalData) {
               return estimatedMap;
             }
             
             // If partial success, merge new data with existing data
             const merged = new Map(prev);
             
             // Add/update entries from successful direction(s)
             estimatedMap.forEach((value, key) => {
               merged.set(key, value);
             });
             
             return merged;
          });

          


          const stationDirection = `${selectedStation.name}->${terminalId === 'OTC' ? 'Chicago OTC' : 'Chicago CUS'}`;
          const terminalDirection = `${terminalId === 'OTC' ? 'Chicago OTC' : 'Chicago CUS'}->${selectedStation.name}`;
          
          console.debug(
            `Crowding: ${stationData && terminalData ? 'Both directions' : 'Partial'} update - ` +
            `${crowdingMap.size} train entries, ${estimatedMap.size} with estimated times | ` +
            `${stationDirection}: ${stationData?.crowding?.length || 0} trains ${stationData ? '✓' : '✗'} | ` +
            `${terminalDirection}: ${terminalData?.crowding?.length || 0} trains ${terminalData ? '✓' : '✗'}`
          );
        })
        .catch(error => {
          console.debug('Could not fetch crowding data:', error.message);
        })
        .finally(() => {
          isFetchingCrowdingRef.current = false;
        });
    };
    
    fetchCrowdingRef.current = fetchCrowding;
    
    // Load from localStorage first (instant display of DB values from last session)
    reloadFromStorage();
    
    // Then fetch from API (which uses DB cache - seamless update if new data available)
    fetchCrowding();
    
    // Visibility-based polling - stop when tab is hidden, resume when visible
    let interval: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    
    const startPolling = () => {
      if (interval) return; // Already polling
      
      const now = new Date();
      const msToNextSync = 60000 - (now.getTime() % 60000); // Poll every 60 sec instead of 30
      
      timeout = setTimeout(() => {
        fetchCrowding(false);
        interval = setInterval(() => fetchCrowding(false), 60000);
      }, msToNextSync);
    };
    
    const stopPolling = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
        console.debug('Tab hidden - polling paused');
      } else {
        fetchCrowding(true); // Refresh data immediately when tab becomes visible
        startPolling();
        console.debug('Tab visible - polling resumed');
      }
    };
    
    // Start polling initially (tab is visible)
    startPolling();
    
    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      fetchCrowdingRef.current = null;
    };
  }, [selectedGtfsId, direction]);

  // Fetch real-time status on mount
  useEffect(() => {
    fetch('/api/realtime-status')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (data && data.last_update) {
          setLastUpdate(data.last_update);
        }
      })
      .catch(error => {
        console.debug('Could not fetch real-time status:', error.message);
      });
  }, []);

  // Refresh real-time data and alerts
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    
    try {
      const [realtimeResponse, alertsResponse] = await Promise.all([
        fetch('/api/refresh-realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }),
        fetch('/api/alerts').catch(() => ({ ok: false }))
      ]);
      
      if (!realtimeResponse.ok) {
        let errorMessage = `Server error: ${realtimeResponse.status}`;
        try {
          const errorData = await realtimeResponse.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch {
          errorMessage = realtimeResponse.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }
      
      const data = await realtimeResponse.json();
      
      if (data && data.timestamp) {
        setLastUpdate(data.timestamp);
      }
      
      if (alertsResponse.ok && 'json' in alertsResponse) {
        const alertData: ApiAlerts[] = await alertsResponse.json();
        const currentLine = selectedStation.line || 'UP-NW';
        const lineAlerts = alertData.filter(alert => {
          const routeIds = alert.alert?.informedEntity?.map(e => e.routeId) || [];
          return routeIds.includes(currentLine) || routeIds.length === 0;
        });
        setAlerts(lineAlerts);
      }
      
      if (fetchCrowdingRef.current) {
        fetchCrowdingRef.current(true);
      }
      
      setTimeout(() => {
        setIsRefreshing(false);
      }, 500);
    } catch (error: any) {
      setRefreshError(error.message || 'Failed to refresh. Make sure backend is running.');
      setIsRefreshing(false);
    }
  }, []);

  // Find next train based on current view mode
  // Uses estimated departure time when available to prevent skipping delayed trains
  // Handles overnight trains correctly (24:XX format and 00:XX when viewing late at night)
  const computedNextTrain = useMemo(() => {
    const currentMinutes = getCurrentMinutesInChicago();
    const currentSchedule = scheduleData[dayType];
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
    
    // Helper to convert departure time to minutes for comparison (handles overnight trains)
    const getTrainMinutesForComparison = (departureTimeStr: string, currentMinutesValue: number): number => {
      const [hours, minutes] = departureTimeStr.split(':').map(Number);
      
      // GTFS overnight trains (24:XX, 25:XX) are for "next day"
      if (hours >= 24) {
        // Normalize to 0-23 range and add 24 hours (1440 minutes) for comparison
        const normalizedHours = hours - 24;
        return normalizedHours * 60 + minutes + (24 * 60); // Add day offset
      }
      
      // Regular time (00:XX to 23:XX)
      let trainMinutes = hours * 60 + minutes;
      
      // If viewing late at night (after 6 PM) and train is early morning (00:XX to 04:XX)
      // Treat it as "tomorrow" (add 24 hours)
      const LATE_NIGHT_THRESHOLD = 18 * 60; // 6:00 PM
      const EARLY_MORNING_CUTOFF = 4 * 60; // 4:00 AM
      
      if (currentMinutesValue >= LATE_NIGHT_THRESHOLD && trainMinutes < EARLY_MORNING_CUTOFF) {
        // This is an overnight train for tonight/tomorrow - add day offset
        trainMinutes += 24 * 60;
      }
      
      return trainMinutes;
    };
    
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

  const memoizedCalculateDuration = useCallback((departureTime: string, arrivalTime: string): number => {
    return calculateDuration(departureTime, arrivalTime);
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
    return direction === 'inbound' 
      ? scheduleData[dayType].inbound 
      : scheduleData[dayType].outbound;
  }, [direction, dayType, scheduleData]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-white">
      <main className="container py-6 md:py-8 max-w-5xl mx-auto px-2 sm:px-4">
        {/* Modern Alerts Display */}
        {activeAlerts.length > 0 && (
          <div className="mb-4 md:mb-6 space-y-2">
            {activeAlerts.map((alert) => {
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
                          onClick={() => setDismissedAlerts(prev => new Set(prev).add(alert.id))}
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
        <div className="mb-4">
          {/* Main Row: Direction + Branding + Time */}
          <div className="flex items-center justify-between gap-2">
            
            {/* Left: Direction Switcher - Matches card style */}
            <button
              onClick={() => setDirection(direction === 'inbound' ? 'outbound' : 'inbound')}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all",
                "border shadow-sm bg-white",
                direction === 'inbound' 
                  ? "border-blue-200 text-blue-700 hover:bg-blue-50" 
                  : "border-amber-200 text-amber-700 hover:bg-amber-50"
              )}
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span className="font-bold">{direction === 'inbound' ? 'Inbound' : 'Outbound'}</span>
              <ArrowRight className="w-3 h-3 opacity-50" />
              <span>{direction === 'inbound' ? 'Chicago' : 'Suburbs'}</span>
            </button>

            {/* Center: Branding - Station Selector */}
            <div className="flex-1 text-center py-1 flex items-center justify-center">
              <StationSelector 
                selectedGtfsId={selectedGtfsId} 
                onStationChange={setSelectedGtfsId} 
              />
            </div>

            {/* Right: Live Sync Status - Matches card style */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-zinc-200 shadow-sm text-zinc-600">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
              </span>
              <span className="text-xs font-medium font-mono">
                {lastUpdate ? (() => {
                  const date = lastUpdate.includes('T') ? new Date(lastUpdate) : new Date(lastUpdate.replace(' ', 'T') + 'Z');
                  return formatChicagoTime(date, { hour: 'numeric', minute: '2-digit' });
                })() : '...'}
              </span>
            </div>
          </div>
        </div>

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
                <div className="flex items-center gap-2">
                  {crowdingLevel && (
                    <span className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-semibold uppercase",
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
            calculateDuration={memoizedCalculateDuration}
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

const ScheduleTable = memo(function ScheduleTable({ 
  trains, 
  formatTime, 
  nextTrainId,
  tripIdMap,
  delays,
  predictedTimes,
  crowdingData,
  estimatedTimes,
  calculateDuration,
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
  calculateDuration: (dep: string, arr: string) => number,
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

  const hasDeparted = (departureTime: string, currentMinutesValue: number): boolean => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    
    // DEBUG: Log the first few calls to understand what's happening
    if (Math.random() < 0.01) { // Log 1% of calls to avoid spam
      console.debug(`[hasDeparted] Checking: ${departureTime} (${depHours}:${depMinutes}) vs current: ${currentMinutesValue} (${Math.floor(currentMinutesValue/60)}:${currentMinutesValue%60})`);
    }
    
    // Service day boundary: 1 AM (60 minutes into the day)
    // Trains with departure times from 24:00-25:59 in GTFS are overnight trains
    const SERVICE_DAY_START = 60; // 1:00 AM
    const LATE_NIGHT_THRESHOLD = 18 * 60; // 6:00 PM - after this, early morning trains are "tomorrow"
    const OVERNIGHT_CUTOFF = 1 * 60; // 1:00 AM - trains before this are "tonight's late" trains
    
    const isBeforeServiceDayStart = currentMinutesValue < SERVICE_DAY_START;
    const isLateNight = currentMinutesValue >= LATE_NIGHT_THRESHOLD; // After 6 PM
    
    // GTFS overnight trains (24:XX, 25:XX) are for "next day"
    if (depHours >= 24) {
      // Normalize to 0-23 range (24:12 -> 0:12)
      const normalizedHours = depHours - 24;
      const normalizedMinutes = normalizedHours * 60 + depMinutes;
      
      // If we are in the early morning (00:00 - 04:00)
      // Then we can compare directly as we are effectively in the "same" extended day
      const EARLY_MORNING_CUTOFF = 4 * 60; // 4:00 AM
      
      if (currentMinutesValue < EARLY_MORNING_CUTOFF) {
        const result = normalizedMinutes < currentMinutesValue;
        if (Math.random() < 0.01) {
          console.debug(`[hasDeparted] Overnight train (${departureTime} -> ${normalizedHours}:${depMinutes}) in early morning: ${result ? 'DEPARTED' : 'UPCOMING'}`);
        }
        return result;
      }
      
      // Otherwise, if we are later in the day (4 AM - 23:59)
      // Any 24:xx train is in the future (tonight/tomorrow morning).
      return false;
    }
    
    const depTotalMinutes = depHours * 60 + depMinutes;
    
    // Before 1 AM: we're still on yesterday's service day
    if (isBeforeServiceDayStart) {
      // If train is between midnight and 1 AM, check if it's passed
      if (depTotalMinutes < SERVICE_DAY_START) {
        const result = depTotalMinutes < currentMinutesValue;
        if (Math.random() < 0.01) {
          console.debug(`[hasDeparted] Before service day start: ${departureTime} (${depTotalMinutes}) vs ${currentMinutesValue}: ${result ? 'DEPARTED' : 'UPCOMING'}`);
        }
        return result;
      }
      // Trains after 1 AM are all departed (from yesterday)
      if (Math.random() < 0.01) {
        console.debug(`[hasDeparted] Before service day start, train after 1 AM (${departureTime}): DEPARTED (yesterday's train)`);
      }
      return true;
    }
    
    // Key fix: When viewing late at night (after 6 PM), early morning trains 
    // (midnight to 1 AM) are TOMORROW's trains, not today's departed trains
    if (isLateNight && depTotalMinutes < OVERNIGHT_CUTOFF) {
      // This is an overnight train for tonight/tomorrow - NOT departed yet
      if (Math.random() < 0.01) {
        console.debug(`[hasDeparted] Late night, early morning train (${departureTime}): UPCOMING (tomorrow's train)`);
      }
      return false;
    }
    
    // Regular comparison: departed if train time is before current time
    const result = depTotalMinutes < currentMinutesValue;
    if (Math.random() < 0.01) {
      console.debug(`[hasDeparted] Regular comparison: ${departureTime} (${depTotalMinutes}) vs ${currentMinutesValue}: ${result ? 'DEPARTED' : 'UPCOMING'}`);
    }
    return result;
  };

  const getMinutesUntilDeparture = (departureTime: string, currentMinutesValue: number): number | null => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    
    // Handle GTFS overnight format (24:XX = tomorrow's AM hours)
    // For 24:12, depTotalMinutes = 24*60 + 12 = 1452
    // At current 23:22 (1402), minutes until = 1452 - 1402 = 50
    const depTotalMinutes = depHours * 60 + depMinutes;
    
    let minutesUntil = depTotalMinutes - currentMinutesValue;
    
    // If negative but within reasonable range, train already departed
    if (minutesUntil < 0 && minutesUntil > -60) {
      return null;
    }
    
    // If very negative, it might mean we need to add a day
    if (minutesUntil < 0) {
      minutesUntil += 24 * 60;
    }
    
    return minutesUntil > 0 && minutesUntil < 1440 ? minutesUntil : null;
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
        {trains.map((train, index) => {
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
