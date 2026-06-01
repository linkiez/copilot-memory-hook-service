#!/usr/bin/env node

const chunks = [];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const payload = JSON.parse(chunks.join(''));
  process.stdout.write(JSON.stringify({
    content: `treated::${payload.content}`,
    metadata: {
      instruction: payload.instruction,
      processor: process.argv[0] ? 'node' : 'unknown'
    }
  }));
});
