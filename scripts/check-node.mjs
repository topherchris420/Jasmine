// Runs before `npm start` and `npm run serve`. It sticks to syntax that old Node versions parse, so someone on an
// outdated Node gets one plain sentence instead of an unknown ".ts" file extension error from src/api/server.ts.
const version = process.versions.node;
if (Number(version.split('.')[0]) < 24) {
  console.error(`Jasmine needs Node.js 24 or newer, and this is Node.js ${version}.`);
  console.error('Install the current LTS from https://nodejs.org (or run "nvm install 24"), then run npm start again.');
  process.exit(1);
}
