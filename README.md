# TV Navigator (webOS IPTV Player)

An optimized, full-featured IPTV player designed specifically for **LG webOS Smart TVs** (compatible with older webOS 3.x+ versions as well as modern versions).

This app allows you to stream and organize Live TV channels, Movies, and Series from standard IPTV playlists/subscriptions with a TV-friendly user interface.

---

## 🚀 Features

- **Full Content Catalog**:
  - 📺 **Live TV** with category organization and **EPG (Electronic Program Guide)** support.
  - 🎬 **Movies** with browsing and description layouts.
  - 🍿 **Series** with full episode/season navigation.
  - 🔍 **Global Search** across Live, Movies, and Series.
- **Protocol & Codec Support**:
  - Leverages **HLS.js (v0.8.9)** for robust live streaming compatible with old Chromium engines (Chromium 38/webOS 3.x).
  - Integrates **mpegts.js** for high-performance MPEG-TS (.ts) stream playback.
- **Smart TV Usability**:
  - Stands out on large displays with a clean **1920x1080 resolution design**.
  - Optimized keyboard and remote control navigation.
  - Saved playback positions (resume where you left off).
- **Favorites & History**:
  - Quick access to bookmarked channels, films, and series.
  - Watching history panel to track recent activity.
- **Multiple Source Management**:
  - Supports both **Xtream Codes API** (Username/Password portal) and **M3U Playlists**.
  - Built-in multi-source router allowing you to add, edit, and switch between multiple IPTV connections.
  - IndexedDB storage integration for lightning-fast catalog caching.

---

## 🛠️ Project Structure

```
iptvnator-webos-clean/
├── index.html            # Main Player interface and TV layout shell
├── app.js                # Core application logic, state, stream management & player bindings
├── login.html            # Setup, onboarding, and playlist/portal manager
├── login.js              # Credentials validation, schema handling, and storage initialization
├── style.css             # Remote-friendly TV stylesheet (adapted for 1080p displays)
├── appinfo.json          # webOS Application configuration metadata
├── polyfills.js          # JavaScript compatibility layer for older webOS browsers (Chromium 38)
├── hls.min.js            # Stream playback engine (HLS)
├── mpegts.min.js         # Stream playback engine (MPEG-TS)
├── create_ipk.js         # Custom Node.js bundler (packages .ipk without the webOS SDK)
├── create_ipk.py         # Custom Python bundler (alternative to JS bundler)
├── generate_icons.js     # Script to generate standard TV icons
├── build.bat             # One-click builder script for Windows
├── build.sh              # One-click builder script for macOS/Linux
└── build/                # Output folder for compiled IPK binaries
```

---

## 📦 How to Build the App

The project contains automated build chains for **Windows**, **macOS**, and **Linux**. The build pipeline:

1. Automatically generates icons (`icon.png`, `largeIcon.png`).
2. Checks/downloads HLS player assets compatible with your webOS version.
3. Packages everything into an installable `.ipk` application.

### Prerequisites

You need one of the following setups installed on your computer:

- **(Recommended)** Node.js: To run icon generator and build tools.
- **(Recommended for TV install)** LG webOS CLI: `npm install -g @webos-tools/cli` (provides `ares-package`).
- **(Alternative)** Python 3.x.

### Build Steps

#### **For Windows (CMD/PowerShell)**

Run:

```cmd
build.bat
```

#### **For macOS & Linux**

Run:

```bash
chmod +x build.sh
./build.sh
```

---

## 📺 Installation on LG webOS TVs

### Method 1: Installing via webOS SDK (ares-cli)

If you have the webOS CLI tools installed:

1. **Enable Developer Mode** on your LG TV:
   - Go to **LG Content Store** on your TV and search for `Developer Mode`.
   - Install the Developer Mode app, open it, and log in with your LG Developer Account.
   - Switch **Dev Mode Status** to `ON` and **Key Server** to `ON`.
   - _Note the IP address and Passphrase shown._
2. **Connect your computer to the TV**:
   ```bash
   ares-setup-device
   ```
   Add a new device (e.g., `tv`) and enter the IP address and Passphrase from the TV.
3. **Install the IPK**:
   ```bash
   ares-install --device tv build/com.tvnavigator.webos_*.ipk
   ```

### Method 2: Sideloading

You can sideload the generated `.ipk` package using community webOS managers like the **Homebrew Channel** (if rooted) or DevMode manager applications.

---

## 🔧 Technical Details & Old webOS 3.x Support

- **Chromium 38 Compatibility**:
  Older LG Smart TVs run webOS 3.x, which is built on Chromium 38. This browser engine has strict JS syntax limits.
- **Auto ES5 Syntax Cleaning**:
  The custom Node bundler (`create_ipk.js`) contains an auto-strip routine that automatically cleans trailing commas (e.g., `[a, b,]` or `func(a, b,)`) from JS files before compiling, which would otherwise trigger a `SyntaxError` on Chromium 38.
- **Offline / Local Hosting**:
  The player runs entirely client-side. The database operations use browser `localStorage` and `IndexedDB` caching mechanisms, making stream fetching incredibly efficient without stressing your IPTV server.

---

## 📄 License

This project is for personal streaming and educational use. Ensure you own or have permission to play the streams and playlists used inside the application.
