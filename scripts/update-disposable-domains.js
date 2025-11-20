#!/usr/bin/env node
/**
 * Update disposable domains list from public sources
 * Usage: node scripts/update-disposable-domains.js
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const SOURCES = [
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf'
];

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'disposable-domains.json');

async function fetchDomains(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const domains = data
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .filter(domain => domain.includes('.'));
        resolve(domains);
      });
    }).on('error', reject);
  });
}

async function updateDomains() {
  console.log('Fetching disposable domains from public sources...');
  
  const allDomains = new Set();
  
  for (const source of SOURCES) {
    try {
      console.log(`Fetching from: ${source}`);
      const domains = await fetchDomains(source);
      domains.forEach(d => allDomains.add(d.toLowerCase()));
      console.log(`  Added ${domains.length} domains`);
    } catch (error) {
      console.error(`  Error fetching ${source}:`, error.message);
    }
  }
  
  const sortedDomains = Array.from(allDomains).sort();
  
  const output = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString().split('T')[0],
    sources: SOURCES,
    domains: sortedDomains
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  
  console.log(`\nSuccess! Updated ${sortedDomains.length} domains in ${OUTPUT_FILE}`);
  console.log('Commit this file to version control.');
}

updateDomains().catch(console.error);
