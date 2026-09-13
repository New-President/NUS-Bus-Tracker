import { readFileSync, copyFileSync } from 'fs';

// Temporarily swap app.js with app_test.js and run test_frontend
copyFileSync('public/app.js', 'scratch/app_backup.js');
copyFileSync('scratch/app_test.js', 'public/app.js');
console.log('Swapped app.js, now ready to run node tests/test_frontend.js');

