// HTTP is enabled only for the local USB demo build profile.
module.exports = ({ config }) => ({
  ...config,
  name: process.env.ALLOW_LOCAL_DEMO_HTTP === '1' ? 'Facts Pay Demo' : config.name,
  plugins: [
    ...(config.plugins || []).filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) !== 'expo-build-properties'),
    ['expo-build-properties', { android: { usesCleartextTraffic: process.env.ALLOW_LOCAL_DEMO_HTTP === '1' } }],
  ],
});
