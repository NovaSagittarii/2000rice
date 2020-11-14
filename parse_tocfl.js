const readline = require('readline');
const fs = require('fs');
const readInterface = readline.createInterface({
    input: fs.createReadStream('./data/tocfl.csv'),
    // output: process.stdout,
    console: false
});

const mdbg = require('mdbg');

const char = {};

let i = 0, l = 0;
readInterface.on('line', async function(line) {
  const p = JSON.parse('['+line.replace(/[^,]""/g, '\\"')+']');
  if(p[0] === "Word") return;
  // const q = [p[0], p[1], parseInt(p[3]), p[4] + p[5], Object.values((await mdbg.get(p[0])).definitions).map(d => d.translations)];
  // console.log(p[0], p[3]);
  if(parseInt(p[3]) > l){
    console.log(l, Object.keys(char).length);
    l = parseInt(p[3]);
  }
  p[0].split('').forEach(c => char[c] = 1);
  // if(i++ > 3) process.exit(0);
});
readInterface.on('close', function(){
  console.log(l, Object.keys(char).length);
});
