const axios = require('axios');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const log = require('./log-interface');
const assert = require('assert');
const fs = require("fs");
const MongoClient = require('mongodb').MongoClient;
const dbName = 'jsrs';
const url = 'mongodb://localhost:27017';

const kxr = JSON.parse(fs.readFileSync("./data/kangxiradicals.json", 'utf8'));
const stages = ["pleasant", "painful", "death", "hell", "paradise", "reality"];

const LIMITER = 38;

let db;
MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  db = mongoclient.db(dbName);
  parse();
});

async function parse(){
  for(let s = 0; s < stages.length; s ++){
    if(s*10 > LIMITER) break;
    {
      log.info(`Parsing radicals/${stages[s]}...`);
      const dom = await JSDOM.fromURL(`https://www.wanikani.com/radicals?difficulty=${stages[s]}`);
      const lvls = Array.from(dom.window.document.getElementsByTagName("section")).filter(htmlObj => htmlObj.id);
      for(let l = 0; l < lvls.length; l ++){
        const lv = lvls[l];
        const level = lv.id.replace("level-", "");
        const rads = Array.from(lv.getElementsByTagName("ul")).map(ul => {return {char: ul.parentNode.getElementsByClassName("character")[0].innerHTML.replace(/[\n ]/g, ''), wk: ul.children[1].innerHTML.toLowerCase().replace(/ /g, '-')}}).splice(1);
        log.info(`Found radicals/${stages[s]}/${lv.id}\n${rads.map(r => r.wk).join(', ')}`);
        const radicalsInLevel = [];
        for(let r = 0; r < rads.length; r ++){
          const rad = rads[r];
          if(!kxr[rad.char]){
            log.warn(`Skipping [ ${rad.wk} ] since it is not KXR`);
            continue;
          }
          radicalsInLevel.push(rad.char);
          /* if(true){
            log.pass(`https://en.wiktionary.org/wiki/${rad.char}`);
            continue;
          } */
          /* if(await db.collection("radical").findOne({_id: rad.char}) !== null){
            log.info(`Skipping [ ${rad.char} | ${kxr[rad.char].meaning} | ${rad.char.charCodeAt(0)} ] since it is already cached.`);
            continue;
          } */
          if(true){
            try {
              const wikt = await JSDOM.fromURL(`https://en.wiktionary.org/wiki/${rad.char}`);
              const pictograph = wikt.window.document.body.innerHTML.substr(wikt.window.document.body.innerHTML.indexOf("Pictogram")).split('<h3>')[0].split(/[:–] /)[1].replace(/<[^>]*p>/g, "").replace(/<[^>]*>/g, "**").replace(/(\*\*)./g, "*").trim().replace(/\n/g, " ").replace(" For more images, please refer to this link", "");
              log[pictograph.length ? "pass" : "warn"](`https://en.wiktionary.org/wiki/${rad.char} ~ ${pictograph}`);
            }catch(err){
              log.error(`https://en.wiktionary.org/wiki/${rad.char} ~ CANNOT PARSE`);
            }
              continue;
          }

          if(kxr[rad.char].meaning != rad.wk){
            log.warn(`Meaning mismatch: [wk:${rad.wk}] [kxr:${kxr[rad.char].meaning}]`);
          }
          const dom = await JSDOM.fromURL(`https://www.wanikani.com/radicals/${rad.wk}`);
          // log.info(kxr[rad.char].meaning);

          if(dom.window.document.getElementsByClassName("mnemonic-content")[0] == undefined)
            throw `NULL MNEMONIC-CONTENT\nURL: https://www.wanikani.com/radicals/${rad.wk}`;

          const wk_mnemonic = dom.window.document.getElementsByClassName("mnemonic-content")[0].children[0].innerHTML.replace(/<[^>]*>/g, "**");

          db.collection("radical").updateOne({_id: rad.char}, {$set: {
            meaning: kxr[rad.char].meaning.toLowerCase(),
            mnemonic: wk_mnemonic
          }}, {upsert: true}).then(() => log.info(`Added [ ${rad.char} / ${kxr[rad.char].meaning} ]`)).catch(err => log.error(err));
        }
        log.pass(radicalsInLevel.join(' '));
        db.collection("radical").updateOne({_id: `lv${level}`}, {$set: {content: radicalsInLevel.map(r => r)}}, {upsert: true}).then(() => log.pass(`Cached R${level}`)).catch(err => log.error(err));
        if(level > LIMITER) break;
      }
    }
    {
      log.info(`Parsing kanji/${stages[s]}...`);
      const dom = await JSDOM.fromURL(`https://www.wanikani.com/kanji?difficulty=${stages[s]}`);
      const lvls = Array.from(dom.window.document.getElementsByTagName("section")).filter(htmlObj => htmlObj.id);
      for(let l = 0; l < lvls.length; l ++){
        const lv = lvls[l];
        const level = lv.id.replace("level-", "");
        const kanjis = Array.from(lv.getElementsByTagName("ul")).map(ul => {return {char: ul.parentNode.getElementsByClassName("character")[0].innerHTML.replace(/[\n ]/g, ''), wk: ul.children[1].innerHTML.toLowerCase().replace(/ /g, '-')}}).splice(1);
        log.info(`Found kanji/${stages[s]}/${lv.id}\n${kanjis.map(r => r.wk).join(', ')}`);
        for(let k = 0; k < kanjis.length; k ++){
          const ka = kanjis[k];
          /*if(true){
            log.pass(`https://en.wiktionary.org/wiki/${ka.char}`);
            continue;
          }*/
          if(await db.collection("kanji").findOne({_id: ka.char}) !== null){
            log.info(`Skipping [ ${ka.char} ] since it is already cached.`);
            continue;
          }
          try {
            /* const dom = await JSDOM.fromURL(`https://app.kanjialive.com/${ka.char}`);
            const meaning = dom.window.document.getElementsByClassName("meaning")[1].innerHTML;
            const ka_hint = dom.window.document.getElementsByClassName("hint")[1].innerHTML;
            const onyomi = dom.window.document.getElementsByClassName("onyomi")[1].innerHTML;
            const kunyomi = dom.window.document.getElementsByClassName("kunyomi")[1].innerHTML; */
            const req = await axios.get(encodeURI(`https://app.kanjialive.com/api/kanji/${ka.char}`));
            if(req.status !== 200) throw `[${req.status}] @ ${`https://app.kanjialive.com/api/kanji/${ka.char}`} ]] status aint OK m8`;
            let meaning, mnemonic, onyomi, kunyomi, examples;
            const tangorin = await JSDOM.fromURL(`https://tangorin.com/kanji/${ka.char}`);
            if(req.data.Error === undefined){
              meaning = req.data.meaning.replace(/, /g, ",");
              mnemonic = req.data.hint;
              onyomi = req.data.onyomi_ja.replace(/、/g, ",");
              kunyomi = req.data.kunyomi_ja.replace(/、/g, ",");
              examples = req.data.examples.map(o => `${o.japanese}|${o.english}`)
            }else{
              meaning = tangorin.window.document.getElementsByClassName("k-meanings")[0].innerHTML.replace(/; /g, ",");
              mnemonic = "n/a";
              onyomi = [];
              kunyomi = [];
              Array.from(tangorin.window.document.getElementsByClassName("k-readings")[0].getElementsByTagName("ruby")).map(ruby => ruby.innerHTML.replace(/[^~\u3040-\u30ff]/g, "")).filter(s => s.length).forEach(kana => {
                if(kana.indexOf(/\u3040-\u309f/) !== -1) onyomi.push(kana);
                else kunyomi.push(kana);
              });
              onyomi = onyomi.join(',') || "n/a";
              kunyomi = kunyomi.join(',') || "n/a";
              examples = Array.from(tangorin.window.document.getElementsByClassName("k-ex")[0].children[0].children).map(div => `${div.getElementsByTagName("a")[0].innerHTML}（${div.getElementsByTagName("ruby")[0].innerHTML.replace(/[^~\u3040-\u30ff]/g, "")}）|${div.getElementsByTagName("dd")[0].innerHTML}`) || "n/a";
            }
            const radical = (function(){
              try {
                return tangorin.window.document.getElementsByClassName("k-info")[0].getElementsByTagName("span")[0].innerHTML;
              } catch {
                return "n/a"
              }
            })();

            db.collection("kanji").updateOne({_id: ka.char}, {$set: {
              meaning: meaning,
              mnemonic: mnemonic,
              onyomi: onyomi,
              kunyomi: kunyomi,
              radical: radical,
              examples: examples
            }}, {upsert: true}).then(() => log.info(`Added [ ${ka.char} / ${meaning} ]`)).catch(err => log.error(err));
          } catch(err) {
            log.error(`https://app.kanjialive.com/api/kanji/${ka.char}`);
            log.error(`https://www.mdbg.net/chinese/dictionary?page=chardict&cdcanoce=0&cdqchi=${ka.char}`);
            throw err;
          }
        }
        db.collection("kanji").updateOne({_id: `lv${level}`}, {$set: {content: kanjis.map(s => s.char)}}, {upsert: true}).then(() => log.pass(`Cached K${level}`)).catch(err => log.error(err));
        if(level > LIMITER) break;
      }
    }
    {
      log.info(`Parsing vocabulary/${stages[s]}...`);
      const dom = await JSDOM.fromURL(`https://www.wanikani.com/vocabulary?difficulty=${stages[s]}`);
      const lvls = Array.from(dom.window.document.getElementsByTagName("section")).filter(htmlObj => htmlObj.id);
      for(let l = 0; l < lvls.length; l ++){
        const lv = lvls[l];
        const level = lv.id.replace("level-", "");
        const phrases = Array.from(lv.getElementsByTagName("ul")).map(ul => {return {char: ul.parentNode.getElementsByClassName("character")[0].innerHTML.replace(/[\n ]/g, ''), wk: ul.children[1].innerHTML.toLowerCase().replace(/ /g, '-')}}).splice(1);
        log.info(`Found vocabulary/${stages[s]}/${lv.id}\n${phrases.map(r => r.wk).join(', ')}`);
        for(let i = 0; i < phrases.length; i ++){
          const p = phrases[i];
          if(await db.collection("vocab").findOne({_id: p.char}) !== null){
            log.info(`Skipping [ ${p.char} ] since it is already cached.`);
            continue;
          }
          try {
            const req = await JSDOM.fromURL(`https://www.wanikani.com/vocabulary/${p.char}`);
            db.collection("vocab").updateOne({_id: p.char}, {$set: {
              lexicalClass: req.window.document.getElementsByClassName('part-of-speech')[0].getElementsByTagName("p")[0].innerHTML.toLowerCase(),
              meaning: [req.window.document.getElementsByTagName("h1")[1].innerHTML.split('</span>')[1].trim().toLowerCase()].concat(...(function(){const alt = req.window.document.getElementsByClassName('alternative-meaning'); return alt[1] ? alt[0].getElementsByTagName("p")[0].innerHTML.toLowerCase().split(', ') : []})()).join(','),
              reading: req.window.document.getElementsByClassName("pronunciation-variant")[0].innerHTML,
              recording: (function(){try{return Array.from(req.window.document.getElementsByTagName("audio")[0].getElementsByTagName("source")).map(src => src.src).join(",")}catch(err){log.error(`Missing audio? @ https://www.wanikani.com/vocabulary/${p.char}`); return null}})(),
              context: Array.from(req.window.document.getElementsByClassName("context-sentence-group")).map(csg => `${csg.children[0].innerHTML}|${csg.children[1].innerHTML}`),
              meaningExplanation: req.window.document.getElementsByClassName("mnemonic-content")[0].children[0].innerHTML.replace(/<[^>]*>/g, "**"),
              readingExplanation: req.window.document.getElementsByClassName("mnemonic-content")[1].children[0].innerHTML.replace(/<[^>]*>/g, "**")
            }}, {upsert: true}).then(() => log.info(`Added [ ${p.char} ]`)).catch(err => log.error(err));
          } catch(err) {
            log.error(`https://www.wanikani.com/vocabulary/${p.char}`);
            throw err;
          }
        }
        db.collection("vocab").updateOne({_id: `lv${level}`}, {$set: {content: phrases.map(s => s.char)}}, {upsert: true}).then(() => log.pass(`Cached V${level}`)).catch(err => log.error(err));
        if(level > LIMITER) break;
      }
    }
  }
}
