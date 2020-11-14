const log = require('./log-interface');
const assert = require('assert');
const fs = require("fs");
const MongoClient = require('mongodb').MongoClient;
const dbName = 'jsrs';
const url = 'mongodb://localhost:27017';

// const hsk = JSON.parse(fs.readFileSync("./data/hsk_data.json", 'utf8'));

const kxr = JSON.parse(fs.readFileSync("./data/kangxiradicals.json", 'utf8'));
const radicals = {};

MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  log.info("Note: the DB collection 'sc' (simplified characters/HSK) should be at least partially cached already");
  db = mongoclient.db(dbName);
  populate();
});

async function populate(){
  for(let lv = 1; lv <= 200; lv ++){
    const chars = await db.collection('sc').findOne({_id: 'lv'+lv});
    if(chars === null) throw `Missing LVCONTENT sc lv${lv}`;
    log.info(`LV${lv}`);
    // console.log(chars);
    const rlv = [];
    for(let i = 0; i < chars.content.length; i ++){
      const char = chars.content[i];
      const radical = (await db.collection('sc').findOne({_id: char})).ra;
      if(radical === undefined){
        log.error(`Missing radical information for ${char}`);
        continue;
      }
      if(kxr[radical[0]] === undefined){
        log.error(`Nonexistant radical ${radical} from ${char}`);
        continue;
      }
      // console.log(radical[0]);
      if(!radicals[kxr[radical[0]].id]){
        radicals[kxr[radical[0]].id] = 1;
        rlv.push(radical[0]);
      }
    }
    for(let j = 0; j < rlv.length; j ++){
      const radical = rlv[j];
      if(await db.collection("radical").findOne({_id: radical}) === null){
        if(!kxr[radical]) throw `Missing information for radical ${radical}`;
        await db.collection("radical").updateOne({_id: radical}, {$set: {
          meaning: kxr[radical].meaning,
          mnemonic: "**`INCOMPLETE`** You can probably find something at wiktionary under the etymology"
        }}, {upsert: true});
        log.pass(`Added minimal information for ${radical} using HSK`);
      }
    }

    // uses "scn" instead of "content" to indicate that it is the "Simplified ChiNese" ones. *probably should replace the jp ones with just jp
    db.collection("radical").updateOne({_id: `lv${lv}`}, {$set: {scn: rlv.sort()}}, {upsert: true}).then(() => log.pass(`Cached R${lv}`)).catch(err => log.error(err));
    console.log(rlv, Object.keys(radicals).length);
  }
}
