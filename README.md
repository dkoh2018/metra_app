# 🚂 Metra Schedule Tracker

A real-time Metra train schedule tracker for the **Palatine Station** on the Union Pacific Northwest (UP-NW) line.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

## ✨ Features

- 📅 **Live Schedule** – View weekday, Saturday, and Sunday schedules with automatic day detection
- 🚂 **Real-Time Updates** – Live train positions and delay information from Metra API
- 🗺️ **Interactive Map** – See trains moving along the UP-NW line in real-time
- 👥 **Crowding Indicators** – Color-coded dots showing expected train capacity
- ⚡ **Express Detection** – Express trains highlighted with blue row background
- 📱 **Mobile Responsive** – Optimized for both desktop and mobile devices
- 🔄 **Auto-Refresh** – Automatic updates every 30 seconds, synced to wall clock

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- pnpm (recommended) or npm

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/metra-schedule-tracker.git
cd metra-schedule-tracker

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your Metra API token
```

### Development

```bash
# Run both backend and frontend together
pnpm dev
```

This starts:
- **Backend API** on `http://localhost:3001`
- **Frontend** on `http://localhost:3000`

### Production Build

```bash
pnpm build
pnpm start
```

## 🔧 Configuration

Create a `.env` file in the root directory:

```env
# Required: Get your token from Metra's GTFS portal
VITE_METRA_API_TOKEN=your_api_token_here

# Optional
PORT=3001
```

> ⚠️ **Note**: You need a Metra API token for real-time data. [Request one here](https://metra.com/developers).

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/schedule` | GET | Get all schedules (weekday/saturday/sunday) |
| `/api/schedule/:dayType` | GET | Get schedule for specific day |
| `/api/positions/upnw` | GET | Get live train positions |
| `/api/delays` | GET | Get current real-time delays |
| `/api/crowding` | GET | Get crowding data for trains |
| `/api/trip-schedule/:tripId` | GET | Get stops for a specific trip |
| `/api/shapes/upnw` | GET | Get rail line geometry |

## 🗂️ Project Structure

```
metra-schedule-tracker/
├── client/                 # React + Vite frontend
│   ├── src/
│   │   ├── components/    # Reusable components
│   │   ├── pages/         # Page components
│   │   └── lib/           # Utilities and helpers
├── server/                 # Express.js backend
│   ├── db/                # SQLite database & schema
│   ├── gtfs/              # GTFS static data files
│   └── index.ts           # Main server entry
├── shared/                 # Shared constants
└── scripts/               # Utility scripts
```

## 🗄️ Database

Uses **SQLite** for local data storage:
- Static GTFS schedule data (auto-updates weekly on Mondays)
- Real-time trip updates and delays
- Crowding information cache

Database file: `server/db/metra.db` (auto-created on first run)

## 📜 Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run full stack in development |
| `pnpm dev:client` | Run frontend only |
| `pnpm dev:server` | Run backend only |
| `pnpm build` | Build for production |
| `pnpm start` | Run production server |

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Built with ❤️ for Palatine commuters
