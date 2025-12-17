# Troubleshooting Guide

## Common Issues

### Backend Not Starting

**Error:** `ECONNREFUSED` or proxy errors

**Solution:**
1. Make sure the backend starts before the frontend
2. Check that port 3000 is available: `lsof -i:3000`
3. The backend should show: `✅ Backend server running on http://localhost:3000/`

### Import Errors

**Error:** `The requested module 'gtfs-realtime-bindings' does not provide an export named 'GtfsRealtimeBindings'`

**Solution:** Fixed - use default import: `import GtfsRealtimeBindings from 'gtfs-realtime-bindings'`

### JSON Parsing Errors

**Error:** `Failed to execute 'json' on 'Response': Unexpected end of JSON input`

**Solution:** 
- Frontend now handles API errors gracefully
- Check that backend is running on port 3000
- Check browser console for actual error messages

### Port Conflicts

**Issue:** Frontend can't start on expected port

**Solution:**
- Backend always uses port 3000
- Frontend uses port 5173 (or next available)
- Proxy automatically forwards `/api/*` to backend

## Starting the Servers

### Single Command (Recommended)
```bash
pnpm dev
```

This starts both servers with colored output:
- `[backend]` - Backend server (blue)
- `[frontend]` - Frontend server (green)

### Manual Start
```bash
# Terminal 1 - Backend
pnpm dev:server

# Terminal 2 - Frontend  
pnpm dev:client
```

## Verifying Everything Works

1. **Check Backend:**
   ```bash
   curl http://localhost:3000/api/realtime-status
   ```
   Should return JSON with `last_update` and `auto_refresh_interval`

2. **Check Frontend:**
   Open `http://localhost:5173` (or the port shown in terminal)
   Should see the schedule page with Sync button

3. **Test Sync Button:**
   Click the "Sync" button - it should show "Syncing..." then update the timestamp

## Database Issues

If you see database errors:
1. The server will still start (database is optional for basic functionality)
2. To initialize database: `pnpm exec tsx server/db/gtfs-loader.ts`
3. Database file: `server/db/metra.db`

## Still Having Issues?

1. Check logs in terminal where you ran `pnpm dev`
2. Check browser console (F12) for frontend errors
3. Verify `.env` file has `VITE_METRA_API_TOKEN` set
4. Make sure ports 3000 and 5173 are not blocked by firewall

