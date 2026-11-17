// Sandboxed preload: Presage's bridge (MessagePort to the main-process SDK) plus a narrow STEADY API.
import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
contextBridge.exposeInMainWorld('steady', {
  config: call('steady:config'),
  getSettings: call('steady:settings:get'),
  setSettings: call('steady:settings:set'),
  recOpen: call('steady:rec:open'),
  recAppend: call('steady:rec:append'),
  saveSession: call('steady:session:save'),
  listSessions: call('steady:session:list'),
  deleteAll: call('steady:data:deleteAll'),
  replayList: call('steady:replay:list'),
  replayRead: call('steady:replay:read'),
  log: call('steady:log'),
});
