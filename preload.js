const { contextBridge } = require('electron');

// C1 脚手架：先暴露平台信息；C6 再补 loadBoard / saveBoard / chooseVaultDir
contextBridge.exposeInMainWorld('cardwall', {
  platform: process.platform
});
