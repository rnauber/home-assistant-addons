# Puppet Add-On - Developer Documentation

## Overview

Puppet is a Home Assistant add-on that provides screenshot capabilities for Home Assistant dashboards using Puppeteer (headless Chrome). It features a web-based UI for configuring and previewing screenshots, with support for URL-based configuration sharing and preset management.

## Architecture

### Components

```
puppet/
├── config.yaml              # Add-on configuration schema
├── Dockerfile              # Container definition
├── ha-puppet/              # Main application
│   ├── http.js            # Server bootstrap (RequestHandler wiring)
│   ├── request-handler.js # HTTP request handling & screenshot cache
│   ├── cache.js           # In-memory screenshot cache (LRU, byte-bounded)
│   ├── screenshot.js      # Browser automation, dithering & screenshot logic
│   ├── ui.js              # Web UI server-side rendering
│   ├── bmp.js             # BMP image encoding (1/8/24-bit)
│   ├── devices.js         # Device preset lookup (devices.json)
│   ├── devices.json       # Predefined device configurations + aliases
│   ├── error.js           # Custom error classes
│   ├── const.js           # Configuration constants
│   ├── test_bmp.mjs       # BMP encoder tests (node test_bmp.mjs)
│   └── html/
│       ├── index.html     # Interactive Web UI
│       ├── tailwind.css   # Static Tailwind build (npm run build:css)
│       ├── error_missing_config.html
│       └── error_connection_failed.html
```

### Technology Stack

**Backend:**
- Node.js
- Puppeteer - Headless Chrome automation (system Chromium in the add-on)
- home-assistant-js-websocket - HA WebSocket communication
- Sharp - Image processing
- (versions: see `ha-puppet/package.json`)

**Frontend:**
- Vanilla JavaScript (no frameworks)
- Tailwind CSS (static build vendored at `html/tailwind.css`, served at `/tailwind.css`; regenerate with `npm run build:css` after changing HTML)
- localStorage for state persistence

## Core Functionality

### 1. HTTP Server (`http.js`)

**RequestHandler Class (`request-handler.js`):**
- `http.js` boots the server on port 10000 and delegates every request to it
- Routes `/` to UI handler
- Routes all other paths to screenshot handler
- Implements request queuing (prevents concurrent requests)
- Manages browser lifecycle with 30-second cleanup timeout
- `fromcacheifyounger` parameter: serves cached screenshots before the queue
  when a fresh-enough render exists (see Screenshot Cache below)

**Key Methods:**
- `start()` - Initialize HTTP server
- `handleRequest()` - Route requests
- `handleScreenshotRequest()` - Process screenshot requests
- `scheduleBrowserCleanup()` - Cleanup idle browser

### 2. Browser Automation (`screenshot.js`)

**Browser Class:**
Manages Puppeteer browser instance and screenshot generation.

**State Management:**
```javascript
{
  lastRequestedPath,    // Cached page path
  lastRequestedLang,    // Last language setting
  lastRequestedTheme,   // Last theme setting
  lastRequestedDarkMode,// Last dark mode state
  browser,              // Puppeteer Browser instance
  page,                 // Puppeteer Page instance
  busy                  // Is browser currently busy
}
```

**Key Methods:**

`navigatePage(path, lang, theme, darkMode)`
- Initializes browser on first request
- Sets viewport size (adds 56px for header)
- Injects HA authentication tokens into localStorage
- Navigates to requested page
- Waits for page loading
- Applies theme, language, dark mode settings
- Dismisses notifications
- Returns navigation timing

`screenshotPage(viewport, options)`
- Takes Puppeteer screenshot with clipping (removes 56px header, scaled by zoom)
- Fast path: plain PNG without rotate/invert/colors is returned as-is (no Sharp re-encode)
- Otherwise processes image with Sharp:
  - Rotation (90°, 180°, 270°)
  - Palette reduction with optional error-diffusion dithering (`colors`, `palette_colors`, `dithering`)
  - Color inversion
  - Format conversion (PNG, JPEG, WebP, BMP — BMP as 24-bit color, 8-bit grayscale, or 1-bit binary via `bmp_mode`)
- Returns image buffer

### 3. Web UI (`ui.js`)

**handleUIRequest(request, response)**
- Fetches HA data via WebSocket and REST API:
  - Available themes (`frontend/get_themes`)
  - Network URLs (`network/url`)
  - System config (`/api/config`)
- Renders `index.html` with injected data as `window.hass`
- Shows error pages for missing config or connection failures

### 4. Interactive Frontend (`html/index.html`)

**Features:**
- Form-based configuration panel
- Live screenshot preview
- URL generation and copying
- **URL parameter syncing** - All settings reflected in browser URL
- **Preset management** - Save/load/delete named configurations
- Attribution footer with GitHub link

**Form Parameters:**

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| device | string | Predefined device preset from devices.json | (empty) |
| path | string | HA page path | `/` |
| width | number | Viewport width (100-4000px) | 1000 |
| height | number/`auto` | Viewport height (100-4000px), or `auto` for full page height | 1000 |
| format | string | Output format (png, jpeg, webp, bmp) | `png` |
| bmp_mode | string | BMP encoding (color, grayscale, binary) | `color` |
| theme | string | HA theme name | (empty) |
| dark | boolean | Enable dark mode | false |
| zoom | number | Zoom level | 1.0 |
| wait | number | Extra wait time in ms | 0 |
| lang | string | Language code (e.g., en, nl) | (empty) |
| colors | string | Comma-separated hex output palette (e.g. 000000,FFFFFF) | (empty) |
| palette_colors | string | Quantization palette matched before mapping to `colors` | (empty) |
| dithering | string | Dithering algorithm (none, floyd-steinberg, atkinson, jarvis-judice-ninke, stucki, burkes, sierra, sierra-lite) | `none` |
| rotate | number | Rotation degrees (90, 180, 270) | (empty) |
| invert | boolean | Invert colors | false |
| next | number | Auto-refresh interval in seconds | (empty) |
| fromcacheifyounger | number/`always` | Serve cached screenshot if younger than N seconds | (empty) |

**JavaScript Functions:**

*Settings Management:*
- `saveSettings()` - Persist current form to localStorage
- `loadSettings()` - Load settings from localStorage
- `loadFromUrl()` - Parse URL parameters and populate form
- `updateBrowserUrl()` - Update browser URL to match current form

*Preset Management:*
- `getCurrentSettings()` - Get current form values as object
- `applySettings(settings)` - Apply settings object to form
- `savePreset()` - Save current settings as named preset
- `getPresets()` - Retrieve all presets from localStorage
- `loadPreset(name)` - Apply saved preset
- `deletePreset(name)` - Remove preset from storage
- `renderPresets()` - Render preset list UI

*Screenshot Operations:*
- `buildUrl()` - Generate screenshot URL with parameters
- `updateUrl()` - Update displayed URL field
- `loadPreview()` - Fetch and display screenshot
- `copyUrl()` - Copy URL to clipboard

**Storage Keys:**
- `puppetSettings` - Last used form settings (JSON)
- `puppetPresets` - Named preset configurations (JSON object)

## Request Flow

### Screenshot Request

```
1. HTTP Request → http.js
   ↓
2. Parameters parsed (no browser access); fromcacheifyounger cache hit →
   instant response without queueing
   ↓
3. Request queued if browser busy
   ↓
4. Browser.navigatePage(path, lang, theme, darkMode)
   - Initialize browser if needed
   - Set viewport
   - Inject auth tokens
   - Navigate to page
   - Apply settings
   ↓
5. Browser.screenshotPage(viewport, options)
   - Capture screenshot
   - Process image (rotate, e-ink, invert)
   - Encode format
   ↓
5. Return image buffer (stored in cache for fromcacheifyounger keys)
   ↓
6. HTTP Response (image/png, image/jpeg, etc.)
   ↓
7. Schedule "next" request if specified
   ↓
8. Schedule browser cleanup (30s timeout)
```

### UI Request

```
1. HTTP GET / → http.js
   ↓
2. ui.handleUIRequest()
   - Connect to HA WebSocket
   - Fetch themes
   - Fetch network URLs
   - Fetch system config
   ↓
3. Render index.html with window.hass data
   ↓
4. Client-side JavaScript:
   - Load settings from URL params (priority)
   - Load settings from localStorage (fallback)
   - Populate theme picker
   - Render preset list
   - Update URLs
   - Load preview
```

## Performance Optimizations

1. **Browser Reuse**: Keeps browser open for 30s between requests
2. **Page Caching**: Reuses page if same path requested consecutively
3. **Request Queuing**: Prevents concurrent browser operations
4. **Navigation Optimization**: Uses `history.replaceState` + custom event vs full reload
5. **Preloading**: `next` parameter warms up browser before fetch
6. **Screenshot Cache**: `fromcacheifyounger` serves prior renders for identical parameters before joining the request queue (see Screenshot Cache)
7. **PNG Fast Path**: Plain PNG requests (no rotate/invert/colors) skip the Sharp re-encode
8. **Dithering Cache**: Palette lookups are memoized per image
9. **Custom Wait Times**:
   - 750ms default (add-on)
   - 500ms for local dev
   - +2s extra on cold start for icons/images

## Authentication

Uses Home Assistant long-lived access tokens:
- Configured in add-on options (`/data/options.json`)
- Injected into Puppeteer browser's localStorage
- Token format: `hassTokens` key with JSON object

## E-ink Display Support

**Color Reduction:**
- Custom palette via `colors` (comma-separated hex), optionally with `palette_colors` for quantization matching and `dithering` for error-diffusion algorithms
- Legacy `eink` parameter: `eink=2` is auto-converted to `colors=000000,FFFFFF`; any other value returns HTTP 400
- Device presets in `devices.json` bundle width/height/colors/palette_colors/dithering (selected with `device=<name>`, aliases supported)
- Custom BMP encoder (`bmp.js`) for 1-bit, 8-bit grayscale, and 24-bit formats (`bmp_mode`)

**Recommended Settings:**
```
?viewport=800x600&colors=000000,FFFFFF&dithering=atkinson&invert&format=bmp
```

## API Endpoints

### GET /
Returns interactive Web UI

### GET /{path}?{params}
Returns screenshot of Home Assistant page

**Query Parameters:**
- `viewport={width}x{height}` (required unless `device` given; height may be `auto`; dimensions clamped to 10-4000)
- `device={name}` (optional, preset from devices.json supplying viewport/colors/palette_colors/dithering defaults)
- `format={png|jpeg|webp|bmp}` (optional, default: png)
- `bmp_mode={color|grayscale|binary}` (optional, default: color)
- `theme={theme_name}` (optional)
- `dark` (optional, flag)
- `zoom={number}` (optional, max 10)
- `wait={milliseconds}` (optional)
- `lang={code}` (optional)
- `colors={hex,hex,...}` (optional, output palette; enables dithering pipeline)
- `palette_colors={hex,hex,...}` (optional, quantization palette; must match `colors` length)
- `dithering={algorithm}` (optional, default: none)
- `rotate={degrees}` (optional, 90/180/270)
- `invert` (optional, flag)
- `next={seconds}` (optional, preload interval)
- `fromcacheifyounger={seconds|always}` (optional, serve cached screenshot if rendered within the last N seconds, or `always` for any prior render)
- `eink` (deprecated: `eink=2` converted to black/white `colors`; other values return 400)

**Example:**
```
GET /home?viewport=1000x600&format=png&theme=midnight&dark&zoom=1.2
```

### GET /tailwind.css
Static Tailwind CSS build used by the UI and error pages

## Screenshot Cache (`cache.js`)

Backs the `fromcacheifyounger` URL parameter:

- Entries keyed by `JSON.stringify(requestParams)` — the full set of
  image-shaping parameters. Two requests with identical parameters share an
  entry; any parameter change (path, viewport, format, theme, colors, ...)
  misses.
- Only requests that opt in via `fromcacheifyounger` store screenshots, so
  plain traffic never uses cache memory.
- Byte-bounded LRU (64 MB) instead of a count cap: a single 4000x4000 24-bit
  BMP is ~48 MB, so entry counts would not bound memory meaningfully.
- `fromcacheifyounger={seconds}` serves an entry while
  `now - createdAt <= seconds * 1000`; `always` skips the age check. An expired
  entry is replaced by a fresh render, not evicted.
- Cache hits are answered before the busy queue, so a cached response is
  instant even while another render is in flight. A second re-check after
  acquiring the browser lock serves the render a queued request just waited
  for.
- Combined with `next`, the cache self-refreshes: the pre-warm
  (`prepareNextRequest`) renders a fresh screenshot and replaces the entry,
  every cached serve re-arms the timer, and the pre-warm navigates with
  `forceReload: true` (`Browser.navigatePage` option) so the capture reflects
  the dashboard's current state rather than the DOM left by the last render.

## Error Handling

**Error Pages:**
- Missing config → Shows setup instructions
- Connection failed → Shows troubleshooting guide
- Cannot open page → Returns HTTP 404 with error message

**Browser Crashes:**
- Watchdog restart recommended in add-on options
- Browser automatically recreated on next request

## Configuration Options

**Add-on Configuration (`config.yaml`):**

```yaml
access_token: "long_lived_token_here"
keep_browser_open: false  # Keep browser alive between requests
home_assistant_url: "http://homeassistant:8123"  # HA base URL
```

## Development

**Local Development:**
1. Copy `options-dev.json.sample` to `options-dev.json`
2. Add your access token
3. Run: `npm install && node http.js`
4. Access UI: `http://localhost:10000/`

**Tests:**
- BMP encoder: `node test_bmp.mjs` (assertion-based; also writes sample .bmp files)
- Shutdown handlers: `node --test test_shutdown.mjs`
- Request handler & screenshot cache: `node --test test_request_handler.mjs`

**After changing HTML/Tailwind classes:**
- Regenerate the static CSS: `npm run build:css`

## Security Considerations

⚠️ **NO SECURITY** - This is a prototype with no authentication:
- Anyone with network access can make screenshots
- No rate limiting
- Access token stored in config
- Should only run on trusted networks

## Future Enhancements

Potential improvements:
- [ ] Authentication layer
- [ ] Rate limiting
- [x] Screenshot caching (done via `fromcacheifyounger`)
- [ ] Multiple browser instances for concurrency
- [ ] WebSocket support for real-time updates
- [ ] Export/import preset functionality
- [ ] Cloud storage integration for presets
- [ ] Mobile-responsive UI improvements

## Troubleshooting

**Browser fails to launch:**
- Enable watchdog in add-on options
- Check system resources (memory/CPU)
- Review add-on logs

**Screenshots are blank:**
- Increase `wait` parameter
- Check access token validity
- Verify path exists in HA

**Theme not applied:**
- Verify theme name matches HA theme
- Check theme is installed in HA
- Try with `dark` flag

**Performance issues:**
- Enable `keep_browser_open`
- Reduce viewport size
- Decrease `next` interval
- Check network latency

## References

- [Puppeteer Documentation](https://pptr.dev/)
- [Sharp Documentation](https://sharp.pixelplumbing.com/)
- [Home Assistant Add-on Development](https://developers.home-assistant.io/docs/add-ons/)
- [GitHub Repository](https://github.com/balloob/home-assistant-addons)
