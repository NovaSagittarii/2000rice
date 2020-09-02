const axios = require('axios');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const log = require('./log-interface');
const assert = require('assert');
const fs = require("fs");
const MongoClient = require('mongodb').MongoClient;
const dbName = 'jsrs';
const url = 'mongodb://localhost:27017';

const pyc = require('pinyin-convert');
const mdbg = require('mdbg');

const hsk = JSON.parse(fs.readFileSync("./data/hsk_data.json", 'utf8'));

MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  db = mongoclient.db(dbName);
  parse();
});

let lv = 1;
async function parse(){
  for(let i = 1; i <= 6; i ++){
    const groups = {};
    // const vocablocation = {}; // pointer for vocab to the group they are in (instead of having to search all groups)

    const chars = {};
    const hsklv = hsk[`level${i}`];
    const lvalloc = hsklv.vocabulary.length/25; // allocated levels
    hsklv.characters.forEach(c => chars[c] = 1); // set up map to see if a character is in the HSK Lv
    console.log('hsk'+i, hsklv.characters.length, hsklv.vocabulary.length);
    log.info(`vocab lvls ${lvalloc} (25 ea), char per lvl${hsklv.characters.length / lvalloc}`);
    hsklv.vocabulary.forEach(v => {
      for(let j = 0; j < v.length; j ++){
        if(!groups[v[j]]) groups[v[j]] = [];
        groups[v[j]].push(v);
        // vocablocation[v] = v[j];
      }
    });
    hsklv.vocabulary.filter(v => v.length > 1).forEach(v => {
      v.split('').sort((a,b) => groups[b].length-groups[a].length).forEach((a,i) => {
        if(i === 0) return; // console.log(`${v} goes to ${a}`);
        groups[a].splice(groups[a].indexOf(v), 1);
        // vocablocation[v] = a;
        if(groups[a].length === 0){
          // console.log(`${a} group has no more members`);
          delete groups[a];
        }
      });
    });
    const vocabgroups = [];
    Object.keys(groups).forEach(k => {
      if(!chars[k]) vocabgroups.push(groups[k]);
    });
    for(let i = 0; i < vocabgroups.length; i ++){
      // break up any really large groups (>25)
      if(vocabgroups[i].length <= 25) continue;
      console.log("split", vocabgroups[i]);
      vocabgroups.push(vocabgroups[i].splice(0, 25));
      // this works since there are only two groups that exceed 25 (in HSK6), but there are also two levels that happen to be completely empty as well. [those two groups do not exceed 50 so it all works out]
    }
    vocabgroups.sort((a,b) => b.length-a.length); // [];
    /* Object.keys(groups).forEach(k => {
      if(chars[k]) return; // do not add to grouping system as it will be associated with the character already
      vocabgroups.push({
        key: k,
        value: groups[k]
      })
    });
    vocabgroups.sort((a,b) => b.value.length-a.value.length); */
    /*console.log(vocab.filter(v => v.value.length > 1)); */
    // log.info(vocabgroups.length + " not-matched-to-character vocab groups");

    const charlvls = [...new Array(lvalloc)].map(a => []);
    for(let i = 0; i < hsklv.characters.length; i ++) charlvls[Math.floor(i/hsklv.characters.length*lvalloc)].push(hsklv.characters[i]);

    const vocablvls = [... new Array(lvalloc)].map(a => []);
    for(let i = 0; i < lvalloc; i ++){ // allocating vocabulary that share characters in same level
      const valloc = vocablvls[i];
      for(let j = 0; j < charlvls[i].length; j ++){
        const char = charlvls[i][j];
        if(groups[char]){
          // console.log("relevant", char, groups[char]);
          groups[char].forEach(v => {
            if(vocablvls[i].length+1 > 25){
              // log.warn(`oh no chief, VO Lv${i} is kinda too big to fit ${v} (exceeds 25) (curr: ${vocablvls[i].length})`);
              // seek a level with empty space to place the vocab into them
              for(let k = 1; k < lvalloc; k ++){
                const l = (i-k+lvalloc)%lvalloc;
                if(vocablvls[l].length+1 > 25) continue;
                // log.pass(`inserting ${v} into VO Lv${l}`);
                vocablvls[l].push(v);
                break;
              }
            }else vocablvls[i].push(v);

            // seek vocabgroup to remove the vocabulary from (it is already added), but should not be a problem because we do not add vocabs that have a character in them to the vocabgroups
            /* for(let i = 0; i < vocabgroups.length; i ++){
              if(vocabgroups[i].key === vocablocation[v]){
                console.log(`Removing ${v} from group ${vocabgroups[i].key}`);
                vocabgroups[i].value.splice(vocabgroups[i].value.indexOf(v));
                break;
              }
            } */
          });
        }
      }
    }

    // console.log(vocablvls.map(v => v.length).sort((a,b)=>a-b));
    // console.log(vocabgroups.filter(v => v.length>=25));
    console.log("================= HSK", i);
    for(let i = 0; i < vocabgroups.length; i ++){
      let failed = true;
      for(let j = 0; j < lvalloc; j ++){
        if(vocablvls[j].length + vocabgroups[i].length > 25) continue;
        vocablvls[j].push(...vocabgroups[i]);
        failed = false;
        break;
      }
      if(failed) throw `cant find something to fit ${vocabgroups[i].join('|')} into`;
    }

     // console.log(vocabgroups.length, vocabgroups);

     console.log(charlvls.map(c => c.join('')).join('\n') + "\n==============================");
     console.log(vocablvls.map(v => v.map(k => k.padStart(4, '\u3000')).join('\u3001')).join('\n\n'));

    for(let i = 0; i < lvalloc; i ++){
      log.info("LV"+lv);
      for(let j = 0; j < charlvls[i].length; j ++){
        const char = charlvls[i][j];
        const lookup = await db.collection("sc").findOne({_id: char});
        if(lookup !== null && lookup.ra){
          log.info(`Skipping [ ${char} ] since it is already cached.`);
          continue;
        }
        const dom = await JSDOM.fromURL(`https://www.purpleculture.net/dictionary-details/?word=${char}`);
        const req = await axios.get(encodeURI(`https://www.purpleculture.net/wordjson.php?word=${char}`));
        if(req.status !== 200) throw `[${req.status}] @ ${`https://www.purpleculture.net/wordjson.php?word=${char}`} ]] status aint OK m8`;
        /*
          co ~ components / character formation
          ex ~ examples
          py ~ pinyin
          en ~ english meaning
          ra ~ radical
        */
        // console.log(char);
        const data = {
          ex: Array.from(dom.window.document.getElementsByClassName("swordlist")).filter(div => div.innerHTML.includes("[")).map(div => `${div.textContent.split(' [')[0]}\u3010${div.textContent.substring(div.textContent.indexOf("[")+2, div.textContent.indexOf("]")-1)}\u3011|${div.textContent.split(']: ')[1]}`),
          py: [await pyc(req.data.spy.toLowerCase())], // default: use from purpleculture (however get from cojak if possible)
          en: req.data.en.replace(/&apos;/g, "'").replace(/<[/]?a[^>]*>/g, "**"),
        };
        try {
          data.co = Array.from(dom.window.document.getElementsByClassName("tree")[0].getElementsByTagName("li")).splice(1).filter(li => li.getElementsByClassName("str_def")[0].innerHTML.length > 2).map(li => {
            const a = li.getElementsByTagName("a");
            return a[0].innerHTML + (a[1] ? `\u3010${a[1].innerHTML}\u3011` : "") + li.getElementsByClassName("str_desc")[0].innerHTML;
          });
        } catch (e) { log.warn(`No components for ${char}`); }
        try {
          const dom = await JSDOM.fromURL(`http://www.cojak.org/index.php?function=code_lookup&term=${char.charCodeAt(0).toString(16).toUpperCase()}`);
          const a = dom.window.document.getElementsByClassName("radical")[1].getElementsByTagName("a")[0];
          data.ra = `${a.innerHTML} ${a.title.toLowerCase()}`;
          data.py = Array.from(dom.window.document.getElementsByClassName("reading")[0].parentNode.getElementsByTagName("td")[0].getElementsByTagName("a")).map(a => a.innerHTML);
        } catch (e) { log.warn(`Failed to get radical from ${`http://www.cojak.org/index.php?function=code_lookup&term=${char.charCodeAt(0).toString(16).toUpperCase()}`}`); console.log(e); }
        // console.log(data);
        await db.collection("sc").updateOne({_id: char}, {$set: data}, {upsert: true});
        log.pass(`New entry for ${char}`);
        /*const char = await mdbg.get(charlvls[i][j]);
        if(char.simplified !== charlvls[i][j]) throw `??! simplified mismatch ${char.simplified} ${charlvls[i][j]}`;
        db.collection("sc").updateOne({_id: char.simplified}, {$set: {
          en: Object.values(char.definitions).map(s => s.translations).reduce((a,c) => a.concat(...c)),
          py: Object.keys(char.definitions).map(s => s.toLowerCase())
        }}, {upsert: true});*/

      }
      await db.collection("sc").updateOne({_id: "lv"+lv}, {$set: {content: charlvls[i]}}, {upsert: true});


      for(let j = 0; j < vocablvls[i].length; j ++){
        const char = vocablvls[i][j];
        if(await db.collection("hsk").findOne({_id: char}) !== null){
          log.info(`Skipping [ ${char} ] since it is already cached.`);
          continue;
        }
        console.log(char);
        let dom, req;
        try {
          dom = await JSDOM.fromURL(`https://hsk.academy/en/words/${char}`);
        }catch(err){
          try {
            log.warn(`/words/ failed - using fallback /characters/`)
            dom = await JSDOM.fromURL(`https://hsk.academy/en/characters/${char}`);
          }catch(err){
            log.warn(`/characters/ failed - using fallback purpleculture`);
            req = await axios.get(encodeURI(`https://www.purpleculture.net/wordjson.php?word=${char}`));
          }
        }
        const data = dom ? {
          en: Array.from(dom.window.document.getElementsByClassName("content")[0].getElementsByTagName("li")).map(li => li.innerHTML).join("; "),
          py: dom.window.document.getElementsByClassName("is-inline")[0].innerHTML
        } : {
          py: await pyc(req.data.spy.toLowerCase()),
          en: req.data.en.replace(/&apos;/g, "'").replace(/<[/]?a[^>]*>/g, "**"),
        };
        try {
          const dom = await JSDOM.fromURL(`https://www.purpleculture.net/sample-sentences/?word=${char}`);
          data.ex = Array.from(dom.window.document.getElementById("ex_sen").getElementsByTagName("li")).splice(0, 4).map(li => {
            let c = "", py = "";
            Array.from(li.getElementsByClassName("singlebk")).forEach(k => {
              c += k.getElementsByTagName("span")[0].innerHTML;
              py += " " + Array.from(k.getElementsByTagName("a")).map(a => a.innerHTML).join(' ');
            });
            return `${c}\u3010${py.trim()}\u3011|${li.getElementsByClassName("sample_en")[0].innerHTML}`;
          });
        } catch (err) { console.log(err); log.error(`Cannot get EXSEN from ${`https://www.purpleculture.net/sample-sentences/?word=${char}`}`); }
        // console.log(data);
        await db.collection("hsk").updateOne({_id: char}, {$set: data}, {upsert: true});
        log.pass(`New entry for ${char}`);
      }
      await db.collection("hsk").updateOne({_id: "lv"+lv}, {$set: {content: vocablvls[i]}}, {upsert: true});

      lv ++;
    }
    // break;
  }
}
