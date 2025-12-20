
import { useState, useEffect, useRef, useMemo } from 'react';
import { Station } from '@/lib/stations';
import { ApiSchedule, ApiAlerts, CrowdingLevel, Direction, DayType, ApiTrain } from '@/types/schedule';
import { transformTrain, TRIP_ID_REGEX } from '@/lib/schedule-helpers';
import { getChicagoTime, getServiceDayType, getCurrentMinutesInChicago } from '@/lib/time';
import { Train } from '@/lib/scheduleData';

type ScheduleDataState = {
  [key: string]: { inbound: Train[]; outbound: Train[] };
};

export function useScheduleData(
  selectedGtfsId: string, 
  selectedStation: Station, 
  direction: Direction
) {
  const [currentTime, setCurrentTime] = useState(getChicagoTime());
  const [dayType, setDayType] = useState<DayType>('weekday');
  
  const [scheduleData, setScheduleData] = useState<ScheduleDataState>({});
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  
  const [alerts, setAlerts] = useState<ApiAlerts[]>([]);
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
  
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const fetchCrowdingRef = useRef<((forceRefresh?: boolean) => void) | null>(null);
  const lastFetchMinuteRef = useRef<number | null>(null);
  const isFetchingCrowdingRef = useRef<boolean>(false);

  // Initialize day type based on current service day
  useEffect(() => {
    const chicagoTime = getChicagoTime();
    const serviceDayType = getServiceDayType(chicagoTime);
    setDayType(serviceDayType);
  }, []);

  // Update current time every 15 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = getChicagoTime();
      setCurrentTime(now);
      
      const chicagoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    
      // Check if we are in the "Late Night" window (00:00 - 03:00)
      // If so, subtract 3 hours to push us back to the "previous day"
      if (chicagoTime.getHours() < 3) {
        chicagoTime.setHours(chicagoTime.getHours() - 3);
      }

      const day = chicagoTime.getDay();
      let type: DayType = 'weekday';
      if (day === 0) type = 'sunday'; // Sunday
      else if (day === 6) type = 'saturday'; // Saturday
      else type = 'weekday';
      
      setDayType(type);
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Memoize currentMinutes
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
    // Check for pre-injected data first (for instant page loads)
    const initialData = (window as any).__INITIAL_DATA__;
    if (initialData?.schedules?.[selectedGtfsId]) {
      console.log('[useScheduleData] Using pre-injected schedule data for', selectedGtfsId);
      const data = initialData.schedules[selectedGtfsId];
      const newTripIdMap = new Map<string, string>();
      
      const transformed: ScheduleDataState = {
        weekday: {
          inbound: (data.weekday?.inbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap)),
          outbound: (data.weekday?.outbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap))
        },
        saturday: {
          inbound: (data.saturday?.inbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap)),
          outbound: (data.saturday?.outbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap))
        },
        sunday: {
          inbound: (data.sunday?.inbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap)),
          outbound: (data.sunday?.outbound || []).map((train: ApiTrain) => transformTrain(train, newTripIdMap))
        }
      };
      setScheduleData(transformed);
      setTripIdMap(newTripIdMap);
      setScheduleLoading(false);
      
      // Clear the used data to prevent stale re-use
      delete initialData.schedules[selectedGtfsId];
      return; // Skip API fetch since we have data
    }
    
    setScheduleLoading(true);
    setScheduleError(null);

    // Clear existing data immediately to prevent "ghosting"
    setScheduleData({});
    setTripIdMap(new Map());
    setEstimatedTimes(new Map());
    
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
          
          // Helper to get next day type
          const getNextServiceDay = (current: DayType): DayType => {
            if (current === 'weekday') return 'saturday';
            if (current === 'saturday') return 'sunday';
            return 'weekday';
          };
          
          // Helper to append Sentinel Train
          const appendSentinel = (trains: Train[], nextDayTrains: Train[] | undefined): Train[] => {
            const nextFirstTrain = nextDayTrains && nextDayTrains.length > 0 ? nextDayTrains[0] : null;
            
            // Create Sentinel
            const sentinel: Train = {
              id: 'SENTINEL_END',
              // Use "27:00" (3 AM) as base, but display will use nextFirstTrain info
              departureTime: '27:00', 
              arrivalTime: '28:00',
              isExpress: false,
              // Store next day info in custom properties (we'll need to extend generic Train type or just use standard props)
              // Actually, let's just use standard props but we know it's SENTINEL via ID.
              // We will hijack the departureTime to store the "Next First Train Departure" for display?
              // No, better to keep 27:00 so it sorts to the end.
              // We'll attach the REAL next times as hidden props or assume UI finds them?
              // Let's just use the PROPER times of the next train, but add +24h to them relative to NOW?
              // Or simpler: Just store the string.
              _nextDayDeparture: nextFirstTrain?.departureTime,
              _nextDayArrival: nextFirstTrain?.arrivalTime
            } as Train & { _nextDayDeparture?: string, _nextDayArrival?: string };
            
            return [...trains, sentinel];
          };

          const transformed: ScheduleDataState = {
            weekday: {
              inbound: appendSentinel(
                (data.weekday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.saturday?.inbound || []).map(train => transformTrain(train, newTripIdMap)) // Approx next day
              ),
              outbound: appendSentinel(
                (data.weekday?.outbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.saturday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
              )
            },
            saturday: {
              inbound: appendSentinel(
                (data.saturday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.sunday?.inbound || []).map(train => transformTrain(train, newTripIdMap))
              ),
              outbound: appendSentinel(
                (data.saturday?.outbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.sunday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
              )
            },
            sunday: {
              inbound: appendSentinel(
                (data.sunday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.weekday?.inbound || []).map(train => transformTrain(train, newTripIdMap))
              ),
              outbound: appendSentinel(
                (data.sunday?.outbound || []).map(train => transformTrain(train, newTripIdMap)),
                (data.weekday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
              )
            }
          };
          setScheduleData(transformed);
          setTripIdMap(newTripIdMap);
        } else {
          try {
             import('@/lib/scheduleData').then(mod => {
                 setScheduleData(mod.scheduleData as unknown as ScheduleDataState);
             });
          } catch (e) {
             console.error("Fallback load failed", e);
          }
        }
        setScheduleLoading(false);
      })
      .catch(error => {
        setScheduleLoading(false);
      });
  }, [selectedGtfsId, selectedStation.terminal]); 

  // Fetch alerts from Metra API
  useEffect(() => {
    fetch('/api/alerts')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  }, [direction, selectedGtfsId, selectedStation.terminal]);

  // Fetch crowding data
  useEffect(() => {
    // Check for pre-injected crowding data first (for instant page loads)
    const terminalId = selectedStation.terminal || 'OTC';
    const lineId = selectedStation.line || 'UP-NW';
    const cacheKey = `${selectedGtfsId}_${terminalId}_${lineId}`;
    const initialData = (window as any).__INITIAL_DATA__;
    
    if (initialData?.crowding?.[cacheKey]) {
      console.log('[useScheduleData] Using pre-injected crowding data for', cacheKey);
      const crowdingArray = initialData.crowding[cacheKey];
      const newCrowdingData = new Map<string, CrowdingLevel>();
      const newEstimatedTimes = new Map<string, {
        scheduled_departure: string | null;
        predicted_departure: string | null;
        scheduled_arrival: string | null;
        predicted_arrival: string | null;
      }>();
      
      crowdingArray.forEach((item: any) => {
        if (item.crowding) {
          newCrowdingData.set(item.trip_id, item.crowding as CrowdingLevel);
          // Also map by train number for easier lookup
          const trainMatch = item.trip_id.match(TRIP_ID_REGEX);
          if (trainMatch) {
            newCrowdingData.set(trainMatch[1], item.crowding as CrowdingLevel);
          }
        }
        if (item.scheduled_departure || item.predicted_departure || item.scheduled_arrival || item.predicted_arrival) {
          newEstimatedTimes.set(item.trip_id, {
            scheduled_departure: item.scheduled_departure,
            predicted_departure: item.predicted_departure,
            scheduled_arrival: item.scheduled_arrival,
            predicted_arrival: item.predicted_arrival
          });
          // Also map by train number
          const trainMatch = item.trip_id.match(TRIP_ID_REGEX);
          if (trainMatch) {
            newEstimatedTimes.set(trainMatch[1], {
              scheduled_departure: item.scheduled_departure,
              predicted_departure: item.predicted_departure,
              scheduled_arrival: item.scheduled_arrival,
              predicted_arrival: item.predicted_arrival
            });
          }
        }
      });
      
      setCrowdingData(newCrowdingData);
      setEstimatedTimes(newEstimatedTimes);
      
      // Clear used data
      delete initialData.crowding[cacheKey];
    }
    
    const reloadFromStorage = () => {
      try {
        const saved = localStorage.getItem(`crowding_${selectedGtfsId}`);
        if (saved) {
          const parsed = JSON.parse(saved) as Record<string, CrowdingLevel>;
          const loaded = new Map(Object.entries(parsed));
          setCrowdingData(loaded);
        }
      } catch (error) {
        // ignore
      }
    };

    const fetchCrowding = (forceRefresh = false) => {
      if (isFetchingCrowdingRef.current && !forceRefresh) return;
      
      const currentMin = Math.floor(Date.now() / 60000);
      if (!forceRefresh && lastFetchMinuteRef.current === currentMin) return;
      
      lastFetchMinuteRef.current = currentMin;
      isFetchingCrowdingRef.current = true;
      setRefreshError(null);

      const terminalId = selectedStation.terminal || 'OTC';
      const origin = direction === 'inbound' ? selectedGtfsId : terminalId;
      const dest = direction === 'inbound' ? terminalId : selectedGtfsId;
      
      const params = new URLSearchParams({
        origin,
        destination: dest,
        line: selectedStation.line || 'UP-NW'
      });
      
      if (forceRefresh) params.append('force', 'true');
      
      console.log(`🔄 [CROWDING FETCH] Request:`, { origin, dest, line: selectedStation.line, force: forceRefresh });
      
      fetch(`/api/crowding?${params.toString()}`)
        .then(res => {
           if (!res.ok) {
             if (res.status === 429) throw new Error("Rate limit exceeded");
             throw new Error(`HTTP ${res.status}`);
           }
           return res.json();
        })
        .then((response: any) => {
          console.log(`✅ [CROWDING FETCH] Response received:`, { 
            dataLength: response.crowding?.length || 0, 
            firstItems: response.crowding?.slice(0, 3) 
          });
          
          if (response.error) throw new Error(response.error);
          
          const data = response.crowding;
          if (!Array.isArray(data)) {
             console.warn("⚠️ [CROWDING FETCH] Invalid crowding list received:", response);
             return; 
          }
          
          const newCrowdingMap = new Map<string, CrowdingLevel>();
          const newEstimatedTimes = new Map<string, any>();
          
          data.forEach(item => {
             const tripIdMatch = item.trip_id?.match(TRIP_ID_REGEX);
             const trainId = tripIdMatch ? tripIdMatch[1] : null;
             
             if (item.crowding) {
                newCrowdingMap.set(item.trip_id, item.crowding.toLowerCase() as CrowdingLevel);
                if (trainId) {
                  newCrowdingMap.set(trainId, item.crowding.toLowerCase() as CrowdingLevel);
                }
             }

             if (trainId) {
               newEstimatedTimes.set(trainId, {
                 scheduled_departure: item.scheduled_departure,
                 predicted_departure: item.predicted_departure,
                 scheduled_arrival: item.scheduled_arrival,
                 predicted_arrival: item.predicted_arrival
               });
             }
          });
          
          console.log(`💾 [CROWDING FETCH] Processing ${data.length} items...`);
          
          setCrowdingData(prev => {
             const next = new Map(prev);
             newCrowdingMap.forEach((v, k) => next.set(k, v));
             
             console.log(`📋 [CROWDING FETCH] Updated crowding map:`, {
               totalEntries: next.size,
               sample: Array.from(next.entries()).slice(0, 5)
             });
             
             // Save to localStorage
             try {
                const obj = Object.fromEntries(next);
                localStorage.setItem(`crowding_${selectedGtfsId}`, JSON.stringify(obj));
             } catch (e) {}
             return next;
          });
          
          setEstimatedTimes(prev => {
            const next = new Map(prev);
            newEstimatedTimes.forEach((v, k) => next.set(k, v));
            return next;
          });
        })
        .catch(err => {
          setRefreshError(err.message);
        })
        .finally(() => {
          isFetchingCrowdingRef.current = false;
        });
    };

    fetchCrowdingRef.current = fetchCrowding;
    reloadFromStorage();
    fetchCrowding();
    
    // Poll every minute
    const interval = setInterval(() => fetchCrowding(), 60000);
    return () => clearInterval(interval);

  }, [direction, selectedGtfsId, selectedStation.line, selectedStation.terminal]);

  // Handle manual refresh
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAll = async () => {
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
  };

  const manualRefresh = () => {
    if (fetchCrowdingRef.current) {
      fetchCrowdingRef.current(true);
    }
  };

  return {
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
    refreshAll,
    manualRefresh
  };
}
