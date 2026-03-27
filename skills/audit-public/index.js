#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

// Get the directory of this script
const skillDir = __dirname;
const auditScript = path.join(skillDir, 'audit');

// Parse arguments
const args = process.argv.slice(2);

// Spawn the audit script
const child = spawn('node', [auditScript, ...args], {
    stdio: 'inherit',
    cwd: process.cwd()
});

child.on('exit', (code) => {
    process.exit(code);
});

child.on('error', (error) => {
    console.error('Failed to start audit script:', error);
    process.exit(1);
});