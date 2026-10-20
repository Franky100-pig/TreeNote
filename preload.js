const { contextBridge, ipcRenderer } = require('electron');

// Renderer <-> main bridge. The renderer never touches the filesystem; it
// only asks the main process to load or save the board.
contextBridge.exposeInMainWorld('cardwall', {
  platform: process.platform,
  loadBoard: () => ipcRenderer.invoke('board:load'),
  saveBoard: (board) => ipcRenderer.invoke('board:save', board)
});
