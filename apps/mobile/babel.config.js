// Metro uses babel-preset-expo implicitly; jest (babel-jest) needs it spelled out.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
