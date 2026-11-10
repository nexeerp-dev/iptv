# Zapply — free live TV from around the world

A fast, good-looking IPTV player that runs in any browser. It ships with
**9,600+ free channels from 170+ countries**, and **7,000+ of them were checked
and play in the browser** when the list was built.

All channels come from the community-maintained
[iptv-org](https://github.com/iptv-org/iptv) database, which only lists streams
that broadcasters make publicly available. Zapply hosts no video itself.

## Features

- **Browse** by country (with flags), by category (news, sports, movies, kids, music…) or by language
- **Instant search** across names, countries, languages and categories
- **Verified streams**: every stream was checked; by default only working ones are shown
- **Automatic fallback**: channels with several sources switch to the next one if one fails, and a dead channel skips to the next after 5 seconds
- **Favorites** and **recently watched**, saved in your browser
- **Channel surfing**: Next / Prev buttons, arrow keys, and a 🎲 random channel button
- **Your own playlists**: add any `.m3u` playlist by link or file, or paste a single `.m3u8` stream link to play it
- **Export** any view (e.g. "Sports" or your favorites) as an `.m3u` to use in VLC, Kodi, TiviMate, etc.
- **Mini player** (picture-in-picture), fullscreen, shareable links to a channel
- **Update in-app** from the live database, no redeploy needed
- Light and dark themes, works on phones, installable as an app

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Search |
| `↑` `↓` / `PgUp` `PgDn` | Channel up / down |
| `Space` | Play / pause |
| `F` | Fullscreen |
| `M` | Mute |
| `R` | Random channel |
| `S` | Add to favorites |
| `P` | Picture-in-picture |
| `Esc` | Close the player |

## Android app

Download **[Zapply.apk](https://nexeerp-dev.github.io/iptv/download/Zapply.apk)** on your phone and open it to install
(Android 8 or newer; allow "Install unknown apps" for your browser when asked).

The app plays more channels than the website: it fetches streams itself, so
stations whose servers block web players, and plain `http://` streams, work too.
It also has native fullscreen with auto-rotate, a floating mini player when you
leave the app, share to other apps, "Open in another player" (VLC, MX Player),
TV remote channel buttons, and it picks up the weekly channel list from the
website automatically.

### On a TV (Android TV, Google TV, Fire TV)

The same APK works on Android-based TVs and boxes and switches to a TV layout
made for the remote control.

To install: on the TV, install the free **Downloader** app, open
`https://nexeerp-dev.github.io/iptv/download/Zapply.apk`, and allow installing
from unknown sources when asked. Zapply then appears in the TV's app row.

| Remote button | While browsing | While watching |
| --- | --- | --- |
| Arrows | Move the highlight | ▲▼ change channel, ◀▶ open the channel list |
| OK | Open / play | Show channel info |
| Back | Go back | Return to browsing |
| 0–9 | | Jump to channel number |
| Channel +/− | Change channel | Change channel |
| Play/Pause | | Pause or resume |
| Mic / Search | Voice search | Voice search |
| Guide | | Channel list |
| Menu | Settings | Settings |

Samsung (Tizen) and LG (webOS) TVs cannot install APKs; the website may work in
their built-in browser, and adding `?tv=1` to the address turns on the TV layout.

### Building the APK

Needs JDK 17+ and the Android SDK (platform 35).

```bash
cd android
./gradlew assembleRelease     # app/build/outputs/apk/release/
```

Without `android/keystore.properties` the release APK is unsigned; use
`./gradlew assembleDebug` for a quick installable build. To sign with your own
key, create `android/keystore.properties` (never commit it):

```
storeFile=/path/to/worldtv-release.jks
storePassword=...
keyAlias=worldtv
keyPassword=...
```

Updates to an installed app must be signed with the same key.

## Run it

It's a static site with no build step. It must be opened through a web server
(not by double-clicking `index.html`):

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

### Publish it free on GitHub Pages

1. Merge this into `main`.
2. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The `Deploy to GitHub Pages` workflow publishes the site at `https://<user>.github.io/<repo>/`.

## Keeping the channel list fresh

The `Update channel list` workflow runs every Monday. It downloads the latest
iptv-org database, checks every stream, rebuilds `data/channels.json`, commits
it, and the site redeploys. You can also run it by hand from the **Actions** tab.

To do the same locally:

```bash
mkdir -p api-cache
for f in streams channels feeds logos countries categories languages blocklist; do
  curl -fsSL -o api-cache/$f.json https://iptv-org.github.io/api/$f.json
done
python3 scripts/probe.py api-cache/streams.json probe.json   # optional, ~10 min
node scripts/build-data.mjs --from api-cache --probe probe.json
```

## What gets filtered out

- Adult channels and channels on iptv-org's blocklist
- Closed channels
- Streams that need a special user-agent or referrer (browsers can't send these)
- Streams that were offline when checked

Shown in the app with a warning instead of hidden:

- **May be region locked**: the server refused the check, which usually means it only serves some countries
- **May not play in browsers**: the stream works, but its server blocks web players; use "Copy stream URL" and open it in VLC

Plain `http://` streams can't play when the site is served over `https://`
(for example on GitHub Pages), so they are hidden there automatically. Run the
app locally over `http://` to use them.

## Project layout

```
index.html              page
css/style.css           styles
js/app.js               the app (browsing, player, favorites, playlists)
js/builder.js           turns the iptv-org database into data/channels.json (used by Node and the browser)
js/m3u.js               M3U import / export
data/channels.json      the bundled channel list
scripts/build-data.mjs  builds data/channels.json
scripts/probe.py        checks which streams work
sw.js                   offline cache for the app itself
android/                Android app (WebView shell + native stream fetching)
download/Zapply.apk    ready-to-install Android app
```

Playback uses [hls.js](https://github.com/video-dev/hls.js) and, for the few
DASH streams, [dash.js](https://github.com/Dash-Industry-Forum/dash.js).

## Notes

Live streams come and go: a channel that worked yesterday may be offline today,
and some are only available in certain countries. That's why the app retries
other sources and skips dead channels automatically.
