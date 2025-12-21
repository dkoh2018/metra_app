
import axios from "axios";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), ".env") });

async function checkAlerts() {
    const token = process.env.VITE_METRA_API_TOKEN;
    if (!token) {
        console.error("❌ VITE_METRA_API_TOKEN is missing in .env");
        return;
    }

    const url = "https://gtfspublic.metrarr.com/gtfs/public/alerts";
    console.log(`fetching alerts from ${url}...`);

    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            params: { api_token: token }
        });

        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(response.data));
        const body = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(feed, {
            longs: String,
            enums: String,
            bytes: String,
        });

        const entities = body.entity || [];
        console.log(`Found ${entities.length} total alerts.`);

        const palatineAlerts = entities.filter(entity => {
            if (!entity.alert) return false;
            
            // Check entities (routes/stops)
            const relevantEntity = entity.alert.informedEntity?.some(ie => {
                // UP-NW Line
                if (ie.routeId === "UP-NW") return true;
                // Palatine Stop ID (checking known IDs or name)
                if (ie.stopId && ie.stopId.includes("PALATINE")) return true;
                return false;
            });

            // Check text content
            const relevantText = entity.alert.headerText?.translation?.some(t => 
                t.text && (t.text.toLowerCase().includes("palatine") || t.text.toLowerCase().includes("up-nw"))
            ) || entity.alert.descriptionText?.translation?.some(t => 
                t.text && (t.text.toLowerCase().includes("palatine") || t.text.toLowerCase().includes("up-nw"))
            );

            return relevantEntity || relevantText;
        });

        if (palatineAlerts.length === 0) {
            console.log("✅ No specific service alerts for Palatine or UP-NW line.");
        } else {
            console.log(`⚠️  Found ${palatineAlerts.length} alerts for Palatine/UP-NW:`);
            console.log(JSON.stringify(palatineAlerts, null, 2));
        }

    } catch (error: any) {
        console.error("Error fetching alerts:", error.message);
    }
}

checkAlerts();
