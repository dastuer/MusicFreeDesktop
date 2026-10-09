/** electron-builder 的 afterPack 要求文件路径而不是可导入函数，这里做个壳 */
const { adHocSignAfterPack } = require("electron-sparkle-updater/builder");
module.exports = adHocSignAfterPack;
