const { contextBridge, ipcRenderer } = require('electron');

const ON = ['settings', 'media', 'mic', 'sys', 'procs', 'discord', 'notify',
  'assistant', 'assistant-level', 'news', 'asr:status', 'tts:progress',
  'asr:load', 'asr:reset', 'asr:restart', 'asr:grammar', 'setup:progress', 'asr:devices', 'tts:play', 'tts:reload', 'timer', 'pc', 'time:offset', 'todos', 'weather', 'kbd', 'message', 'layout', 'sl:history', 'ws:reset', 'meter', 'preview:mode', 'sizes:frame', 'lyrics', 'tg:status', 'media:art', 'vol', 'island:key', 'upd:status', 'translate', 'island:reveal'];
const SEND = ['island:interactive', 'island:context', 'media:cmd', 'notify:open', 'settings:open',
  'asr:status', 'asr:final', 'asr:partial', 'asr:level', 'asr:devices', 'tts:log', 'news:open', 'onboard:close', 'setup:launch', 'setup:close', 'setup:minimize', 'timer:cmd', 'island:focus', 'message:open', 'layout:act', 'sl:open', 'ws:cancel', 'ws:ready', 'ws:active', 'ws:shot', 'media:seek', 'vol:set', 'vol:get', 'vol:mute', 'tr:act', 'tr:resize', 'preview:start', 'preview:stop', 'preview:mode'];
const INVOKE = ['pro:status', 'pro:open', 'pro:close', 'pro:buy', 'settings:get', 'settings:set', 'displays:get', 'discord:connect', 'discord:logout', 'discord:state', 'notify:test',
  'asr:model', 'tts:get', 'asr:getStatus', 'asr:download', 'assistant:apply', 'assistant:test', 'assistant:listen', 'assistant:builtins', 'assistant:icons', 'asr:config', 'asr:getDevices', 'assistant:sendMuteKey', 'news:regions', 'fonts:list', 'news:summary', 'onboard:connect', 'discord:builtin', 'discord:quick', 'setup:info', 'setup:install', 'setup:uninstall', 'setup:pick-dir',
  'apps:startMenu', 'apps:pick', 'tts:status', 'tts:generate', 'todo:op', 'timer:get', 'time:sync', 'time:get', 'winnotify:status', 'message:test', 'weather:get', 'weather:refresh', 'sl:get', 'sl:set', 'sl:reset', 'sl:clear-history', 'sl:preview', 'sl:analyze', 'ws:frame', 'ws:done', 'ws:info', 'ws:pick-folder', 'tg:status', 'tg:login', 'tg:code', 'tg:password', 'tg:logout', 'tg:reply', 'tg:retry', 'tg:resend', 'upd:status', 'upd:check', 'upd:download', 'upd:install'];

contextBridge.exposeInMainWorld('islandAPI', {
  on: (ch, cb) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.includes(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked'))),
});
