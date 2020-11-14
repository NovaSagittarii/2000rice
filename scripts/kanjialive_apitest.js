const axios = require('axios');
const log = require('../log-interface');

(async function(){
  const dat = await axios.get(encodeURI("https://app.kanjialive.com/api/kanji/上"));
  console.log(dat.data);
})();
