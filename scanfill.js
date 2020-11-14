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
