const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setZoomFactor: (factor) => {
    try { webFrame.setZoomFactor(Number(factor) || 1); } catch (_) {}
  },
  getZoomFactor: () => {
    try { return webFrame.getZoomFactor(); } catch (_) { return 1; }
  },
  setPortrait: (on) => ipcRenderer.invoke('window:setPortrait', { on: !!on }),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  chooseImage: () => ipcRenderer.invoke('dialog:chooseImage'),
  scanFolder: (folderPath) => ipcRenderer.invoke('music:scanFolder', folderPath),
  fileExists: (filePath) => ipcRenderer.invoke('music:fileExists', filePath),
  parseMetadata: (filePath) => ipcRenderer.invoke('music:parseMetadata', filePath),
  loadCoverCache: (paths) => ipcRenderer.invoke('covers:load', paths),
  readAudioFile: (filePath) => ipcRenderer.invoke('audio:readFile', filePath),
  trimAudio: (payload) => ipcRenderer.invoke('audio:trim', payload),
  writeMetadata: (filePath, tags) => ipcRenderer.invoke('music:writeMetadata', { filePath, tags }),
  writeCover: (filePath, cover) => ipcRenderer.invoke('music:writeCover', { filePath, cover }),
  revealInFolder: (filePath) => ipcRenderer.invoke('shell:revealInFolder', filePath),
  deleteFile: (filePath) => ipcRenderer.invoke('shell:deleteFile', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getBuildInfo: () => ipcRenderer.invoke('app:getBuildInfo'),
  getHardwareAcceleration: () => ipcRenderer.invoke('app:getHardwareAcceleration'),
  setHardwareAcceleration: (enabled) => ipcRenderer.invoke('app:setHardwareAcceleration', !!enabled),
  openLogsFolder: () => ipcRenderer.invoke('shell:openLogsFolder'),
  logError: (where, message) => ipcRenderer.invoke('renderer:logError', { where, message }),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateDownloadProgress: (cb) => {
    const listener = (_e, pct) => cb(pct);
    ipcRenderer.on('update:downloadProgress', listener);
    return () => ipcRenderer.removeListener('update:downloadProgress', listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('update:downloaded', listener);
    return () => ipcRenderer.removeListener('update:downloaded', listener);
  },
  ytSearch: (query, count) => ipcRenderer.invoke('downloads:ytSearch', query, count),
  ytDownload: (payload) => ipcRenderer.invoke('downloads:ytDownload', payload),
  ytDownloadByQuery: (payload) => ipcRenderer.invoke('downloads:ytDownloadByQuery', payload),
  onYtDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('downloads:ytProgress', listener);
    return () => ipcRenderer.removeListener('downloads:ytProgress', listener);
  },
  getDownloadsDir: (targetDir) => ipcRenderer.invoke('downloads:getDir', { targetDir }),
  ytMusicParse: (payload) => ipcRenderer.invoke('downloads:ytMusicParse', payload),
  ytmSearchArtists: (query) => ipcRenderer.invoke('ytm:searchArtists', query),
  ytmArtistReleases: (browseId) => ipcRenderer.invoke('ytm:artistReleases', browseId),
  ytmAlbumTracks: (browseId) => ipcRenderer.invoke('ytm:albumTracks', browseId),
  spotifyParse: (payload) => ipcRenderer.invoke('spotify:parsePlaylist', payload),
  youtubeLogin: () => ipcRenderer.invoke('youtube:login'),
  youtubeLogout: () => ipcRenderer.invoke('youtube:logout'),
  youtubeCookiesStatus: () => ipcRenderer.invoke('youtube:cookiesStatus'),
  youtubePremiumStatus: () => ipcRenderer.invoke('youtube:premiumStatus'),
  onSpotifyParseProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('spotify:parseProgress', listener);
    return () => ipcRenderer.removeListener('spotify:parseProgress', listener);
  },
  discordConnect: (clientId) => ipcRenderer.invoke('discord:connect', { clientId }),
  discordDisconnect: () => ipcRenderer.invoke('discord:disconnect'),
  discordSetActivity: (activity) => ipcRenderer.invoke('discord:setActivity', { activity }),
  discordGetStatus: () => ipcRenderer.invoke('discord:getStatus'),
  lookupCover: (query) => ipcRenderer.invoke('music:lookupCover', query),
  lookupLyrics: (query) => ipcRenderer.invoke('music:lookupLyrics', query),
  identifyTrack: (filePath, apiKey) => ipcRenderer.invoke('acoustid:identify', { filePath, apiKey }),
  onDiscordStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('discord:status', listener);
    return () => ipcRenderer.removeListener('discord:status', listener);
  },
  updateTrayState: (state) => ipcRenderer.invoke('tray:updateState', state),
  onTrayCommand: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('tray:command', listener);
    return () => ipcRenderer.removeListener('tray:command', listener);
  },
  trendingFetch: (region) => ipcRenderer.invoke('trending:fetch', { region }),
  pickBackground: () => ipcRenderer.invoke('appearance:pickBackground'),
  clearBackground: () => ipcRenderer.invoke('appearance:clearBackground'),
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  lanSetConfig: (next) => ipcRenderer.invoke('lan:setConfig', next),
  lanPublish: (snapshot) => ipcRenderer.invoke('lan:publish', snapshot),
  lanAddPeer: (addr) => ipcRenderer.invoke('lan:addPeer', addr),
  lanRemovePeer: (id) => ipcRenderer.invoke('lan:removePeer', id),
  lanWsRequest: (deviceId, route, body) => ipcRenderer.invoke('lan:wsRequest', deviceId, route, body),
  lanDownloadTrack: (payload) => ipcRenderer.invoke('lan:downloadTrack', payload),
  onLanPeers: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('lan:peers', listener);
    return () => ipcRenderer.removeListener('lan:peers', listener);
  },
  onLanCommand: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('lan:command', listener);
    return () => ipcRenderer.removeListener('lan:command', listener);
  },
  registerGlobalHotkeys: (list) => ipcRenderer.invoke('hotkeys:registerGlobal', list),
  onGlobalHotkey: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('hotkeys:trigger', listener);
    return () => ipcRenderer.removeListener('hotkeys:trigger', listener);
  },
});
