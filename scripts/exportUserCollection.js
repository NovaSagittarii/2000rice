require('dotenv').config();

const log = require('../log-interface');
const fs = require("fs");
const assert = require('assert');
const MongoClient = require('mongodb').MongoClient;

let db;
const json = {};
MongoClient.connect(process.env.DB_LINK, { useNewUrlParser: true, useUnifiedTopology: true }, async function(err, mongoclient) {
  assert.equal(null, err);
  log.pass("Connected successfully to server");
  db = mongoclient.db(process.env.DB_NAME);
  /*db.collection('user').find().each(async (err, usr) => {
    assert.equal(null, err);
    if(usr === null) return;
    console.log(usr.lessons);
    // const temp = usr.lessons;
    // usr.lessons = {};
    // await db.collection('user').updateOne({_id: usr._id}, {$set: usr});
    // console.log("OK");
    // console.log(usr.lessons);
    json[usr._id] = usr;
  });
  console.log(json);*/
  db.collection('sc').find().each(async (err, char) => {
    if(char === null) return;
    // console.log(char);
    if(char._id.startsWith("lv")) return;
    if(!char.en) return console.log("No meaning??", char);
    if(char.en.includes("classifier for")) console.log(char.en);
  });
});
