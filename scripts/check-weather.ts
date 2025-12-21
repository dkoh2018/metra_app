
import axios from 'axios';

const LOCATIONS = [
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'Palatine', lat: 42.1103, lon: -88.0342 }
];

async function checkWeather() {
  console.log("🌦️  Checking Open-Meteo API...");
  
  for (const loc of LOCATIONS) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current_weather=true&temperature_unit=fahrenheit&windspeed_unit=mph`;
      console.log(`fetching ${loc.name}: ${url}`);
      
      const response = await axios.get(url);
      const data = response.data;
      
      if (data.current_weather) {
         console.log(`✅ ${loc.name}: ${data.current_weather.temperature}°F, Wind: ${data.current_weather.windspeed} mph`);
      } else {
         console.error(`❌ ${loc.name}: No current_weather in response`);
      }
      
    } catch (err: any) {
      console.error(`❌ ${loc.name}: Failed - ${err.message}`);
      if (err.response) {
          console.error(`   Status: ${err.response.status}`);
          console.error(`   Data: ${JSON.stringify(err.response.data)}`);
      }
    }
  }
}

checkWeather();
