// Wave-chart viewer for /charts.html.
//
// Data chain (every link resolved relative to the document that names it):
//   models.json → model.catalog → region.manifest → frame.path (PNG)
// JSON is read through the same-origin proxy (the backend sends no CORS
// headers); PNGs load directly from the origin, which serves them immutable.
//
// Consistency rule: the image on screen and every caption describing it
// (time, lead, frame count, run, legend, attribution) come from one `shown`
// record that is replaced in a single synchronous step once the PNG has
// decoded. Stale requests are dropped by sequence numbers + AbortController.
import { CHARTS_URL, CHARTS_PROXY } from '../consts';

// ── Contract types ────────────────────────────────────────────────────────
type Status = 'pending' | 'preparing' | 'ready' | 'failed' | 'credentials_required';

interface Model {
  id: string;
  name: string;
  available: boolean;
  status: Status | string;
  catalog: string;
  runHoursUTC?: number[];
  maximumLeadHours?: number;
  runTime?: string;
}
interface ModelsDoc { schemaVersion: number; defaultModel: string; updatedAt?: string; models: Model[] }
interface RegionEntry { id: string; name: string; manifest: string; datasetID?: string; projection?: string }
interface CatalogDoc { schemaVersion: number; defaultRegion: string; regions: RegionEntry[] }
interface Frame { stepHours: number; validTime: string; path: string; byteSize?: number; sha256?: string }
interface Legend { unit: string; thresholds: number[]; colors: string[]; overflowColor?: string; missingColor?: string }
interface Attribution { source: string; url?: string; license?: string; licenseURL?: string; text?: string }
interface Manifest {
  schemaVersion: number;
  datasetID: string;
  runTime: string;
  region: { id: string; name: string };
  projection: string;
  pixelSize: [number, number];
  legend: Legend;
  attribution: Attribution;
  frames: Frame[];
}

interface Catalog { model: Model; url: URL; doc: CatalogDoc }
interface Dataset {
  model: Model;
  region: RegionEntry;
  manifestURL: URL;
  manifest: Manifest;
  /** validTime of each frame, epoch ms. */
  times: number[];
}

class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}
class DataError extends Error {}

// ── Constants ─────────────────────────────────────────────────────────────
const MODELS_URL = new URL('models.json', CHARTS_URL);
const PLAY_DELAY = 650; // ms a frame stays up during playback
const IMAGE_CACHE = 8; // decoded frames kept in memory (~5 MB each)
const AUTO_REFRESH = 30 * 60_000; // re-check catalogues when a tab returns after this long
const PREFS_KEY = 'surfcast.charts.prefs';
const MODEL_COLORS: Record<string, string> = {
  ecmwf: 'var(--m-ecmwf)',
  gfs: 'var(--m-gfs)',
  mfwam: 'var(--m-mfwam)',
  gwam: 'var(--m-dwd)',
  ewam: '#D59BE0',
};
const STATUS_LABEL: Record<string, string> = {
  pending: 'Coming soon',
  preparing: 'Updating',
  failed: 'Update failed',
  credentials_required: 'Unavailable',
};

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  root: $('cv'),
  models: $('cv-models'),
  region: $<HTMLSelectElement>('cv-region'),
  refresh: $<HTMLButtonElement>('cv-refresh'),
  map: $('cv-map'),
  spinner: $('cv-spinner'),
  time: $('cv-time'),
  lead: $('cv-lead'),
  frame: $('cv-frame'),
  source: $('cv-source'),
  status: $('cv-status'),
  statusText: $('cv-status-text'),
  retry: $<HTMLButtonElement>('cv-retry'),
  prev: $<HTMLButtonElement>('cv-prev'),
  play: $<HTMLButtonElement>('cv-play'),
  next: $<HTMLButtonElement>('cv-next'),
  range: $<HTMLInputElement>('cv-range'),
  track: $('cv-track'),
  days: $('cv-days'),
  ticks: $('cv-ticks'),
  now: $('cv-now'),
  labels: $('cv-labels'),
  legend: $('cv-legend'),
  legendUnit: $('cv-legend-unit'),
  badges: $('cv-badges'),
  run: $('cv-run'),
  notes: $('cv-notes'),
  attribution: $('cv-attribution'),
};

// ── Preferences (per-viewer convenience only) ─────────────────────────────
type Zone = 'utc' | 'local';
type Units = 'm' | 'ft';
const prefs: { zone: Zone; units: Units } = { zone: 'local', units: 'm' };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (saved.zone === 'utc' || saved.zone === 'local') prefs.zone = saved.zone;
  if (saved.units === 'm' || saved.units === 'ft') prefs.units = saved.units;
} catch { /* storage blocked: keep defaults */ }
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

// ── State ─────────────────────────────────────────────────────────────────
let models: ModelsDoc | null = null;
let checkedAt = 0;
let catalog: Catalog | null = null;
/** Last catalog read per model, so a failed switch can restore the region list on screen. */
const catalogs = new Map<string, Catalog>();
/** Dataset the timeline and controls drive. */
let current: Dataset | null = null;
/** What is actually on screen; captions are rendered only from this. */
let shown: { ds: Dataset; index: number } | null = null;
/** Frame index the user asked for in `current` (may still be loading). */
let target = -1;
const wanted = { model: '', region: '' };
let loadSeq = 0;
let frameSeq = 0;
let controller: AbortController | null = null;
let playing = false;
let playTimer = 0;

// ── Network ───────────────────────────────────────────────────────────────
function viaProxy(url: URL) {
  return url.href.startsWith(CHARTS_URL) ? CHARTS_PROXY + url.href.slice(CHARTS_URL.length) : url.href;
}

/** `revalidate` = conditional request every time (catalogues); otherwise HTTP cache rules apply. */
async function getJSON<T>(url: URL, signal: AbortSignal, revalidate: boolean): Promise<T> {
  const res = await fetch(viaProxy(url), {
    signal,
    cache: revalidate ? 'no-cache' : 'default',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new HttpError(res.status);
  try { return (await res.json()) as T; } catch { throw new DataError('Malformed JSON'); }
}

/** Distinguishes a removed frame (404 → run rotated) from a network failure. */
async function isGone(url: string) {
  try {
    const res = await fetch(viaProxy(new URL(url)), { method: 'HEAD', cache: 'no-store' });
    return res.status === 404;
  } catch { return false; }
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let pending = imageCache.get(url);
  if (pending) {
    imageCache.delete(url); // refresh LRU position
  } else {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    pending = img.decode().then(() => img);
    pending.catch(() => imageCache.delete(url));
  }
  imageCache.set(url, pending);
  while (imageCache.size > IMAGE_CACHE) imageCache.delete(imageCache.keys().next().value!);
  return pending;
}

const frameURL = (ds: Dataset, i: number) => new URL(ds.manifest.frames[i].path, ds.manifestURL).href;

// ── Validation ────────────────────────────────────────────────────────────
function checkModels(doc: ModelsDoc): ModelsDoc {
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.models)) throw new DataError('models.json');
  doc.models = doc.models.filter((m) => m && typeof m.id === 'string' && typeof m.catalog === 'string');
  return doc;
}
function checkCatalog(doc: CatalogDoc): CatalogDoc {
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.regions)) throw new DataError('catalog');
  doc.regions = doc.regions.filter((r) => r && typeof r.id === 'string' && typeof r.manifest === 'string');
  if (!doc.regions.length) throw new DataError('catalog has no regions');
  return doc;
}
function checkManifest(doc: Manifest, region: RegionEntry): Manifest {
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.frames)) throw new DataError('manifest');
  if (doc.region?.id && doc.region.id !== region.id) throw new DataError('manifest region mismatch');
  const [w, h] = doc.pixelSize ?? [];
  if (!(w > 0 && h > 0)) throw new DataError('manifest pixelSize');
  doc.frames = doc.frames
    .filter((f) => f && typeof f.path === 'string' && Number.isFinite(Date.parse(f.validTime)))
    .sort((a, b) => Date.parse(a.validTime) - Date.parse(b.validTime));
  if (!doc.frames.length) throw new DataError('manifest has no frames');
  return doc;
}

// ── Formatting ────────────────────────────────────────────────────────────
function timeParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short', timeZone: prefs.zone === 'utc' ? 'UTC' : undefined,
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: `${get('weekday')} ${get('day')} ${get('month')}`,
    clock: `${get('hour')}:${get('minute')}`,
    zone: prefs.zone === 'utc' ? 'UTC' : get('timeZoneName'),
  };
}
const fmtTime = (ms: number) => { const p = timeParts(ms); return `${p.day}, ${p.clock} ${p.zone}`; };
function fmtSpan(hours: number) {
  const d = Math.floor(hours / 24), h = hours % 24;
  return d ? `${d} d${h ? ` ${h} h` : ''}` : `${h} h`;
}
const lead = (ds: Dataset, i: number) => ds.manifest.frames[i].stepHours ?? Math.round((ds.times[i] - Date.parse(ds.manifest.runTime)) / 3_600_000);
function fmtHeight(m: number) {
  const v = prefs.units === 'ft' ? m / 0.3048 : m;
  return v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}
const shortName = (m: Model) => m.id.toUpperCase();

/** Run age after which a run counts as outdated: one run cycle + 6 h (12 h for 4 runs/day, 18 h for 00/12 UTC). */
function staleAfterHours(m: Model) {
  const runs = m.runHoursUTC?.length || 2;
  return 24 / runs + 6;
}

function describe(err: unknown) {
  if (err instanceof HttpError) return `the forecast server answered ${err.status}`;
  if (err instanceof DataError) return 'the forecast server returned unexpected data';
  return 'there is a network problem';
}
const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

// ── Status line ───────────────────────────────────────────────────────────
let retryAction: (() => void) | null = null;
function setStatus(kind: '' | 'loading' | 'info' | 'error', text = '', retry?: () => void) {
  el.status.dataset.kind = kind;
  el.statusText.textContent = text;
  el.status.hidden = !text;
  retryAction = retry ?? null;
  el.retry.hidden = !retry;
}

// ── Loading pipeline: models → catalog → manifest → frame ─────────────────
interface LoadRequest {
  model?: string;
  region?: string;
  /** Keep this valid time on screen (nearest frame); defaults to now. */
  keepTime?: number;
  /** Re-read models.json and the catalog even if we already have them. */
  fresh?: boolean;
  /** Set when reloading because a frame 404'd, so a second 404 doesn't loop. */
  recovering?: boolean;
  /** No progress messages (background re-checks). */
  quiet?: boolean;
  /** Report the outcome ("up to date" / "new run") — the Refresh button. */
  announce?: boolean;
}

async function load(req: LoadRequest) {
  stopPlayback();
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const seq = ++loadSeq;
  ++frameSeq; // drop frame loads belonging to the previous selection
  const stale = () => seq !== loadSeq;
  let notice = '';
  try {
    if (!models || req.fresh) {
      if (!req.quiet) setStatus('loading', 'Loading forecast models…');
      const doc = checkModels(await getJSON<ModelsDoc>(MODELS_URL, signal, true));
      if (stale()) return;
      models = doc;
      checkedAt = Date.now();
      renderModels();
    }

    // Model: the one asked for if it can be shown, else the default, else any available.
    const asked = models.models.find((m) => m.id === (req.model ?? wanted.model));
    const model = asked?.available ? asked
      : models.models.find((m) => m.id === models!.defaultModel && m.available) ?? models.models.find((m) => m.available);
    if (!model) throw new DataError('No model available');
    if (asked && asked !== model) notice = `${asked.name} is not available right now (${STATUS_LABEL[asked.status] ?? asked.status}). Showing ${model.name}.`;
    wanted.model = model.id;
    markModel();

    // Catalog (always revalidated when fetched).
    let cat = catalog;
    if (!cat || cat.model.id !== model.id || req.fresh) {
      if (!req.quiet) setStatus('loading', `Loading ${shortName(model)} regions…`);
      el.region.disabled = true;
      const url = new URL(model.catalog, MODELS_URL);
      const doc = checkCatalog(await getJSON<CatalogDoc>(url, signal, true));
      if (stale()) return;
      cat = catalog = { model, url, doc };
      catalogs.set(model.id, cat);
    }
    cat.model = model;
    renderRegions(cat);

    // Region: keep the previous one if this model has it, else the model's default.
    const regions = cat.doc.regions;
    const region = regions.find((r) => r.id === (req.region ?? wanted.region))
      ?? regions.find((r) => r.id === cat!.doc.defaultRegion) ?? regions[0];
    wanted.region = region.id;
    el.region.value = region.id;
    el.region.disabled = regions.length < 2;
    writeURL();

    if (!req.quiet) setStatus('loading', `Loading ${shortName(model)} · ${region.name}…`);
    const ds = await fetchDataset(cat, region, signal);
    if (stale()) return;

    const sameRun = current?.manifest.datasetID === ds.manifest.datasetID && current?.model.id === ds.model.id;
    current = ds;
    // Pick the frame before drawing the timeline: the previous index may not exist in this run.
    target = nearestIndex(ds, req.keepTime ?? Date.now());
    renderTimeline();
    renderBadges();
    if (req.announce) {
      notice ||= sameRun ? `Up to date · checked ${timeParts(checkedAt).clock}` : `Loaded the latest ${shortName(model)} run.`;
    }
    setStatus(notice ? 'info' : '', notice);
    await showFrame(target, { recovering: req.recovering });
  } catch (err) {
    if (stale() || isAbort(err)) return;
    const what = !models ? 'the list of models' : !catalog || catalog.model.id !== wanted.model ? 'the regions for this model' : 'the forecast run';
    setStatus('error', `Couldn't load ${what}: ${describe(err)}.${shown ? ' The last chart stays on screen.' : ''}`, () => load({ ...req, fresh: true }));
    // Selectors go back to what is on screen; Retry still asks for the original selection.
    if (shown) {
      wanted.model = shown.ds.model.id;
      wanted.region = shown.ds.region.id;
      markModel();
      writeURL();
      const shownCatalog = catalogs.get(wanted.model);
      if (shownCatalog) {
        catalog = shownCatalog;
        renderRegions(shownCatalog);
        el.region.value = wanted.region;
        el.region.disabled = shownCatalog.doc.regions.length < 2;
      }
    }
    setControlsEnabled(!!current);
  }
}

/** Reads the region manifest; on 404 the catalog has moved to a newer run, so re-read it once. */
async function fetchDataset(cat: Catalog, region: RegionEntry, signal: AbortSignal): Promise<Dataset> {
  const read = async (entry: RegionEntry, revalidate: boolean): Promise<Dataset> => {
    const manifestURL = new URL(entry.manifest, cat.url);
    const manifest = checkManifest(await getJSON<Manifest>(manifestURL, signal, revalidate), entry);
    return { model: cat.model, region: entry, manifestURL, manifest, times: manifest.frames.map((f) => Date.parse(f.validTime)) };
  };
  try {
    return await read(region, false);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    cat.doc = checkCatalog(await getJSON<CatalogDoc>(cat.url, signal, true));
    const fresh = cat.doc.regions.find((r) => r.id === region.id);
    if (!fresh) throw err;
    renderRegions(cat);
    return read(fresh, true);
  }
}

function nearestIndex(ds: Dataset, time: number) {
  let best = 0;
  ds.times.forEach((t, i) => { if (Math.abs(t - time) < Math.abs(ds.times[best] - time)) best = i; });
  return best;
}

async function showFrame(index: number, opts: { recovering?: boolean } = {}) {
  const ds = current;
  if (!ds) return;
  const last = ds.times.length - 1;
  index = Math.max(0, Math.min(last, index));
  target = index;
  syncRange();
  const seq = ++frameSeq;
  const url = frameURL(ds, index);
  // Spinner at once when the dataset changes, after a short grace period when scrubbing.
  const spin = window.setTimeout(() => { if (seq === frameSeq) el.spinner.hidden = false; }, shown?.ds === ds ? 180 : 0);
  try {
    const img = await loadImage(url);
    if (seq !== frameSeq || ds !== current) return;
    paint(ds, index, img);
    if (el.status.dataset.kind === 'error') setStatus('');
    prefetch(ds, index);
    if (playing) index >= last ? stopPlayback() : schedulePlay();
  } catch {
    if (seq !== frameSeq || ds !== current) return;
    stopPlayback();
    if (!opts.recovering && await isGone(url)) {
      if (seq !== frameSeq) return;
      // The run behind this frame was replaced: re-read catalog + manifest, stay at this time.
      load({ fresh: true, keepTime: ds.times[index], recovering: true, quiet: true });
      return;
    }
    if (seq !== frameSeq) return;
    const when = fmtTime(ds.times[index]);
    setStatus('error', `Couldn't load the chart for ${when}.${shown ? ' Showing the last chart that loaded.' : ''}`, () => showFrame(index));
    // Put the slider back on the frame that is actually on screen.
    if (shown?.ds === ds) target = shown.index;
    syncRange();
  } finally {
    clearTimeout(spin);
    if (seq === frameSeq) el.spinner.hidden = true;
  }
}

function prefetch(ds: Dataset, index: number) {
  const ahead = playing ? [1, 2, 3] : [1, -1];
  for (const d of ahead) {
    const i = index + d;
    if (i >= 0 && i < ds.times.length) loadImage(frameURL(ds, i)).catch(() => {});
  }
}

// ── Rendering: what's shown ───────────────────────────────────────────────
function paint(ds: Dataset, index: number, img: HTMLImageElement) {
  const [w, h] = ds.manifest.pixelSize;
  img.width = w;
  img.height = h;
  img.className = 'cv-img';
  const datasetChanged = shown?.ds !== ds;
  shown = { ds, index };
  if (datasetChanged) {
    el.map.style.setProperty('--w', String(w));
    el.map.style.setProperty('--h', String(h));
    el.map.dataset.polar = String(ds.manifest.projection !== 'EPSG:4326');
    renderLegend();
    renderNotes();
  }
  el.map.replaceChildren(img);
  renderCaption();
}

function renderCaption() {
  if (!shown) return;
  const { ds, index } = shown;
  const t = timeParts(ds.times[index]);
  el.time.innerHTML = '';
  const day = document.createElement('span');
  day.textContent = `${t.day}, `;
  const clock = document.createElement('strong');
  clock.textContent = `${t.clock} ${t.zone}`;
  el.time.append(day, clock);
  el.lead.textContent = `+${lead(ds, index)} h`;
  el.frame.textContent = `Frame ${index + 1} of ${ds.times.length}`;
  el.source.textContent = `${ds.model.name} · ${ds.manifest.region?.name ?? ds.region.name}`;
  const img = el.map.querySelector('img');
  if (img) img.alt = `${ds.model.name} significant wave height, ${ds.region.name}, ${fmtTime(ds.times[index])}`;

  const run = Date.parse(ds.manifest.runTime);
  const horizon = lead(ds, ds.times.length - 1);
  el.run.textContent = `Run ${fmtTime(run)} · ${ds.times.length} frames · to +${horizon} h (${fmtSpan(horizon)})`;
  renderBadges();
}

function renderBadges() {
  el.badges.replaceChildren();
  const ds = shown?.ds;
  if (!ds) return;
  const live = models?.models.find((m) => m.id === ds.model.id) ?? ds.model;
  const add = (kind: string, text: string, title = '') => {
    const b = document.createElement('span');
    b.className = `cv-badge ${kind}`;
    b.textContent = text;
    if (title) b.title = title;
    el.badges.append(b);
  };
  const ageH = (Date.now() - Date.parse(ds.manifest.runTime)) / 3_600_000;
  if (ageH > staleAfterHours(live)) add('warn', `Outdated · run is ${Math.round(ageH)} h old`, 'A newer run should normally be available by now.');
  if (live.status === 'failed') add('warn', 'Latest update failed · showing previous run');
  else if (live.status === 'preparing') add('info', 'New run being prepared');
  else if (live.status === 'pending') add('info', 'Update pending');
  if (ds.manifest.projection !== 'EPSG:4326') add('', 'Polar view');
}

function renderLegend() {
  const lg = shown?.ds.manifest.legend;
  el.legend.replaceChildren();
  if (!lg) return;
  el.legendUnit.textContent = prefs.units === 'ft' ? 'ft' : 'm';
  const bar = document.createElement('div');
  bar.className = 'cv-legend-bar';
  const marks = document.createElement('div');
  marks.className = 'cv-legend-marks';
  const n = lg.colors.length;
  lg.colors.forEach((c) => {
    const s = document.createElement('span');
    s.style.background = c;
    bar.append(s);
  });
  lg.thresholds.slice(0, n + 1).forEach((v, i) => {
    const m = document.createElement('span');
    m.style.left = `${(i / n) * 100}%`;
    m.textContent = i === n ? `${fmtHeight(v)}+` : fmtHeight(v);
    marks.append(m);
  });
  const scale = document.createElement('div');
  scale.className = 'cv-legend-scale';
  scale.append(bar, marks);
  el.legend.append(scale);
  if (lg.missingColor) {
    const miss = document.createElement('span');
    miss.className = 'cv-legend-missing';
    const sw = document.createElement('i');
    sw.style.background = lg.missingColor;
    miss.append(sw, 'No data');
    el.legend.append(miss);
  }
  el.legend.setAttribute('aria-label', `Significant wave height scale in ${prefs.units === 'ft' ? 'feet' : 'metres'}`);
}

function renderNotes() {
  const ds = shown?.ds;
  if (!ds) return;
  const primary = ds.model.id === 'gfs';
  el.notes.replaceChildren(
    ...[
      'Colour is significant wave height in the open ocean — not surf height at the beach.',
      primary
        ? 'Arrows show where the primary waves (the dominant wave train in NOAA’s data) are travelling to.'
        : 'Arrows show where the waves are travelling to.',
      'Dark sea areas can mean the model has no data there.',
    ].map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );
  const a = ds.manifest.attribution;
  el.attribution.replaceChildren();
  if (!a) return;
  const link = (text: string, href?: string) => {
    if (!href) return document.createTextNode(text);
    const l = document.createElement('a');
    l.href = href;
    l.textContent = text;
    l.target = '_blank';
    l.rel = 'noopener';
    return l;
  };
  el.attribution.append('Source: ', link(a.source, a.url));
  if (a.license) el.attribution.append(' · Licence: ', link(a.license, a.licenseURL));
  if (a.text) el.attribution.append(document.createElement('br'), a.text);
}

// ── Rendering: selectors ──────────────────────────────────────────────────
function renderModels() {
  el.models.replaceChildren(
    ...models!.models.map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cv-model';
      b.dataset.id = m.id;
      b.disabled = !m.available;
      b.style.setProperty('--c', MODEL_COLORS[m.id] ?? 'var(--text-tertiary)');
      const label = STATUS_LABEL[m.status];
      b.title = m.name + (label ? ` — ${label}` : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      b.append(dot, shortName(m));
      if (label && (!m.available || m.status !== 'preparing')) {
        const tag = document.createElement('small');
        tag.textContent = m.available ? 'old run' : label;
        b.append(tag);
      }
      return b;
    }),
  );
  markModel();
}
function markModel() {
  for (const b of el.models.querySelectorAll<HTMLButtonElement>('.cv-model')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === wanted.model));
  }
}
function renderRegions(cat: Catalog) {
  el.region.replaceChildren(
    ...cat.doc.regions.map((r) => new Option(r.projection && r.projection !== 'EPSG:4326' ? `${r.name} (polar)` : r.name, r.id)),
  );
}
function writeURL() {
  const url = new URL(location.href);
  url.searchParams.set('model', wanted.model);
  url.searchParams.set('region', wanted.region);
  history.replaceState(history.state, '', url);
}

// ── Timeline ──────────────────────────────────────────────────────────────
// The slider runs in minutes from the first frame, so frames sit at their real
// time positions whatever the step; input snaps to the nearest frame.
const pct = (ds: Dataset, t: number) => {
  const span = ds.times[ds.times.length - 1] - ds.times[0];
  return span ? ((t - ds.times[0]) / span) * 100 : 0;
};

function renderTimeline() {
  const ds = current;
  if (!ds) return;
  const span = (ds.times[ds.times.length - 1] - ds.times[0]) / 60_000;
  el.range.max = String(Math.max(1, span));
  el.ticks.replaceChildren(
    ...ds.times.map((t) => {
      const tick = document.createElement('i');
      tick.style.left = `${pct(ds, t)}%`;
      return tick;
    }),
  );
  renderDays();
  setControlsEnabled(true);
  syncRange();
}

function renderDays() {
  const ds = current;
  if (!ds) return;
  const t0 = ds.times[0], tN = ds.times[ds.times.length - 1];
  const utc = prefs.zone === 'utc';
  const start = new Date(t0);
  utc ? start.setUTCHours(0, 0, 0, 0) : start.setHours(0, 0, 0, 0);
  const segments: { from: number; to: number; label: string }[] = [];
  for (let d = start; d.getTime() < tN;) {
    const next = new Date(d);
    utc ? next.setUTCDate(next.getUTCDate() + 1) : next.setDate(next.getDate() + 1);
    const from = Math.max(t0, d.getTime()), to = Math.min(tN, next.getTime());
    const p = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: utc ? 'UTC' : undefined }).format(d);
    if (to > from) segments.push({ from, to, label: p });
    d = next;
  }
  // Thin out labels so they never collide on narrow screens.
  const width = el.track.clientWidth || 600;
  const fullDays = segments.filter((s) => s.to - s.from >= 12 * 3_600_000).length || 1;
  const stride = Math.max(1, Math.ceil((fullDays * 54) / width));
  el.days.replaceChildren();
  el.labels.replaceChildren();
  let n = 0;
  segments.forEach((s, i) => {
    const band = document.createElement('i');
    band.style.left = `${pct(ds, s.from)}%`;
    band.style.width = `${pct(ds, s.to) - pct(ds, s.from)}%`;
    if (i % 2) band.className = 'alt';
    el.days.append(band);
    if (s.to - s.from < 12 * 3_600_000) return; // partial day at an edge: no room for a label
    if (n++ % stride) return;
    const label = document.createElement('span');
    label.style.left = `${(pct(ds, s.from) + pct(ds, s.to)) / 2}%`;
    label.textContent = s.label;
    el.labels.append(label);
  });
  const now = Date.now();
  el.now.hidden = now < t0 || now > tN;
  el.now.style.left = `${pct(ds, now)}%`;
}

function syncRange() {
  const ds = current;
  if (!ds || target < 0 || target >= ds.times.length) return;
  el.range.value = String((ds.times[target] - ds.times[0]) / 60_000);
  el.range.setAttribute('aria-valuetext', `${fmtTime(ds.times[target])}, +${lead(ds, target)} hours, frame ${target + 1} of ${ds.times.length}`);
  el.range.style.setProperty('--p', `${pct(ds, ds.times[target])}%`);
  el.prev.disabled = target <= 0;
  el.next.disabled = target >= ds.times.length - 1;
}

function setControlsEnabled(on: boolean) {
  for (const b of [el.prev, el.next, el.play]) b.disabled = !on;
  el.range.disabled = !on;
  if (on) syncRange();
}

// ── Playback ──────────────────────────────────────────────────────────────
function startPlayback() {
  if (!current) return;
  playing = true;
  el.play.setAttribute('aria-pressed', 'true');
  el.play.setAttribute('aria-label', 'Pause');
  showFrame(target >= current.times.length - 1 ? 0 : target + 1);
}
function stopPlayback() {
  playing = false;
  clearTimeout(playTimer);
  el.play.setAttribute('aria-pressed', 'false');
  el.play.setAttribute('aria-label', 'Play');
}
function schedulePlay() {
  clearTimeout(playTimer);
  playTimer = window.setTimeout(() => { if (playing) showFrame(target + 1); }, PLAY_DELAY);
}
function step(delta: number) {
  stopPlayback();
  showFrame(target + delta);
}

// ── Events ────────────────────────────────────────────────────────────────
const shownTime = () => (shown ? shown.ds.times[shown.index] : undefined);

el.models.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cv-model');
  if (!b || b.disabled || b.dataset.id === wanted.model && catalog?.model.id === wanted.model) return;
  load({ model: b.dataset.id, keepTime: shownTime() });
});
el.region.addEventListener('change', () => load({ region: el.region.value, keepTime: shownTime() }));
el.refresh.addEventListener('click', () => load({ fresh: true, announce: true, keepTime: shownTime() }));
el.retry.addEventListener('click', () => retryAction?.());
el.prev.addEventListener('click', () => step(-1));
el.next.addEventListener('click', () => step(1));
el.play.addEventListener('click', () => (playing ? stopPlayback() : startPlayback()));

el.range.addEventListener('input', () => {
  if (!current) return;
  stopPlayback();
  const i = nearestIndex(current, current.times[0] + el.range.valueAsNumber * 60_000);
  if (i !== target) showFrame(i);
});
el.range.addEventListener('change', syncRange); // snap the thumb onto the frame on release
el.range.addEventListener('keydown', (e) => {
  if (!current) return;
  const day = (dir: number) => nearestIndex(current!, current!.times[target] + dir * 24 * 3_600_000);
  const keys: Record<string, () => number> = {
    ArrowRight: () => target + 1, ArrowUp: () => target + 1,
    ArrowLeft: () => target - 1, ArrowDown: () => target - 1,
    PageUp: () => day(1), PageDown: () => day(-1),
    Home: () => 0, End: () => current!.times.length - 1,
  };
  const to = keys[e.key];
  if (!to) return;
  e.preventDefault();
  stopPlayback();
  showFrame(to());
});

for (const b of el.root.querySelectorAll<HTMLButtonElement>('[data-zone], [data-units]')) {
  b.addEventListener('click', () => {
    if (b.dataset.zone) prefs.zone = b.dataset.zone as Zone;
    if (b.dataset.units) prefs.units = b.dataset.units as Units;
    savePrefs();
    syncToggles();
    // Labels only: the PNGs are unit- and zone-independent.
    renderCaption();
    renderLegend();
    renderDays();
    syncRange();
  });
}
function syncToggles() {
  for (const b of el.root.querySelectorAll<HTMLButtonElement>('[data-zone]')) b.setAttribute('aria-pressed', String(b.dataset.zone === prefs.zone));
  for (const b of el.root.querySelectorAll<HTMLButtonElement>('[data-units]')) b.setAttribute('aria-pressed', String(b.dataset.units === prefs.units));
}

new ResizeObserver(() => renderDays()).observe(el.track);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPlayback(); return; }
  if (models && Date.now() - checkedAt > AUTO_REFRESH) load({ fresh: true, keepTime: shownTime(), quiet: true });
});
window.addEventListener('pagehide', stopPlayback);

// ── Start ─────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
wanted.model = params.get('model') ?? '';
wanted.region = params.get('region') ?? '';
syncToggles();
load({});
