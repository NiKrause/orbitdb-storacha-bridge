#!/usr/bin/env node
/**
 * Convert Pino logger format to libp2p logger format
 * 
 * Converts:
 * - logger.info({ key: value }, "message") => logger.info("message: %o", { key: value })
 * - logger.info({ key: value, key2: value2 }, "message") => logger.info("message: %o", { key: value, key2: value2 })
 * - Keeps simple string messages as-is
 */

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

function convertLoggerCall(content) {
  // Pattern: logger.level({ object }, "message")
  // Convert to: logger.level("message: %o", { object })
  const pattern = /(logger\.(info|debug|warn|error|trace))\(\s*\{([^}]+)\}\s*,\s*("[^"]*"|'[^']*'|`[^`]*`)\s*\)/g;
  
  return content.replace(pattern, (match, loggerCall, level, objectContent, message) => {
    // Clean up the message (remove quotes)
    let cleanMessage = message.slice(1, -1);
    
    // If message has placeholders, keep it as-is
    if (cleanMessage.includes('$')) {
      return match;
    }
    
    // Add %o placeholder if message doesn't end with data indicator
    if (cleanMessage && !cleanMessage.match(/[:]\s*$/)) {
      cleanMessage += ': %o';
    } else if (cleanMessage.match(/[:]\s*$/)) {
      cleanMessage += ' %o';
    } else {
      cleanMessage = '%o';
    }
    
    // Reconstruct
    return `${loggerCall}("${cleanMessage}", {${objectContent}})`;
  });
}

function convertFile(filePath) {
  console.log(`Processing: ${filePath}`);
  
  let content = readFileSync(filePath, 'utf8');
  const original = content;
  
  content = convertLoggerCall(content);
  
  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ Updated`);
    return true;
  } else {
    console.log(`  - No changes needed`);
    return false;
  }
}

async function main() {
  const patterns = [
    'lib/**/*.js',
    'examples/**/*.js',
    'test/**/*.js',
    'src/**/*.js',
    'src/**/*.svelte',
    '!node_modules/**',
    '!examples/svelte/*/node_modules/**',
    '!examples/svelte/*/build/**',
    '!examples/svelte/*/dist/**',
  ];
  
  console.log('Finding files to convert...\n');
  
  const files = await glob(patterns, { ignore: ['node_modules/**', '**/node_modules/**', '**/build/**', '**/dist/**'] });
  
  console.log(`Found ${files.length} files\n`);
  
  let updatedCount = 0;
  
  for (const file of files) {
    if (convertFile(file)) {
      updatedCount++;
    }
  }
  
  console.log(`\n✓ Conversion complete: ${updatedCount} files updated`);
}

main().catch(console.error);
