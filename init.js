const MongoClient = require('mongodb').MongoClient;
const dbName = 'jsrs';
const url = 'mongodb://localhost:27017';
const assert = require('assert');
const log = require('./log-interface');

// const baseline = ['radical', 'kanji', 'vocab', 'user'];
const baseline = ['hsk', 'sc', 'tocfl', 'tc'];

let db;
MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  db = mongoclient.db(dbName);
  db.listCollections().toArray(async function(err, collections) {
    const C = collections.map(co => co.name);
    for(let i = 0; i < baseline.length; i ++){
      const c = baseline[i];
      if(C.includes(c)){
        if(format)
        log.warn(`[ ${c} ] already exists - now deleting it.`);
        await db.dropCollection(c);
      }
      db.createCollection(c, function(){
        log.pass(`created [ ${c} ]`)
      })
    }
  });
});
