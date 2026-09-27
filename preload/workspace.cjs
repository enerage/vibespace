'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vs', {
  kind: 'workspace',
  getWorkspace: (id) => ipcRenderer.invoke('ws:get', id),
  loadState: (id) => ipcRenderer.invoke('state:load', id),
  saveState: (id, state) => ipcRenderer.invoke('state:save', id, state),

  fsList: (dir) => ipcRenderer.invoke('fs:list', dir),
  fsFileIndex: (repoPath) => ipcRenderer.invoke('fs:fileIndex', repoPath),
  gitStatus: (repoPath) => ipcRenderer.invoke('git:status', repoPath),
  fsRead: (file) => ipcRenderer.invoke('fs:read', file),
  fsWrite: (file, content) => ipcRenderer.invoke('fs:write', file, content),
  reveal: (file) => ipcRenderer.invoke('fs:reveal', file),

  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyList: () => ipcRenderer.invoke('pty:list'),
  ptyWrite: (termId, data) => ipcRenderer.send('pty:write', termId, data),
  ptyResize: (termId, cols, rows) => ipcRenderer.send('pty:resize', termId, cols, rows),
  ptyKill: (termId) => ipcRenderer.send('pty:kill', termId),
  claudeStarted: (wsId, termId) => ipcRenderer.send('pty:claudeStarted', wsId, termId),
  sessionPinned: (wsId, termId, sessionId) => ipcRenderer.send('pty:sessionPinned', wsId, termId, sessionId),
  sessionCheck: (wsId, sessionId) => ipcRenderer.invoke('sessions:check', wsId, sessionId),

  restartAll: (wsId) => ipcRenderer.invoke('updater:restartAll', wsId),
  appRestart: () => ipcRenderer.invoke('app:restart'),
  ptyBusy: () => ipcRenderer.invoke('pty:busy'),
  claudeVersion: () => ipcRenderer.invoke('util:claudeVersion'),
  openLogs: () => ipcRenderer.invoke('util:openLogs'),
  pickLogo: () => ipcRenderer.invoke('dialog:pickLogo'),
  updateLogo: (id, logoPath) => ipcRenderer.invoke('ws:updateLogo', id, logoPath),
  writeClipboard: (text) => ipcRenderer.invoke('util:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('util:readClipboard'),
  copyDiagnostics: (wsId) => ipcRenderer.invoke('util:copyDiagnostics', wsId),

  onPtyData: (cb) => ipcRenderer.on('pty:data', (e, termId, chunk) => cb(termId, chunk)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (e, termId) => cb(termId)),
  onSessionFound: (cb) => ipcRenderer.on('session:found', (e, termId, sessionId) => cb(termId, sessionId)),
  onTermStatus: (cb) => ipcRenderer.on('term:status', (e, termId, st) => cb(termId, st)),
  onTermFocus: (cb) => ipcRenderer.on('term:focus', (e, termId) => cb(termId)),
  onUpdaterStage: (cb) => ipcRenderer.on('updater:stage', (e, stage) => cb(stage)),
  onUpdaterLine: (cb) => ipcRenderer.on('updater:line', (e, line) => cb(line)),
  onUpdaterDone: (cb) => ipcRenderer.on('updater:done', (e, info) => cb(info)),
  onUpdaterState: (cb) => ipcRenderer.on('updater:state', (e, state) => cb(state)),
  onAppUpdateAvailable: (cb) => ipcRenderer.on('app:updateAvailable', (e, info) => cb(info)),
});
