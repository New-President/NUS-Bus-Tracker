import { readFileSync } from 'fs';
import { testHtmlContract } from '../tests/test_html_contract.js';

// Test with test_html_contract
const html = readFileSync('public/index.html', 'utf8');
const app = readFileSync('scratch/app_test.js', 'utf8');

import vm from 'node:vm';
new vm.Script(app, { filename: 'public/app.js' });
console.log('Passed VM script test!');

