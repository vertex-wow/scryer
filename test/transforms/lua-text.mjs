/** Jest transformer: import *.lua files as plain strings (mirrors esbuild text loader). */
export default {
  process(sourceText) {
    return { code: `module.exports = ${JSON.stringify(sourceText)};` };
  },
};
