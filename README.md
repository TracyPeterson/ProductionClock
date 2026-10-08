# Production Clock

A time-of-day clock and countdown timer rendered in a web page with a fully
transparent background, intended to be keyed over video (OBS / vMix browser
source, or a full-screen browser on an output machine). A separate control
panel page sets the time source, fonts, sizes, colours and positions, and runs
the countdown.

## Install

### Option 1: download the executable (no prerequisites)

1. Go to the [Releases page](https://github.com/TracyPeterson/ProductionClock/releases)
   and download the file for your platform (`ProductionClock-windows-x64.exe`
   for Windows).
2. Put it in a folder of its own and run it. A `settings.json` file is created
   next to it the first time you change a setting.
3. Open http://localhost:3000/control in a browser.

Windows SmartScreen will warn the first time because the file is not
code-signed: click *More info* then *Run anyway*. Also allow it through Windows
Firewall when prompted so other machines on the network can reach the clock
output. On macOS or Linux run `chmod +x` on the file first.

### Option 2: run from source (needs Node.js 18 or newer)

```
git clone https://github.com/TracyPeterson/ProductionClock.git
cd ProductionClock
npm install
npm start
```

`start.cmd` does the same thing for a double-click launch on Windows, and
installs dependencies itself the first time.

### Pages

Once running, open:

| Page          | URL                             |
| ------------- | ------------------------------- |
| Control panel | http://localhost:3000/control   |
| Clock output  | http://localhost:3000/view      |

The server listens on every network interface, so other machines on the LAN can
open the same paths using this PC's IP address. The control panel lists the
LAN URLs. Set the `PORT` environment variable to use a different port.

## Building the executables

Executables are built with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg),
which bundles Node.js, the server and the web pages into one file.

```
npm install
npm run build:win     # dist/production-clock-win-x64.exe
npm run build         # all platforms (Windows, macOS Intel/Apple Silicon, Linux)
```

### Publishing a release

The GitHub Actions workflow in `.github/workflows/release.yml` builds all
platforms and attaches them to a GitHub Release whenever a version tag is
pushed:

```
npm version 1.0.1          # bumps package.json and creates the tag
git push --follow-tags
```

The release appears on the repository's Releases page a few minutes later.

## Time source

* **This PC's clock** – uses the server machine's system time.
* **Internet time (NTP)** – queries an NTP server (default `time.windows.com`)
  directly over UDP port 123 and re-syncs on a schedule. Any NTP host can be
  entered.
* **Set manually** – type a date/time or time of day, use the browser's time,
  or nudge by fractions of a second. The offset from the PC clock is stored so
  it survives a restart.

Every output page syncs to the server's clock over a WebSocket, so multiple
outputs show the same time even if their own clocks differ.

## Clock output

The output page has no background, no chrome and a hidden cursor. The time of
day clock and the countdown are the only elements. Each can be positioned with
X/Y percentages and an anchor (left / centre / right), and styled with font
family, optional Google Font, size (in `vw` so it scales with the output
resolution, or in `px`), weight, colour, outline, shadow and letter spacing.

The countdown can count down a fixed duration (Start / Pause / Reset) or count
down to a specific date and time. It changes colour under a warning threshold,
changes colour again at zero, optionally flashes, and can either hold at zero
or keep counting negative.

## Files

* `server.js` – Express + WebSocket server, NTP client, settings storage.
* `public/view.html` – transparent output page.
* `public/control.html` – control panel.
* `settings.json` – created automatically; holds the current settings.

## HTTP API

The control panel uses these; they can also be driven from a stream deck or
automation tool.

| Method | Path                                  | Body / notes                                   |
| ------ | ------------------------------------- | ---------------------------------------------- |
| GET    | `/api/settings`                       | current settings                               |
| PATCH  | `/api/settings`                       | partial settings object, deep-merged           |
| POST   | `/api/settings/reset`                 | restore defaults                               |
| GET    | `/api/status`                         | time source status, server time, LAN addresses |
| POST   | `/api/time/sync`                      | switch to NTP and sync now                     |
| POST   | `/api/time/set`                       | `{ "epochMs": … }` or `{ "time": "HH:MM:SS" }` |
| POST   | `/api/time/nudge`                     | `{ "deltaMs": 100 }`                           |
| POST   | `/api/countdown/start`                |                                                |
| POST   | `/api/countdown/pause`                |                                                |
| POST   | `/api/countdown/reset`                |                                                |
| POST   | `/api/countdown/toggle`               | show / hide the countdown                      |

## License

GPL-3.0. See `LICENSE`.
