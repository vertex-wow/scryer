const os = require('os');
const path = require('path');
const fs = require('fs');

const id = 'vertex-wow.wow-scryer';
const dirs = [
  // vscode
  path.join(os.homedir(), '.vscode-server', 'data', 'User', 'globalStorage', id),
  // antigravity
  path.join(os.homedir(), '.antigravity-ide-server', 'data', 'User', 'globalStorage', id),
  path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', id),
  path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', id)
];

const found = dirs.filter(d => fs.existsSync(d));

if (found.length) {
  found.forEach(d => {
    fs.rmSync(d, { recursive: true, force: true });
    console.log('Cleared: ' + d);
  });
} else {
  console.log('Global cache not found (already clean or non-standard path).');
}
