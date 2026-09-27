'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vs', {
  kind: 'launcher',
  listWorkspaces: () => ipcRenderer.invoke('launcher:list'),
  createWorkspace: (opts) => ipcRenderer.invoke('launcher:create', opts),
  removeWorkspace: (id) => ipcRenderer.invoke('launcher:remove', id),
  pickRepo: () => ipcRenderer.invoke('dialog:pickRepo'),
  pickLogo: () => ipcRenderer.invoke('dialog:pickLogo'),
  openWorkspace: (id) => ipcRenderer.invoke('app:openWorkspace', id),
  createShortcut: (id) => ipcRenderer.invoke('sc:create', id),
  contextMenu: (action) => ipcRenderer.invoke('sc:contextMenu', action),
  createLauncherShortcut: () => ipcRenderer.invoke('sc:launcherShortcut'),
  updateLogo: (id, logoPath) => ipcRenderer.invoke('ws:updateLogo', id, logoPath),
  claudeVersion: () => ipcRenderer.invoke('util:claudeVersion'),
  openLogs: () => ipcRenderer.invoke('util:openLogs'),
  imageDataUrl: (p) => ipcRenderer.invoke('util:imageDataUrl', p),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
});
