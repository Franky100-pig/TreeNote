const { contextBridge, ipcRenderer } = require('electron');

// Renderer <-> main bridge. The renderer never touches the filesystem; it only
// asks the main process about the board library and the current board.
contextBridge.exposeInMainWorld('cardwall', {
  platform: process.platform,
  listBoards: () => ipcRenderer.invoke('boards:list'),
  createBoard: (name) => ipcRenderer.invoke('boards:create', name),
  openBoard: (id) => ipcRenderer.invoke('boards:open', id),
  saveBoard: (id, board) => ipcRenderer.invoke('boards:save', id, board),
  renameBoard: (id, name) => ipcRenderer.invoke('boards:rename', id, name),
  deleteBoard: (id) => ipcRenderer.invoke('boards:delete', id),
  // Favourite / pin: floats a board to the top of the library.
  pinBoard: (id, pinned) => ipcRenderer.invoke('boards:pin', id, pinned),
  // Desktop only: the web bridge exposes neither, and the renderer skips the
  // whole restore path when they are absent.
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (session) => ipcRenderer.invoke('session:save', session)
});
