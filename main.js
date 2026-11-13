const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const store = require('./src/store');
const { png, trayPng } = require('./src/icon');
const { DiscordVoice } = require('./src/discord');
const assistant = require('./src/assistant');
const news = require('./src/news');
const extras = require('./src/extras'); // таймер, точное время, время за ПК
const weather = require('./src/weather');
const lyrics = require('./src/lyrics');
const telegram = require('./src/telegram');
const updater = require('./src/updater');
const translator = require('./src/translate');
const pro = require('./src/pro');
const winnotify = require('./src/winnotify'); // уведомления Windows (Telegram, Discord, почта)
const waveScreen = require('./src/wavescreen'); // WaveScreen: скриншоты с разметкой
const { SmartLayoutService } = require('./src/smartlayout/service'); // подсказки при наборе не в той раскладке
const smartLayout = new SmartLayoutService();

// ---- режим установщика / удаления (свой установщик в стиле острова)
// установщик = эта же программа, запущенная из одиночного exe (portable): там есть PORTABLE_EXECUTABLE_FILE
const SETUP_MODE = process.argv.includes('--uninstall') ? 'uninstall'
  : (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) || (!app.isPackaged && process.env.DI_SETUP) ? 'install' : null;
if (SETUP_MODE) { require('./src/setup').start(SETUP_MODE); return; }

// отладка: отдельная папка данных и без блокировки второй копии (не мешает установленному острову)
if (process.env.DI_DEBUG_USERDATA) app.setPath('userData', process.env.DI_DEBUG_USERDATA);
else if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// отладка: имитация заблокированных сайтов (DI_DEBUG_BLOCK="news.google.com,*.open-meteo.com") — запросы к ним зависают
if (process.env.DI_DEBUG_BLOCK) {
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('host-resolver-rules', process.env.DI_DEBUG_BLOCK.split(',').map(h => `MAP ${h.trim()} 10.255.255.1`).join(', '));
}
// фоновое троттлинг отключён точечно (backgroundThrottling:false у острова и превью), остальные окна могут «спать»

// размер прозрачного окна острова: развёрнутый вид + запас по бокам и снизу (карточка пересказа новости)
// ширина с запасом по бокам: слева плашка Wave correction, справа — Discord (даже при раскрытом острове)
const winSize = () => { const s = store.get(); return { w: Math.max(1320, (+s.islandExpW || 470) + 2 * 400), h: Math.max(520, (+s.islandExpH || 220) + 300) }; };
const WIN_W = 640, WIN_H = 520;
let island = null, settingsWin = null, tray = null, helper = null, discord = null;
let quitting = false;
let hiddenByUser = false;
const state = { media: null, art: {}, mic: [], sys: null, procs: [], discord: null, paths: {} };

// ---------------------------------------------------------------- windows
function islandDisplay() {
  const s = store.get();
  const displays = screen.getAllDisplays();
  return (s.display >= 0 && displays[s.display]) || screen.getPrimaryDisplay();
}

// Адаптивный масштаб острова: на маленьких экранах чуть компактнее, на больших — крупнее.
// Подбираем так, чтобы (масштаб Windows × масштаб острова) был кратен 0.25 — тогда пиксели ложатся ровно.
function islandZoom() {
  const s = store.get();
  const d = islandDisplay();
  const sf = d.scaleFactor || 1;
  let z = +s.uiScale;
  if (!z) {
    const h = d.size.height;            // высота экрана в логических пикселях (уже с учётом масштаба Windows)
    z = h < 720 ? 0.85 : h < 820 ? 0.92 : h <= 1100 ? 1 : h <= 1300 ? 1.1 : 1.2;
  }
  z = Math.round(z * 20) / 20; // шаг 5%: каждое движение ползунка видно на острове
  return Math.max(0.7, Math.min(1.6, z));
}
const islandSettings = () => ({ ...pro.effectiveSettings(store.publicView()), zoom: islandZoom() });

function placeIsland() {
  if (!island) return;
  const b = islandDisplay().bounds;
  const z = islandZoom();
  const ws = winSize();
  const w = Math.ceil(ws.w * z), h = Math.ceil(ws.h * z);
  const shift = Math.max(-45, Math.min(45, +store.get().offsetX || 0)) / 100 * b.width;
  island.setBounds({ x: Math.round(b.x + (b.width - w) / 2 + shift), y: b.y, width: w, height: h });
  send('settings', islandSettings());
}

function createIsland() {
  island = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    alwaysOnTop: true, thickFrame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  island.setAlwaysOnTop(true, 'screen-saver', 1);
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyCaptureProtection();
  island.setIgnoreMouseEvents(true, { forward: true });
  placeIsland();
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'));
  if (process.env.DI_DEBUG) island.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.log('island-console', msg, String(src).split('/').pop() + ':' + line); });
  island.once('ready-to-show', () => { island.showInactive(); pushAll(); });
  // отладка: карточка перевода с тестовым текстом (DI_DEBUG_TR='{"src":…,"out":…,"to":"ru"}')
  if (process.env.DI_DEBUG_TR) setTimeout(() => send('translate', JSON.parse(process.env.DI_DEBUG_TR)), 3000);
  if (process.env.DI_DEBUG_QUIT) setTimeout(() => app.quit(), +process.env.DI_DEBUG_QUIT);
  if (process.env.DI_DEBUG) {
    setTimeout(async () => {
      console.log('bounds', JSON.stringify(island.getBounds()), 'visible', island.isVisible());
      const img = await island.webContents.capturePage();
      fs.writeFileSync(process.env.DI_DEBUG, img.toPNG());
      if (process.env.DI_DEBUG_ISLAND_JS) {
        const r = await island.webContents.executeJavaScript(fs.readFileSync(process.env.DI_DEBUG_ISLAND_JS, 'utf8')).catch(e => 'ERR ' + e.message);
        console.log('island-js', JSON.stringify(r));
        await new Promise(res => setTimeout(res, 3500));
        fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-card.png'), (await island.webContents.capturePage()).toPNG());
        // отладка: скрипт может вернуть список шагов — после каждого снимок острова
        if (Array.isArray(r)) for (let i = 0; i < r.length; i++) {
          const o = await island.webContents.executeJavaScript(r[i]).catch(e => 'ERR ' + e.message);
          console.log('island-step', i, JSON.stringify(o));
          await new Promise(res => setTimeout(res, 1600));
          fs.writeFileSync(process.env.DI_DEBUG.replace('.png', `-step${i}.png`), (await island.webContents.capturePage()).toPNG());
          if (process.env.DI_DEBUG_SCREEN) { // то, что реально на экране (а не снимок окна)
            const d = screen.getPrimaryDisplay(), b = island.getBounds();
            const src = (await require('electron').desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor } }))[0];
            if (src) fs.writeFileSync(process.env.DI_DEBUG.replace('.png', `-screen${i}.png`), src.thumbnail.crop({ x: Math.round((b.x - d.bounds.x) * d.scaleFactor), y: Math.round((b.y - d.bounds.y) * d.scaleFactor), width: Math.round(b.width * d.scaleFactor), height: Math.round(260 * d.scaleFactor) }).toPNG());
          }
        }
      }
      openSettings();
      setTimeout(async () => {
        const s = await settingsWin.webContents.capturePage();
        fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-settings.png'), s.toPNG());
        if (process.env.DI_DEBUG_JS) {
          const r = await settingsWin.webContents.executeJavaScript(fs.readFileSync(process.env.DI_DEBUG_JS, 'utf8')).catch(e => 'ERR ' + e.message);
          console.log('debug-js', JSON.stringify(r));
          await new Promise(res => setTimeout(res, 600));
          fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-settings2.png'), (await settingsWin.webContents.capturePage()).toPNG());
          fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-island2.png'), (await island.webContents.capturePage()).toPNG());
          if (onboardWin && !onboardWin.isDestroyed()) fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-onboard.png'), (await onboardWin.webContents.capturePage()).toPNG());
        }
      }, 2500);
    }, 5000);
  }
  island.on('closed', () => { island = null; });
  // отладка производительности: DI_DEBUG_PROFILE=путь.cpuprofile — профиль процессора острова за 10 с (через 8 с после старта)
  if (process.env.DI_DEBUG_PROFILE) setTimeout(async () => {
    const dbg = island.webContents.debugger; dbg.attach('1.3');
    await dbg.sendCommand('Profiler.enable'); await dbg.sendCommand('Profiler.start');
    const ev = {}; dbg.on('message', (_e, m, p) => { if (m === 'Tracing.dataCollected') for (const x of p.value) if (x.name) ev[x.name] = (ev[x.name] || 0) + 1; if (m === 'Tracing.tracingComplete') console.log('perf-trace', JSON.stringify(Object.entries(ev).sort((a, b) => b[1] - a[1]).slice(0, 25))); });
    await dbg.sendCommand('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,cc,blink', transferMode: 'ReportEvents' });
    setTimeout(() => dbg.sendCommand('Tracing.end').catch(() => {}), 5000);
    await new Promise(r => setTimeout(r, 7000));
    const { profile } = await dbg.sendCommand('Profiler.stop');
    fs.writeFileSync(process.env.DI_DEBUG_PROFILE, JSON.stringify(profile)); dbg.detach(); console.log('profile saved');
    const wins = BrowserWindow.getAllWindows().map(w => ({ pid: w.webContents.getOSProcessId(), url: w.webContents.getURL().split('/').pop().slice(0, 40), vis: w.isVisible() }));
    console.log('perf-windows', JSON.stringify(wins));
  }, 8000);
  // остров берёт фокус только на время ввода задачи; ушёл фокус — снова «прозрачен» для клавиатуры
  island.on('blur', () => { if (island) island.setFocusable(false); });
  // Поверх всех окон: самый высокий уровень topmost + регулярное возвращение наверх,
  // потому что панель задач, «Пуск» и другие topmost-окна могут перекрыть остров.
  const keepOnTop = () => {
    if (!island || island.isDestroyed()) return;
    if (snipActive || waveScreen.active() || gameHide) return; // не поднимаем остров над «Ножницами», WaveScreen и игрой
    if (!island.isAlwaysOnTop()) island.setAlwaysOnTop(true, 'screen-saver', 1);
    if (!island.isVisible() && !hiddenByUser) island.showInactive();
    island.moveTop();
  };
  island.on('always-on-top-changed', (_e, on) => { if (!on) keepOnTop(); });
  island.on('blur', keepOnTop);
  setInterval(keepOnTop, 2000);
}

// окна приложения: размер и положение запоминаются, масштаб берётся из настроек (раздел «Размеры»)
const appWindows = new Set();
function appWindow(key, opts) {
  const saved = (store.get().windowBounds || {})[key];
  const on = d => saved && screen.getAllDisplays().some(x => saved.x < x.bounds.x + x.bounds.width - 60 && saved.x + saved.width > x.bounds.x + 60 && saved.y >= x.bounds.y - 10 && saved.y < x.bounds.y + x.bounds.height - 60);
  const win = new BrowserWindow({
    backgroundColor: '#1c1c1e', titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1c1c1e', symbolColor: '#e6e6ea', height: 40 },
    icon: nativeImage.createFromBuffer(png(64)),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
    ...opts,
    ...(on() ? { x: saved.x, y: saved.y, width: Math.max(opts.minWidth || 0, saved.width), height: Math.max(opts.minHeight || 0, saved.height) } : {}),
  });
  win.setMenu(null);
  const zoom = () => { if (!win.isDestroyed()) win.webContents.setZoomFactor(Math.max(0.8, Math.min(1.3, +store.get().windowZoom || 1))); };
  win.webContents.on('did-finish-load', zoom);
  let t = null;
  const remember = () => { clearTimeout(t); t = setTimeout(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    store.set({ windowBounds: { ...(store.get().windowBounds || {}), [key]: win.getBounds() } });
  }, 500); };
  win.on('resize', remember); win.on('move', remember);
  appWindows.add(win); win.on('closed', () => appWindows.delete(win));
  win.__zoom = zoom;
  return win;
}
function applyWindowZoom() { for (const w of appWindows) if (!w.isDestroyed()) w.__zoom(); }

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  // боковая панель — на настоящем стекле Windows 11 (mica), содержимое непрозрачное
  settingsWin = appWindow('settings', { width: 1000, height: 720, minWidth: 860, minHeight: 560, title: 'Dynamic Wave — настройки', backgroundColor: '#121212', titleBarOverlay: { color: '#121212', symbolColor: '#ffffff', height: 40 } });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  if (process.env.DI_DEBUG) settingsWin.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.log('settings-console', msg, String(src).split('/').pop() + ':' + line); });
  // свёрнутые настройки — превью не рисует кадры
  settingsWin.on('minimize', () => { if (preview && !preview.win.isDestroyed()) preview.win.webContents.stopPainting(); });
  settingsWin.on('restore', () => { if (preview && !preview.win.isDestroyed()) preview.win.webContents.startPainting(); });
}

const PREVIEW_CH = new Set(['settings', 'media', 'media:art', 'weather', 'sys', 'kbd', 'preview:mode', 'theme', 'todos', 'timer', 'time:offset', 'pc']);
function send(ch, data) {
  if (island && !island.isDestroyed()) island.webContents.send(ch, data);
  // превью нужно только то, что меняет вид острова в разделе «Размеры»
  if (preview && !preview.win.isDestroyed() && PREVIEW_CH.has(ch)) preview.win.webContents.send(ch, data);
}

// ---------------------------------------------------------------- живое превью острова (раздел «Размеры»)
// Невидимое окно с тем же island.html: тот же код и стили, поэтому превью совпадает с островом на экране.
// Кадры (12 в секунду, только пока открыт раздел) уходят в окно настроек.
let preview = null; // { win, target, mode, last }
function startPreview(target) {
  if (preview && !preview.win.isDestroyed()) { preview.target = target; sendPreviewSettings(); return; }
  const z = islandZoom(), ws = winSize();
  const win = new BrowserWindow({
    show: false, width: Math.ceil(ws.w * z), height: Math.ceil(ws.h * z), frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: true, backgroundThrottling: false },
  });
  preview = { win, target, mode: 'compact', last: 0 };
  if (process.env.DI_DEBUG) { console.log('preview: start'); win.webContents.on('console-message', (_e, _l, m) => console.log('preview-console', m)); }
  win.webContents.setFrameRate(12);
  win.webContents.on('paint', (_e, _dirty, image) => {
    const p = preview; if (p && process.env.DI_DEBUG && !p.dbg) { p.dbg = 1; console.log('preview: first paint', JSON.stringify(image.getSize())); }
    if (!p || p.win !== win || !p.target || p.target.isDestroyed()) return;
    const now = Date.now(); if (now - p.last < 70) return; p.last = now;
    const st = store.get(), zz = islandZoom();
    const sz = image.getSize();
    // кадр — только сам остров: по ширине развёрнутого вида, по высоте — под текущий режим
    const cardH = Math.round(84 * Math.max(.85, Math.min(1.3, +st.cardScale || 1)));
    const bodyH = p.mode === 'expanded' ? (+st.islandExpH || 220) : p.mode === 'notify' ? Math.max(+st.islandPillH || 38, cardH) : (+st.islandPillH || 38);
    const h = Math.min(sz.height, Math.ceil(((+st.offsetY || 8) + bodyH + 22) * zz));
    const w = Math.min(sz.width, Math.ceil(((+st.islandExpW || 470) + 90) * zz));
    const crop = image.crop({ x: Math.max(0, Math.round((sz.width - w) / 2)), y: 0, width: w, height: h });
    // одинаковые кадры не кодируем и не пересылаем
    const bmp = crop.toBitmap();
    if (p.bmp && p.bmp.length === bmp.length && p.bmp.equals(bmp) && p.key === w + 'x' + h + ':' + zz + ':' + (st.offsetX || 0)) return;
    p.bmp = bmp; p.key = w + 'x' + h + ':' + zz + ':' + (st.offsetX || 0);
    p.target.send('sizes:frame', { url: crop.toDataURL(), w, h, zoom: zz, offsetX: +st.offsetX || 0 });
  });
  win.loadFile(path.join(__dirname, 'renderer', 'island.html'), { query: { preview: '1' } });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('settings', islandSettings());
    win.webContents.send('media', mediaPayload());
    { const k = Object.keys(state.art)[0]; if (k) win.webContents.send('media:art', { key: k, data: state.art[k] }); }
    if (state.sys) win.webContents.send('sys', state.sys);
    if (weather.get()) win.webContents.send('weather', weather.get());
    win.webContents.send('preview:mode', preview.mode);
  });
}
function sendPreviewSettings() {
  if (!preview || preview.win.isDestroyed()) return;
  const z = islandZoom(), ws = winSize();
  preview.win.setSize(Math.ceil(ws.w * z), Math.ceil(ws.h * z));
  preview.win.webContents.send('settings', islandSettings());
}
function stopPreview() { if (preview && !preview.win.isDestroyed()) preview.win.destroy(); preview = null; }
function sendSettings(ch, data) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(ch, data);
}

function pushAll() {
  send('settings', islandSettings());
  send('media', mediaPayload());
  { const k = Object.keys(state.art)[0]; if (k) send('media:art', { key: k, data: state.art[k] }); }
  helperCmd('vol get');
  helperCmd(store.get().volKeysPill !== false ? 'volwatch on' : 'volwatch off');
  lyricsKey = ''; updateLyrics();
  send('mic', state.mic);
  if (state.sys) send('sys', state.sys);
  send('procs', state.procs);
  if (state.news) send('news', state.news);
  if (state.discord) send('discord', state.discord);
  if (state.kbd) send('kbd', { ...state.kbd, show: null });
  if (weather.get()) send('weather', weather.get());
  if (extrasReady) extras.pushAll();
}
let extrasReady = false;

// ---------------------------------------------------------------- helper (PowerShell)
function mediaPayload() {
  const m = state.media;
  if (!m || !m.title) return null;
  const key = `${m.title}|${m.artist}|${m.app}`;
  return { ...m, artKey: key };
}

function startHelper() {
  // в собранном приложении скрипт лежит в app.asar.unpacked (PowerShell не читает asar)
  const script = path.join(__dirname, 'src', 'helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: helper.stdout });
  rl.on('line', line => {
    line = line.replace(/^﻿/, '').trim();
    if (!line.startsWith('{')) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    onHelper(msg);
  });
  helper.stderr.on('data', d => console.error('[helper]', d.toString()));
  // запись в уже закрытый помощник (выход, перезапуск) даёт EPIPE — гасим, это не ошибка
  helper.stdin.on('error', () => {});
  const self = helper;
  helper.on('exit', () => {
    if (helper === self) { helper = null; meterOn = false; setSnip(false); }
    if (!quitting) setTimeout(startHelper, 2000);
  });
}

// остров исключён из захвата экрана (WDA_EXCLUDEFROMCAPTURE): его нет на снимках Win+Shift+S и в записи
function applyCaptureProtection() {
  if (island && !island.isDestroyed()) island.setContentProtection(store.get().hideFromCapture !== false);
}
// «Ножницы» (Win+Shift+S) открыли своё затемнение — остров прячем, чтобы он не лежал поверх выделения
let snipActive = false, wsHide = false, gameHide = false;
function applyOpacity() { if (island && !island.isDestroyed()) island.setOpacity(snipActive || wsHide || gameHide ? 0 : 1); }
// полноэкранная игра: остров прячется, ассистент желает приятной игры; вышли — остров появляется с анимацией
const gameGreetAt = new Map();
function onGame(msg) {
  const s = store.get();
  const on = !!msg.on && s.gameMode !== false;
  if (on === gameHide) return;
  gameHide = on;
  if (on) {
    applyOpacity();
    const p = String(msg.proc || '').toLowerCase();
    if (s.gameGreet !== false && Date.now() - (gameGreetAt.get(p) || 0) > 15 * 60e3) { gameGreetAt.set(p, Date.now()); assistant.sayKey('game'); }
  } else {
    send('island:reveal');
    setTimeout(() => { applyOpacity(); if (island && !island.isDestroyed()) island.moveTop(); }, 40);
  }
}
function setSnip(on) {
  if (on === snipActive || !island || island.isDestroyed()) return;
  snipActive = on;
  applyOpacity();
  if (!on && !wsHide) island.moveTop();
}

// текст песни: при смене трека ищем в LRCLIB и отдаём острову
let lyricsKey = '';
async function updateLyrics() {
  const m = state.media;
  if (!m || !m.title || store.get().lyricsEnabled === false) { if (lyricsKey) { lyricsKey = ''; send('lyrics', null); } return; }
  const key = `${m.title}|${m.artist}`;
  if (key === lyricsKey) return;
  lyricsKey = key;
  send('lyrics', { key, loading: true });
  const r = await lyrics.forTrack(m).catch(() => null);
  if (!r || lyricsKey !== key) return;
  if (process.env.DI_DEBUG) console.log('lyrics:', r.none ? 'none ' + (r.error || '') : (r.synced ? 'synced' : 'plain') + ' lines=' + r.lines.length);
  if (r.none) { send('lyrics', { key, none: true }); if (r.error) lyricsKey = ''; return; }
  send('lyrics', r);
}

function helperCmd(cmd) {
  const h = helper;
  if (!h || h.killed || h.exitCode !== null || !h.stdin || h.stdin.destroyed || !h.stdin.writable) return;
  try { h.stdin.write(cmd + '\n'); } catch {}
}

// иконка высокого разрешения (128 px) через помощника; null, если не вышло
const iconWaiters = new Map();
let iconSeq = 0;
function helperIcon(file) {
  if (!helper || !file || /[\r\n]/.test(file)) return Promise.resolve(null);
  const id = 'i' + (++iconSeq);
  return new Promise(res => {
    const t = setTimeout(() => { iconWaiters.delete(id); res(null); }, 4000);
    iconWaiters.set(id, d => { clearTimeout(t); res(d ? 'data:image/png;base64,' + d : null); });
    helperCmd(`icon ${id} ${file}`);
  });
}

function onHelper(msg) {
  switch (msg.type) {
    case 'media':
      state.media = msg.title ? msg : null;
      send('media', mediaPayload());
      updateLyrics();
      break;
    case 'art': {
      state.art = { [msg.key]: msg.data }; // храним только текущую
      send('media:art', { key: msg.key, data: msg.data });
      break;
    }
    case 'vol': state.vol = { v: +msg.v || 0, mute: !!msg.mute }; send('vol', { ...state.vol, ext: !!msg.ext }); break;
    case 'snip': setSnip(!!msg.on); break;
    case 'game': onGame(msg); break;
    case 'mic': state.mic = (msg.apps || []).filter(n => !assistant.isOwnMicUser(n)); send('mic', state.mic); break;
    case 'procs': state.procs = (msg.list || []).filter(p => p.n !== 'Idle' && p.n !== 'Memory Compression'); send('procs', state.procs); break;
    case 'clip': onClipboard(); break;
    case 'icon': { const w = iconWaiters.get(msg.id); if (w) { iconWaiters.delete(msg.id); w(msg.data); } break; }
    case 'paths': state.paths = msg; watchScreenshots(); break;
    case 'kbd': onKbd(msg); break;
    case 'meter': send('meter', { v: +msg.v || 0, m: +msg.m || 0, n: msg.n | 0 }); break;
  }
}

// ---- раскладка и Caps Lock: показываем, только если переключил сам пользователь
// (раскладка, сменившаяся вместе с активным окном, — не повод для уведомления)
// настоящий уровень голоса в Discord (Core Audio) — только пока кто-то говорит, выключаем после 2 с тишины
let meterOn = false, meterOffT = null;
function discordMeter(on) {
  if (on) { clearTimeout(meterOffT); meterOffT = null; if (!meterOn) { meterOn = true; helperCmd('meter on discord'); } return; }
  if (meterOn && !meterOffT) meterOffT = setTimeout(() => { meterOn = false; meterOffT = null; helperCmd('meter off'); }, 2000);
}

function onKbd(m) {
  const prev = state.kbd;
  state.kbd = { lang: m.lang, caps: !!m.caps, hwnd: m.hwnd };
  const s = store.get();
  let show = null;
  if (prev) {
    if (prev.caps !== state.kbd.caps && s.kbdCaps) show = 'caps';
    else if (prev.lang !== state.kbd.lang && prev.hwnd === state.kbd.hwnd && s.kbdLayout) show = 'lang';
  }
  send('kbd', { lang: state.kbd.lang, caps: state.kbd.caps, show });
}

// ---- уведомления Windows: переводим служебные подписи и отдаём острову
function sendMessage(n) {
  const l = store.get().language;
  n.app = I18N.t(n.app, l);
  if (n.i18nBody) n.body = I18N.t(n.body, l);
  if (n.title === 'Почта') n.title = I18N.t(n.title, l);
  n.duration = +store.get().winNotifyDuration || 5000;
  send('message', n);
}

// ---------------------------------------------------------------- system load
let lastCpu = null;
function cpuTimes(cpus) {
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
function tickSys() {
  const cpus = os.cpus();
  const now = cpuTimes(cpus);
  let cpu = 0;
  if (lastCpu) {
    const di = now.idle - lastCpu.idle, dt = now.total - lastCpu.total;
    cpu = dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
  }
  lastCpu = now;
  const total = os.totalmem(), free = os.freemem();
  const prev = state.sys;
  state.sys = { cpu: Math.round(cpu), memUsed: total - free, memTotal: total, cores: cpus.length, cpuName: (cpus[0] || {}).model || '' };
  // без изменений (CPU ±1%, память ±1%) — не шлём: острову не нужно перерисовываться каждую секунду
  if (prev && prev.cpu === state.sys.cpu && Math.abs(prev.memUsed - state.sys.memUsed) < total / 100) { state.sys = prev; return; }
  send('sys', state.sys);
}

// ---------------------------------------------------------------- notifications
let lastShotAt = 0, ownClipAt = 0;
let pendingImgTimer = null;

// уведомления переводятся на язык интерфейса
const I18N = require('./renderer/i18n');
function notify(n) {
  const l = store.get().language;
  n.title = I18N.t(n.title, l);
  if (n.i18nBody) n.body = I18N.t(n.body, l);
  if (typeof n.body === 'string') n.body = n.body.replace(/^сохранён/, I18N.t('сохранён', l)).replace(/^скопирован/, I18N.t('скопирован', l)).replace(/^уведомление острова$/, I18N.t('уведомление острова', l));
  send('notify', n);
}

function onClipboard() {
  const s = store.get();
  try {
    const fbuf = clipboard.readBuffer('FileNameW');
    if (fbuf && fbuf.length > 2) {
      if (!s.notifyFiles) return;
      const full = fbuf.toString('utf16le').split('\0')[0];
      const img = /\.(png|jpe?g|gif|bmp|webp)$/i.test(full) ? nativeImage.createFromPath(full) : null;
      notify({ icon: 'file', title: 'Файл', body: path.basename(full), thumb: img && !img.isEmpty() ? img.resize({ height: 96 }).toDataURL() : null, path: full });
      return;
    }
    const formats = clipboard.availableFormats();
    if (formats.some(f => f.startsWith('image/'))) {
      if (!s.notifyImage || Date.now() - ownClipAt < 2500) return; // свой снимок WaveScreen уже показан на острове
      const img = clipboard.readImage();
      if (img.isEmpty()) return;
      const clipAt = Date.now();
      const thumb = img.resize({ height: 96 }).toDataURL();
      const { width, height } = img.getSize();
      clearTimeout(pendingImgTimer);
      // ждём: возможно, это скриншот и сейчас появится файл
      pendingImgTimer = setTimeout(() => {
        if (lastShotAt > clipAt - 2500) return;
        notify({ icon: 'image', title: 'Изображение', body: `${width}×${height}`, thumb });
      }, 1100);
      return;
    }
    const text = clipboard.readText();
    if (text && text.trim()) {
      if (!s.notifyText) return;
      const one = text.replace(/\s+/g, ' ').trim();
      const isLink = /^https?:\/\/\S+$/i.test(one);
      let body = one;
      if (isLink) { try { body = new URL(one).hostname.replace(/^www\./, ''); } catch {} }
      notify({ icon: isLink ? 'link' : 'text', title: isLink ? 'Ссылка' : 'Скопировано', body: body.length > 40 ? body.slice(0, 40) + '…' : body });
    }
  } catch (e) { console.error('clipboard', e); }
}

const watchers = [];
const seenShots = new Set();
function watchScreenshots() {
  while (watchers.length) { try { watchers.pop().close(); } catch {} }
  const dirs = new Set();
  if (state.paths.screenshots) dirs.add(state.paths.screenshots);
  if (state.paths.pictures) dirs.add(path.join(state.paths.pictures, 'Screenshots'));
  dirs.add(path.join(app.getPath('pictures'), 'Screenshots'));
  dirs.add(path.join(os.homedir(), 'OneDrive', 'Pictures', 'Screenshots'));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, (ev, fname) => {
        if (!fname || !/\.(png|jpe?g)$/i.test(fname)) return;
        const full = path.join(dir, fname);
        if (seenShots.has(full)) return;
        setTimeout(() => onScreenshot(full, 0), 450);
      });
      watchers.push(w);
    } catch (e) { console.error('watch', dir, e.message); }
  }
}

function onScreenshot(full, attempt) {
  if (seenShots.has(full) || !fs.existsSync(full)) return;
  const img = nativeImage.createFromPath(full);
  if (img.isEmpty()) { if (attempt < 5) setTimeout(() => onScreenshot(full, attempt + 1), 400); return; }
  seenShots.add(full);
  lastShotAt = Date.now();
  clearTimeout(pendingImgTimer);
  if (!store.get().notifyScreenshots) return;
  const { width, height } = img.getSize();
  notify({ icon: 'screenshot', title: 'Скриншот', body: `сохранён · ${width}×${height}`, thumb: img.resize({ height: 120 }).toDataURL(), path: full });
}

// ---------------------------------------------------------------- settings / ipc
function applyAutostart() {
  const on = !!store.get().autostart;
  const opts = app.isPackaged
    ? { openAtLogin: on }
    : { openAtLogin: on, path: process.execPath, args: [path.resolve(__dirname)] };
  app.setLoginItemSettings(opts);
}

ipcMain.on('island:interactive', (e, on) => {
  if (island && e.sender === island.webContents) island.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on('island:context', e => { if (island && e.sender === island.webContents) openSettings(); });
ipcMain.on('preview:start', e => startPreview(e.sender));
ipcMain.on('preview:stop', () => stopPreview());
ipcMain.on('preview:mode', (_e, m) => { if (!preview) return; preview.mode = ['compact', 'expanded', 'notify', 'media'].includes(m) ? m : 'compact'; preview.win.webContents.send('preview:mode', preview.mode); });
// ---- горячие клавиши острова: громкость и раскрыть/свернуть
const ISLAND_KEYS = { hkVolUp: 'up', hkVolDown: 'down', hkVolMute: 'mute', hkIsland: 'island', hkTranslate: 'translate' };
const hkActive = new Map(); const hkFailed = new Set();
function registerIslandKeys() {
  for (const acc of hkActive.values()) { try { globalShortcut.unregister(acc); } catch {} }
  hkActive.clear(); hkFailed.clear();
  const s = store.get();
  for (const [k, act] of Object.entries(ISLAND_KEYS)) {
    const acc = String(s[k] || '').trim();
    if (!acc) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, () => (act === 'translate' ? translator.run() : send('island:key', act))); } catch {}
    if (ok) hkActive.set(k, acc); else hkFailed.add(k);
  }
}
ipcMain.on('vol:set', (e, v) => { if (!island || e.sender !== island.webContents) return; const x = +v; if (isFinite(x)) helperCmd('vol set ' + Math.max(0, Math.min(1, x)).toFixed(3)); });
ipcMain.on('vol:get', () => helperCmd('vol get'));
ipcMain.on('vol:mute', e => { if (island && e.sender === island.webContents) helperCmd('vol mute'); });
ipcMain.on('media:cmd', (_e, cmd) => { if (['playpause', 'next', 'prev'].includes(cmd)) helperCmd(cmd); });
// перемотка ползунком: секунды от начала трека
ipcMain.on('media:seek', (_e, sec) => { const v = +sec; if (isFinite(v) && v >= 0 && v < 86400) helperCmd('seek ' + v.toFixed(2)); });
ipcMain.on('notify:open', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p);
});
ipcMain.on('settings:open', () => openSettings());

// ---- задачи (to-do), таймер, фокус острова для ввода
const validZone = z => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };
ipcMain.handle('todo:op', (_e, o) => {
  let list = (store.get().todos || []).slice();
  const text = o && typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const i = o ? list.findIndex(t => t.id === o.id) : -1;
  switch (o && o.op) {
    case 'add': if (text && list.length < 100) list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false }); break;
    case 'toggle': if (i >= 0) list[i] = { ...list[i], done: !list[i].done }; break;
    case 'edit': if (i >= 0 && text) list[i] = { ...list[i], text }; break;
    case 'remove': if (i >= 0) list.splice(i, 1); break;
    case 'move': { const j = i + (o.dir > 0 ? 1 : -1); if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]]; break; }
    case 'clearDone': list = list.filter(t => !t.done); break;
    case 'get': return list;
    default: return list;
  }
  store.set({ todos: list });
  send('settings', islandSettings());
  sendSettings('todos', list);
  return list;
});
ipcMain.on('timer:cmd', (_e, c) => extras.timerCmd(c));
ipcMain.handle('timer:get', () => extras.timerView());
ipcMain.handle('time:sync', async () => { await extras.syncTime().catch(() => {}); return extras.getSync(); });
ipcMain.handle('time:get', () => extras.getSync());
ipcMain.on('island:focus', (e, on) => {
  if (!island || e.sender !== island.webContents) return;
  if (on) { island.setFocusable(true); island.focus(); island.webContents.focus(); }
  else { island.blur(); island.setFocusable(false); }
});

// ---- новости региона для ленты (раз в 30 минут; только если лента их показывает)
let newsTimer = null;
async function refreshNews() {
  const s = store.get();
  if (s.feedMode === 'off' || s.feedMode === 'memo') { state.news = []; send('news', []); return; }
  try {
    const r = await news.fetchNews(s.newsRegion);
    state.news = r.items;
    send('news', state.news);
    news.prefetchSummaries(state.news).catch(() => {});
    if (process.env.DI_DEBUG) console.log('news', r.region, r.source, r.items.length, JSON.stringify(r.items.slice(0, 2).map(i => i.title + ' | ' + i.link)));
  } catch (e) {
    console.error('news', e.message);
    // нет сети / всё недоступно — повторяем через 2 минуты, а не через полчаса
    clearTimeout(newsRetry); newsRetry = setTimeout(refreshNews, 2 * 60e3);
  }
}
let newsRetry = null;
function scheduleNews() { clearInterval(newsTimer); clearTimeout(newsRetry); refreshNews(); newsTimer = setInterval(refreshNews, 30 * 60e3); }
ipcMain.on('news:open', async (_e, i) => {
  const n = (state.news || [])[i];
  if (!n || !news.isNewsLink(n.link)) return;
  // если адрес статьи уже известен — открываем сразу издание, без промежуточной страницы Google
  let url = n.link;
  try { const s = await Promise.race([news.getSummary(n), new Promise(r => setTimeout(() => r(null), 1500))]); if (s && /^https?:\/\//i.test(s.url)) url = s.url; } catch {}
  shell.openExternal(url);
});
// краткий пересказ новости для карточки под островом
ipcMain.handle('news:summary', async (_e, i) => {
  const n = (state.news || [])[i];
  if (!n) return null;
  try { return await news.getSummary(n); } catch { return { title: n.title, source: n.source, summary: '' }; }
});
// ---- установленные шрифты Windows (один раз за запуск)
let fontsCache = null;
ipcMain.handle('fonts:list', () => {
  if (fontsCache) return fontsCache;
  return new Promise(res => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      fontsCache = err ? [] : [...new Set(String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      res(fontsCache);
    });
  });
});
ipcMain.handle('news:regions', () => ({ auto: news.regionCode('auto'), list: Object.entries(news.REGIONS).map(([k, v]) => ({ code: k, name: v.name })) }));

ipcMain.handle('settings:get', () => pro.effectiveSettings(store.publicView()));
ipcMain.handle('displays:get', () => [{ index: -1, label: 'Основной монитор' }].concat(
  screen.getAllDisplays().map((d, i) => ({ index: i, label: `Монитор ${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (основной)' : ''}` }))));
ipcMain.handle('discord:state', () => state.discord);
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = Object.keys(store.DEFAULTS).filter(k => !['discordToken', 'todos', 'pcStats', 'weatherLastLoc', 'smartLayout', 'windowBounds', 'tgSession', 'bannerChanged'].includes(k));
  if (patch && Array.isArray(patch.worldClocks)) patch.worldClocks = patch.worldClocks.filter(z => typeof z === 'string' && validZone(z)).slice(0, 3);
  const clean = {};
  for (const k of allowed) if (patch && k in patch) clean[k] = patch[k];
  if (!pro.active()) {
    if (pro.PAID_THEMES.includes(clean.theme)) { delete clean.theme; pro.open(); }
    if ('customTheme' in clean) { delete clean.customTheme; pro.open(); }
  }
  const prev = store.get();
  store.set(clean);
  if ('autostart' in clean) applyAutostart();
  if ('hideFromCapture' in clean) applyCaptureProtection();
  telegram.onSettings(clean);
  if ('winBannerOff' in clean || 'msgBelow' in clean || 'winNotify' in clean || 'winNotifyApps' in clean) winnotify.resyncBanners();
  if ('lyricsEnabled' in clean) { lyricsKey = ''; updateLyrics(); }
  if ('display' in clean || 'offsetY' in clean || 'offsetX' in clean || 'uiScale' in clean || 'islandExpW' in clean || 'islandExpH' in clean) placeIsland();
  sendPreviewSettings();
  if ('windowZoom' in clean) applyWindowZoom();
  if ('wsHotkey' in clean) waveScreen.registerHotkey();
  if (['hkVolUp', 'hkVolDown', 'hkVolMute', 'hkIsland', 'hkTranslate'].some(k => k in clean)) registerIslandKeys();
  if ('volKeysPill' in clean) helperCmd(clean.volKeysPill !== false ? 'volwatch on' : 'volwatch off');
  if ('feedMode' in clean || 'newsRegion' in clean) scheduleNews();
  if ('timeSync' in clean) extras.syncTime().catch(() => {});
  if ('weatherCity' in clean || 'weatherUnits' in clean || 'language' in clean
    || ('pageWeather' in clean && clean.pageWeather) || ('weatherCompact' in clean && clean.weatherCompact)) weather.reset();
  if (clean.winNotifyApps) store.set({ winNotifyApps: { ...prev.winNotifyApps, ...clean.winNotifyApps } });
  if ((clean.discordClientId !== undefined && clean.discordClientId !== prev.discordClientId) ||
      (clean.discordClientSecret !== undefined && clean.discordClientSecret !== prev.discordClientSecret)) {
    store.set({ discordToken: null });
  }
  if ('discordEnabled' in clean && !clean.discordEnabled) discord.stop();
  let hotkeyOk = true;
  if ('assistantEnabled' in clean || 'hotkey' in clean) hotkeyOk = assistant.apply();
  assistant.onSettings(clean);
  send('settings', islandSettings());
  return { ...pro.effectiveSettings(store.publicView()), hotkeyOk, hkFailed: [...hkFailed], wsHotkeyOk: waveScreen.hotkeyActive() === store.get().wsHotkey };
});
// ---- мастер первого запуска и подключение Discord в один клик
let onboardWin = null;
function openOnboarding() {
  if (onboardWin && !onboardWin.isDestroyed()) { onboardWin.focus(); return; }
  onboardWin = new BrowserWindow({
    width: 480, height: 400, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    skipTaskbar: false, alwaysOnTop: true, show: false, title: 'Dynamic Wave',
    icon: nativeImage.createFromBuffer(png(64)),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  onboardWin.loadFile(path.join(__dirname, 'renderer', 'onboard.html'));
  onboardWin.once('ready-to-show', () => onboardWin.show());
  onboardWin.on('closed', () => { onboardWin = null; });
}
function connectBuiltin() {
  store.set({ discordEnabled: true, discordMode: 'builtin', onboarded: true });
  discord.restart();
  send('settings', islandSettings());
}
ipcMain.handle('onboard:connect', () => { connectBuiltin(); return true; });
ipcMain.on('onboard:close', () => { store.set({ onboarded: true }); if (onboardWin) onboardWin.close(); });
ipcMain.handle('discord:builtin', () => DiscordVoice.hasBuiltin());
ipcMain.handle('discord:quick', () => { connectBuiltin(); return pro.effectiveSettings(store.publicView()); });

ipcMain.handle('discord:connect', () => {
  store.set({ discordEnabled: true, discordMode: 'own' });   // ручное подключение — своим приложением (Client ID + Secret)
  discord.restart();
  send('settings', islandSettings());
  return true;
});
ipcMain.handle('discord:logout', () => {
  store.set({ discordToken: null, discordEnabled: false });
  discord.stop();
  send('settings', islandSettings());
  return true;
});
ipcMain.handle('notify:test', () => {
  notify({ icon: 'text', title: 'Тест', body: 'уведомление острова' });
  return true;
});
// ---- уведомления Windows и погода
ipcMain.on('message:open', (_e, proc) => { if (typeof proc === 'string' && /^[\w .-]{1,40}$/.test(proc)) helperCmd(`proc front ${proc}`); });
ipcMain.handle('winnotify:status', () => winnotify.status());
ipcMain.handle('message:test', (_e, kind) => {
  const k = ['telegram', 'discord', 'mail'].includes(kind) ? kind : 'telegram';
  const demo = {
    telegram: { app: 'Telegram', color: '#2aabee', title: 'Аня', body: 'Ты сегодня будешь вечером? Скинь, во сколько освободишься 🙂' },
    discord: { app: 'Discord', color: '#5865f2', title: 'Макс (#general)', body: 'Заходи в голосовой, все уже тут' },
    mail: { app: 'Почта', color: '#0a84ff', title: 'GitHub', body: 'Your pull request was merged' },
  }[k];
  sendMessage({ kind: k, proc: '', thumb: null, at: Date.now(), ...demo });
  return true;
});
// ---- Wave correction
let smartLayoutWin = null;
function openSmartLayout() {
  if (smartLayoutWin && !smartLayoutWin.isDestroyed()) { smartLayoutWin.show(); smartLayoutWin.focus(); return; }
  smartLayoutWin = appWindow('waveCorrection', { width: 760, height: 780, minWidth: 620, minHeight: 520, title: 'Wave correction — Dynamic Wave', backgroundColor: '#121212', titleBarOverlay: { color: '#121212', symbolColor: '#ffffff', height: 40 } });
  smartLayoutWin.loadFile(path.join(__dirname, 'renderer', 'smartlayout.html'));
  smartLayoutWin.on('closed', () => { smartLayoutWin = null; });
  if (process.env.DI_DEBUG) smartLayoutWin.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (!smartLayoutWin) return;
    if (process.env.DI_DEBUG_SL_JS) console.log('sl-js', JSON.stringify(await smartLayoutWin.webContents.executeJavaScript(process.env.DI_DEBUG_SL_JS).catch(e => 'ERR ' + e.message)));
    await new Promise(r => setTimeout(r, 700));
    fs.writeFileSync(process.env.DI_DEBUG.replace('.png', '-smartlayout.png'), (await smartLayoutWin.webContents.capturePage()).toPNG());
  }, 1500));
}
const sendSmartLayoutWin = (ch, d) => { if (smartLayoutWin && !smartLayoutWin.isDestroyed()) smartLayoutWin.webContents.send(ch, d); };
ipcMain.on('sl:open', () => openSmartLayout());
ipcMain.on('layout:act', (_e, a) => { if (a && typeof a === 'object') smartLayout.act({ id: a.id, act: String(a.act || '') }); });
ipcMain.handle('sl:get', () => ({ ...smartLayout.view(), language: store.get().language, accentColor: store.get().accentColor }));
ipcMain.handle('sl:set', (_e, patch) => smartLayout.set(patch));
ipcMain.handle('sl:reset', () => smartLayout.reset(store.SMART_LAYOUT_DEFAULTS()));
ipcMain.handle('sl:clear-history', () => smartLayout.clearHistory());
ipcMain.handle('sl:preview', () => { smartLayout.preview(); return true; });
ipcMain.handle('sl:analyze', (_e, text) => { // проверка в окне настроек: ничего не сохраняется
  if (typeof text !== 'string' || text.length > 300) return null;
  const s = store.get().smartLayout;
  const e = smartLayout.ensureEngine();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out = [];
  words.forEach((w, i) => { const r = e.analyze(w, { prev: words.slice(Math.max(0, i - 3), i), dirs: { enRu: s.enRu, ruEn: s.ruEn }, minConfidence: s.minConfidence }); const c = r.suggestion || r.candidate; out.push({ word: w, replacement: c ? c.replacement : null, confidence: c ? c.confidence : 0, level: r.suggestion ? r.suggestion.level : null, reason: r.reason || '' }); });
  return out;
});
ipcMain.handle('weather:get', () => weather.get());
ipcMain.handle('weather:refresh', async () => { weather.reset(); return true; });

// ---------------------------------------------------------------- tray
// светлая ли панель задач (тогда в трее тёмный логотип)
function lightTaskbar() {
  try {
    const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'], { windowsHide: true, encoding: 'utf8' });
    return /0x1\b/.test(out);
  } catch { return false; }
}
function trayImage() {
  // логотип в нескольких размерах: Windows берёт точный под свой масштаб (100–300%), без растягивания
  const light = lightTaskbar();
  const img = nativeImage.createEmpty();
  for (const [sf, px] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [2.5, 40], [3, 48]]) {
    img.addRepresentation({ scaleFactor: sf, width: px, height: px, buffer: trayPng(px, light) });
  }
  return img;
}
function createTray() {
  tray = new Tray(trayImage());
  require('electron').nativeTheme.on('updated', () => { if (tray && !tray.isDestroyed()) tray.setImage(trayImage()); });
  tray.setToolTip('Dynamic Wave');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Настройки', click: openSettings },
    { label: 'WaveScreen — снимок экрана', click: () => setTimeout(() => waveScreen.capture(), 200) },
    { label: 'Wave correction', click: openSmartLayout },
    { label: 'Проверить обновления', click: () => { openSettings(); setTimeout(() => updater.check(false), 600); } },
    { label: 'Показать / скрыть остров', click: () => { if (!island) return; hiddenByUser = island.isVisible(); hiddenByUser ? island.hide() : island.showInactive(); } },
    { type: 'separator' },
    { label: 'Перезапустить', click: () => { app.relaunch(); quitting = true; app.quit(); } },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', openSettings);
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  require('electron').powerMonitor.on('shutdown', () => store.flush());
  app.setAppUserModelId('DynamicWave');
  // настоящий звук для визуализации на острове: захват системного вывода (loopback), без микрофона
  require('electron').session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const { desktopCapturer } = require('electron');
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then(src => cb(src[0] ? { video: src[0], audio: 'loopback' } : {}))
      .catch(() => cb({}));
  });
  store.get();
  pro.init();
  if (!pro.active()) setTimeout(() => pro.open(), 1500);
  setInterval(() => send('settings', islandSettings()), 60000);
  createIsland();
  createTray();
  startHelper();
  watchScreenshots();
  tickSys();
  setInterval(tickSys, 1000);
  extras.init({ send, sendSettings, notify, store, mediaPlaying: () => !!(state.media && state.media.status === 'Playing') });
  extrasReady = true;
  weather.init({ send, sendSettings, store });
  registerIslandKeys(); // горячие клавиши острова: громкость и раскрыть/свернуть
  updater.init({ store, sendSettings, notify }); // обновления с Google Диска
  translator.init({ helperCmd, send, notify, island: () => island, markOwnClipboard: () => { ownClipAt = Date.now(); } }); // перевод выделенного
  waveScreen.init({ store, notify, island: () => island, hideIsland: on => { wsHide = on; applyOpacity(); }, markOwnClipboard: () => { ownClipAt = Date.now(); } });
  winnotify.init({ store, sendMessage, tgActive: () => telegram.active() }).catch(e => console.error('winnotify', e.message));
  telegram.init({ store, sendMessage, sendSettings, island: () => island });
  try {
    smartLayout.init({
      store, send, notify, clipboard, globalShortcut: require('electron').globalShortcut,
      sendSettings: (ch, d) => { sendSettings(ch, d); sendSmartLayoutWin(ch, d); },
      otherHotkeys: () => (store.get().assistantEnabled ? [store.get().hotkey] : []),
    });
  } catch (e) { console.error('smartlayout', e.message); }

  discord = new DiscordVoice(store);
  discord.on('state', st => {
    state.discord = st; send('discord', st); sendSettings('discord', st);
    discordMeter(!!(st && st.status === 'ready' && st.speaking && st.speaking.length));
    if (onboardWin && !onboardWin.isDestroyed()) onboardWin.webContents.send('discord', st);
  });
  discord.start();
  // мастер первого запуска: если в сборке есть встроенное приложение Discord и Discord ещё не подключён
  const s0 = store.get();
  if ((!s0.onboarded && DiscordVoice.hasBuiltin() && !s0.discordEnabled) || (process.env.DI_DEBUG && process.env.DI_FORCE_ONBOARD)) setTimeout(openOnboarding, 2500);

  assistant.init({ store, sendIsland: send, sendSettings, helperCmd, helperIcon, waveScreen: () => waveScreen.capture() });
  setTimeout(scheduleNews, 4000);

  screen.on('display-metrics-changed', placeIsland);
  screen.on('display-added', placeIsland);
  screen.on('display-removed', placeIsland);
});

app.on('second-instance', openSettings);
app.on('will-quit', () => { store.flush(); try { require('electron').globalShortcut.unregisterAll(); } catch {} });

let quitReady = false;
app.on('before-quit', e => {
  quitting = true;
  // если остров закрывают посреди голосовой команды — сначала отпускаем «Приглушение по нажатию» в Discord,
  // даём помощнику 400 мс это выполнить, и только потом его завершаем
  if (!quitReady && assistant.isMuteHeld && assistant.isMuteHeld() && helper) {
    e.preventDefault();
    quitReady = true;
    helperCmd(`up ${store.get().discordMuteKey}`);
    setTimeout(() => app.quit(), 400);
    return;
  }
  const h = helper; helper = null;
  if (h) { try { h.stdin.end(); } catch {} try { h.kill(); } catch {} }
  smartLayout.shutdown();
});
app.on('window-all-closed', e => { if (!quitting) e.preventDefault(); });
