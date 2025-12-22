export interface ServerContext {
  getDatabase?: any;
  getAllSchedules?: any;
  getNextTrain?: any;
  shouldUpdateGTFS?: any;
  getAllDelays?: any;
  updateRealtimeData?: any;
  updateWeatherData?: any;
  getAllWeather?: any;
  loadGTFSIntoDatabase?: any;
}

export const context: ServerContext = {};
